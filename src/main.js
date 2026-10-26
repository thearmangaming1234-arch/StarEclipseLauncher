const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Readable } = require('stream');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Client } = require('minecraft-launcher-core');
const extractZip = require('extract-zip');
const yauzl = require('yauzl');

const isDev = !app.isPackaged;
// During development, read the instances folder sitting next to src/.
// In a packaged launcher, userData is used so the installed app can write to it.
const instancesDir = isDev
  ? path.join(__dirname, '..', 'instances')
  : path.join(app.getPath('userData'), 'instances');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const fileVerificationCacheFile = path.join(app.getPath('userData'), 'file-verification-cache.json');
const MINECRAFT_RSS_FEEDS = [
  { url: 'https://www.minecraft.net/en-us/feeds/community-content/rss', source: 'Minecraft.net' }
];
const NEWS_CACHE_MS = 10 * 60 * 1000;
const SKIN_URL_CACHE_MS = 15 * 60 * 1000;
let cachedMinecraftNews = null;
let cachedMinecraftNewsAt = 0;
let minecraftNewsRequest = null;
const skinUrlCache = new Map();
const INSTANCE_RELEASES = {
  '1.20.1-PVP': {
    url: 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/PVPInstance/1.20.1-PVP.zip',
    launchProfile: 'fabric-loader-0.19.3-1.20.1',
    fabricLoader: '0.19.3',
    version: '1.20.1'
  },
  '26.2-Survival': {
    url: 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/Instance/26.2.Survival.zip',
    launchProfile: 'fabric-loader-0.19.5-26.2',
    fabricLoader: '0.19.5',
    version: '26.2'
  }
};
const activeInstanceInstalls = new Set();
const activeModInstalls = new Set();
const activeInstanceLaunches = new Map();
const pendingInstanceLaunches = new Set();
const MOJANG_RUNTIME_MANIFEST = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
let fileVerificationCache = null;
let fileVerificationCacheSaveTimer = null;

function runtimePlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'windows-arm64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-os-arm64';
  if (process.platform === 'darwin') return 'mac-os';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux';
  throw new Error(`Automatic Java setup is not available for ${process.platform} ${process.arch}.`);
}

function runtimeDirectory(component, version) {
  return path.join(app.getPath('userData'), 'runtime', component, runtimePlatform(), version);
}

function runtimeJavaPath(component, version) {
  const runtimeRoot = runtimeDirectory(component, version);
  if (process.platform === 'darwin') return path.join(runtimeRoot, 'Contents', 'Home', 'bin', 'java');
  return path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
}

function runtimeJavaProbePath(component, version) {
  if (process.platform !== 'win32') return runtimeJavaPath(component, version);
  return path.join(runtimeDirectory(component, version), 'bin', 'java.exe');
}

function hasSafeRuntimeMetadata(component, version) {
  return typeof component === 'string' && /^java-runtime-[a-z-]+$/.test(component) &&
    typeof version === 'string' && /^[a-zA-Z0-9._-]+$/.test(version);
}

function hasModJar(folder) {
  const modsPath = path.join(folder, 'mods');
  if (!fs.existsSync(modsPath) || !fs.statSync(modsPath).isDirectory()) return false;
  const scan = (directory, depth = 0) => {
    if (depth > 3) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.toLowerCase().endsWith('.jar') || entry.name.toLowerCase().endsWith('.jar.disabled'))) return true;
      if (entry.isDirectory() && scan(path.join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return scan(modsPath);
}

function hasContentFile(folder) {
  const scan = (directory, depth = 0) => {
    if (depth > 4) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && scan(path.join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return fs.existsSync(folder) && fs.statSync(folder).isDirectory() && scan(folder);
}

function isInstanceInstalled(folder, metadata = {}) {
  const release = INSTANCE_RELEASES[folder];
  if (!release) return false;
  const instancePath = path.join(instancesDir, folder);
  const marker = path.join(instancePath, 'downloaded.txt');
  const mods = path.join(instancePath, 'mods');
  const config = path.join(instancePath, 'config');
  const fabricProfile = path.join(instancePath, 'versions', release.launchProfile, `${release.launchProfile}.json`);
  const runtimeComponent = metadata.runtimeComponent || (release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma');
  const runtimeVersion = metadata.runtimeVersion || (release.version === '26.2' ? '25.0.1' : '17.0.15');
  if (!hasSafeRuntimeMetadata(runtimeComponent, runtimeVersion)) return false;
  const java = runtimeJavaPath(runtimeComponent, runtimeVersion);
  const probeJava = runtimeJavaProbePath(runtimeComponent, runtimeVersion);
  let profile;
  try { profile = JSON.parse(fs.readFileSync(fabricProfile, 'utf8')); } catch { return false; }
  let runtimeStamp;
  try { runtimeStamp = JSON.parse(fs.readFileSync(path.join(runtimeDirectory(runtimeComponent, runtimeVersion), '.eclipse-runtime-ready.json'), 'utf8')); } catch { return false; }
  if (!Array.isArray(runtimeStamp.files) || runtimeStamp.files.length === 0 || !runtimeStamp.files.every(file => {
    if (!file || typeof file.path !== 'string' || !Number.isFinite(file.size)) return false;
    const runtimeFile = path.resolve(runtimeDirectory(runtimeComponent, runtimeVersion), file.path.replace(/[\\/]/g, path.sep));
    if (!runtimeFile.startsWith(`${path.resolve(runtimeDirectory(runtimeComponent, runtimeVersion))}${path.sep}`)) return false;
    try { return fs.statSync(runtimeFile).isFile() && fs.statSync(runtimeFile).size === file.size; } catch { return false; }
  })) return false;
  return fs.existsSync(marker) && fs.statSync(marker).isFile() && fs.existsSync(mods) && fs.statSync(mods).isDirectory() && hasModJar(instancePath) &&
    hasContentFile(config) && fs.existsSync(java) && fs.existsSync(probeJava) &&
    profile.id === release.launchProfile && profile.inheritsFrom === release.version &&
    runtimeStamp.component === runtimeComponent && runtimeStamp.version === runtimeVersion &&
    (metadata.loader || 'Fabric').toLowerCase() === 'fabric' && String(metadata.version || release.version) === release.version;
}

function sendInstallProgress(event, folder, progress) {
  if (!event.sender.isDestroyed()) event.sender.send('instance:install-progress', { folder, ...progress });
}

function sendLaunchStatus(event, folder, status) {
  if (!event.sender.isDestroyed()) event.sender.send('instance:launch-status', { folder, ...status });
}

function getFileVerificationCache() {
  if (fileVerificationCache) return fileVerificationCache;
  fileVerificationCache = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(fileVerificationCacheFile, 'utf8'));
    for (const [key, value] of Object.entries(stored)) {
      if (value && Number.isFinite(value.size) && Number.isFinite(value.mtimeMs) && Number.isFinite(value.ctimeMs)) fileVerificationCache.set(key, value);
    }
  } catch {}
  return fileVerificationCache;
}

function saveFileVerificationCacheSoon() {
  clearTimeout(fileVerificationCacheSaveTimer);
  fileVerificationCacheSaveTimer = setTimeout(() => {
    try {
      const cache = getFileVerificationCache();
      while (cache.size > 50000) cache.delete(cache.keys().next().value);
      const temporaryPath = `${fileVerificationCacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(cache)));
      fs.renameSync(temporaryPath, fileVerificationCacheFile);
    } catch (error) {
      console.warn('[Minecraft] Could not save the local file verification cache:', error.message);
    }
  }, 800);
  fileVerificationCacheSaveTimer.unref?.();
}

function limitConcurrentWork(limit) {
  let active = 0;
  const waiting = [];
  return work => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        active--;
        waiting.shift()?.();
      });
    };
    if (active < limit) run();
    else waiting.push(run);
  });
}

function optimizeMinecraftFileChecks(handler, instanceRoot) {
  if (!handler || typeof handler.checkSum !== 'function') {
    console.warn('[Minecraft] Launcher checksum optimization is unavailable; continuing with the default file checks.');
    return;
  }
  const cache = getFileVerificationCache();
  const verifyLimited = limitConcurrentWork(4);
  const verifyOriginal = handler.checkSum.bind(handler);
  const libraryRoot = `${path.resolve(instanceRoot, 'libraries')}${path.sep}`;
  handler.checkSum = (hash, file) => {
    // MCLC calls checkSum for library JARs without awaiting or using its result. The files
    // are already existence-checked by MCLC, so hashing them here only adds disk contention.
    if (path.resolve(file).startsWith(libraryRoot)) return true;
    let stat;
    try { stat = fs.statSync(file); } catch { return verifyOriginal(hash, file); }
    const key = `${hash}:${path.resolve(file)}`;
    const cached = cache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return true;
    return verifyLimited(() => verifyOriginal(hash, file)).then(verified => {
      if (verified) {
        cache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
        saveFileVerificationCacheSoon();
      }
      return verified;
    });
  };
}

function configureLauncherHandler(launcher, javaProbePath, instanceRoot) {
  // minecraft-launcher-core creates its Handler inside launch(), immediately before
  // probing Java. Intercept that assignment so both customizations are installed before
  // its first checksum or Java-version check runs.
  let handlerInstance;
  Object.defineProperty(launcher, 'handler', {
    configurable: true,
    get() { return handlerInstance; },
    set(handler) {
      handlerInstance = handler;
      if (typeof handler?.checkJava === 'function') {
        const checkJava = handler.checkJava.bind(handler);
        handler.checkJava = () => checkJava(javaProbePath);
      }
      optimizeMinecraftFileChecks(handler, instanceRoot);
    }
  });
}

function createThrottledLaunchProgress(event, folder) {
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending) sendInstallProgress(event, folder, pending);
    pending = null;
  };
  return (progress, force = false) => {
    pending = progress;
    if (force) {
      clearTimeout(timer);
      flush();
    } else if (!timer) timer = setTimeout(flush, 180);
  };
}

function createLaunchProgressReporter(reportProgress) {
  const phases = [];
  let percent = 5;
  const phaseFor = type => {
    const value = String(type || '').toLowerCase();
    if (value.includes('assets-copy')) return 'assets-copy';
    if (value.startsWith('assets')) return 'assets';
    if (value.startsWith('classes')) return 'classes';
    if (value.includes('native')) return 'natives';
    return 'other';
  };
  const emit = force => reportProgress({
    kind: 'launch', phase: 'dependencies', status: 'Preparing Minecraft', percent: Math.round(percent)
  }, force);
  return {
    report(type, task, total, force = false) {
      const phase = phaseFor(type);
      if (!phases.includes(phase)) phases.push(phase);
      const index = phases.indexOf(phase);
      const ratio = Number.isFinite(task) && Number.isFinite(total) && total > 0
        ? Math.max(0, Math.min(1, task / total))
        : 0;
      // MCLC restarts each phase's counter at zero. Put each phase in its own
      // slice of one overall bar and keep the displayed value monotonic.
      percent = Math.max(percent, Math.min(80, 5 + index * 18 + ratio * 15));
      emit(force);
    },
    advance(target, force = false) {
      percent = Math.max(percent, Math.min(94, target));
      emit(force);
    }
  };
}

function offlinePlayerUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function copyMissingBundledFiles(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyMissingBundledFiles(sourcePath, destinationPath);
    else if (entry.isFile() && !fs.existsSync(destinationPath)) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function updateInstanceMetadata(folder, update) {
  const metadataPath = path.join(instancesDir, folder, 'eclipse-instance.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  update(metadata);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return metadata;
}

function startInstancePlaytime(folder, onUpdate) {
  const startedAt = Date.now();
  let savedThrough = startedAt;
  let totalPlaytimeMs = 0;
  const initial = updateInstanceMetadata(folder, metadata => {
    metadata.playtimeMs = Number.isFinite(metadata.playtimeMs) ? Math.max(0, metadata.playtimeMs) : 0;
    metadata.lastPlayed = startedAt;
  });
  totalPlaytimeMs = initial.playtimeMs;
  const persistElapsed = () => {
    const now = Date.now();
    const elapsed = Math.max(0, now - savedThrough);
    if (!elapsed) return totalPlaytimeMs;
    const updated = updateInstanceMetadata(folder, metadata => {
      metadata.playtimeMs = (Number.isFinite(metadata.playtimeMs) ? Math.max(0, metadata.playtimeMs) : 0) + elapsed;
      metadata.lastPlayed = startedAt;
    });
    savedThrough = now;
    totalPlaytimeMs = updated.playtimeMs;
    onUpdate?.(updated.playtimeMs, startedAt);
    return updated.playtimeMs;
  };
  const timer = setInterval(() => {
    try { persistElapsed(); } catch (error) { console.warn('[Minecraft] Could not save instance playtime:', error.message); }
  }, 60000);
  timer.unref?.();
  return {
    startedAt,
    initialPlaytimeMs: initial.playtimeMs,
    persistElapsed,
    stop() {
      clearInterval(timer);
      try { return persistElapsed(); } catch (error) {
        console.warn('[Minecraft] Could not save final instance playtime:', error.message);
        return totalPlaytimeMs;
      }
    }
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'EclipseLauncher/0.9.0' } });
  if (!response.ok) throw new Error(`Could not retrieve installation metadata (${response.status}): ${url}`);
  return response.json();
}

async function downloadFile(url, destination, onProgress) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'EclipseLauncher/0.9.0' } });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const meter = new (require('stream').Transform)({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      onProgress?.(received, total);
      callback(null, chunk);
    }
  });
  await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination));
  return { received, total };
}

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT = 'thearmangaming1234-arch/StarEclipseLauncher/0.9.0';
const MODRINTH_MAX_JAR_SIZE = 100 * 1024 * 1024;
const MODRINTH_REGISTRY_NAME = '.eclipse-modrinth.json';

function getInstanceModContext(folder, requireInstalled = true) {
  if (typeof folder !== 'string' || path.basename(folder) !== folder || !INSTANCE_RELEASES[folder]) {
    throw new Error('That Minecraft instance could not be found.');
  }
  const instancePath = path.resolve(instancesDir, folder);
  if (path.dirname(instancePath) !== path.resolve(instancesDir)) throw new Error('That Minecraft instance path is invalid.');
  let instanceStat;
  try { instanceStat = fs.lstatSync(instancePath); } catch { throw new Error('That Minecraft instance could not be found.'); }
  if (!instanceStat.isDirectory() || instanceStat.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
  let metadata = {};
  const metadataPath = path.join(instancePath, 'eclipse-instance.json');
  try {
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid.');
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  catch { throw new Error('The instance profile file is missing or invalid.'); }
  const installed = isInstanceInstalled(folder, metadata);
  if (requireInstalled && !installed) throw new Error('This instance is not installed. Install it from Home before managing mods.');
  const modsPath = path.join(instancePath, 'mods');
  if (installed) {
    let stat;
    try { stat = fs.lstatSync(modsPath); } catch { throw new Error('The instance mods folder is missing.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The instance mods folder is invalid.');
  }
  return { folder, instancePath, modsPath, metadata, release: INSTANCE_RELEASES[folder], installed };
}

function listJarFiles(modsPath) {
  if (!fs.existsSync(modsPath)) return [];
  return fs.readdirSync(modsPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.toLowerCase().endsWith('.jar') || entry.name.toLowerCase().endsWith('.jar.disabled')))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function baseJarName(fileName) {
  return fileName.toLowerCase().endsWith('.jar.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName;
}

function ensureBuiltInModRecord(context) {
  let names = listJarFiles(context.modsPath).map(baseJarName);
  if (!Array.isArray(context.metadata.builtInMods)) {
    context.metadata.builtInMods = names;
    fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
  } else {
    const present = new Set(names);
    const updated = context.metadata.builtInMods.filter(name => typeof name === 'string' && present.has(name));
    if (updated.length !== context.metadata.builtInMods.length) {
      context.metadata.builtInMods = updated;
      fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
    }
  }
  return new Set(context.metadata.builtInMods);
}

function readModrinthRegistry(modsPath) {
  try {
    const filePath = path.join(modsPath, MODRINTH_REGISTRY_NAME);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    const registry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return registry && typeof registry === 'object' && !Array.isArray(registry) ? registry : {};
  } catch { return {}; }
}

function writeModrinthRegistry(modsPath, registry) {
  const filePath = path.join(modsPath, MODRINTH_REGISTRY_NAME);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Eclipse mod registry file is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(registry, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally { fs.rmSync(temporaryPath, { force: true }); }
}

function readZipEntryBuffer(zip, entry, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) stream.destroy(new Error('Archive metadata is too large.'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function readModJarMetadata(filePath) {
  return new Promise(resolve => {
    let zipFile = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { zipFile?.close(); } catch {}
      resolve(result);
    };
    // Some third-party archives contain malformed ZIP directories or entries
    // that never finish streaming. Never let one archive hold the whole IPC call.
    const timeout = setTimeout(() => finish(null), 1800);
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (settled) { try { zip?.close(); } catch {} return; }
      if (openError || !zip) return finish(null);
      zipFile = zip;
      const entries = [];
      zip.on('entry', entry => {
        if (settled) return;
        if (!entry.fileName.endsWith('/')) entries.push(entry);
        zip.readEntry();
      });
      zip.once('error', () => finish(null));
      zip.once('end', async () => {
        if (settled) return;
        try {
          const fabricEntry = entries.find(entry => entry.fileName === 'fabric.mod.json');
          const quiltEntry = entries.find(entry => entry.fileName === 'quilt.mod.json');
          const tomlEntry = entries.find(entry => entry.fileName === 'META-INF/mods.toml');
          let data = null;
          if (fabricEntry || quiltEntry) {
            const raw = await readZipEntryBuffer(zip, fabricEntry || quiltEntry);
            data = JSON.parse(raw.toString('utf8'));
          }
          let id = data?.id || data?.quilt_loader?.id || '';
          let name = data?.name || data?.quilt_loader?.metadata?.name || '';
          let version = data?.version || data?.quilt_loader?.version || '';
          let description = data?.description || data?.quilt_loader?.metadata?.description || '';
          let iconPath = data?.icon || data?.quilt_loader?.metadata?.icon || '';
          if (iconPath && typeof iconPath === 'object') iconPath = Object.values(iconPath)[0] || '';
          if (!data && tomlEntry) {
            const toml = (await readZipEntryBuffer(zip, tomlEntry)).toString('utf8');
            id = toml.match(/^modId\s*=\s*["']([^"']+)/m)?.[1] || '';
            name = toml.match(/^displayName\s*=\s*["']([^"']+)/m)?.[1] || '';
            description = toml.match(/^description\s*=\s*["']([^"']+)/m)?.[1] || '';
          }
          let icon = '';
          if (typeof iconPath === 'string' && iconPath.length < 256 && !iconPath.startsWith('/') && !iconPath.split(/[\\/]/).includes('..')) {
            const iconEntry = entries.find(entry => entry.fileName === iconPath.replaceAll('\\', '/'));
            if (iconEntry && /\.(png|jpe?g)$/i.test(iconEntry.fileName)) {
              try {
                // Mod icons are decorative; keep the IPC response small even when a pack
                // contains oversized artwork for every bundled mod.
                const image = await readZipEntryBuffer(zip, iconEntry, 32 * 1024);
                const type = /\.jpe?g$/i.test(iconEntry.fileName) ? 'image/jpeg' : 'image/png';
                icon = `data:${type};base64,${image.toString('base64')}`;
              } catch { /* Keep the mod details and use the initials fallback. */ }
            }
          }
          finish({ id: String(id || ''), name: String(name || ''), version: String(version || ''), description: String(description || ''), icon });
        } catch { finish(null); }
      });
      zip.readEntry();
    });
  });
}

async function mapConcurrent(items, count, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

async function listInstanceMods(folder, allowDuringInstall = false) {
  const context = getInstanceModContext(folder, false);
  if (!context.installed) return { folder, installed: false, version: context.metadata.version || context.release.version, mods: [] };
  if (activeModInstalls.has(folder) && !allowDuringInstall) throw new Error('Wait for this instance’s mod installation to finish before managing its mods.');
  const builtIns = ensureBuiltInModRecord(context);
  const registry = readModrinthRegistry(context.modsPath);
  const fileNames = listJarFiles(context.modsPath);
  let iconBytes = 0;
  const mods = await mapConcurrent(fileNames, 12, async fileName => {
    const filePath = path.join(context.modsPath, fileName);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const baseName = baseJarName(fileName);
      const embedded = await readModJarMetadata(filePath) || {};
      const managed = registry[baseName] || {};
      let icon = embedded.icon || managed.icon || '';
      // A list of dozens of large base64 icons can exceed Chromium's IPC payload
      // budget. Keep just enough for useful thumbnails and fall back to initials.
      const bytes = icon.startsWith('data:') ? Math.ceil(icon.length * 0.75) : 0;
      if (iconBytes + bytes > 1024 * 1024) icon = '';
      else iconBytes += bytes;
      return {
        fileName,
        baseName,
        id: String(embedded.id || managed.modId || '').slice(0, 160),
        name: String(embedded.name || managed.name || baseName.replace(/\.jar$/i, '').replace(/[-_]+/g, ' ')).slice(0, 160),
        version: String(embedded.version || managed.version || '').slice(0, 100),
        description: String(embedded.description || managed.description || 'No description is available for this mod.').slice(0, 800),
        icon: icon.length <= 100_000 ? icon : '',
        builtIn: builtIns.has(baseName),
        enabled: fileName.toLowerCase().endsWith('.jar'),
        modrinthProjectId: managed.projectId || '',
        modrinthSlug: managed.slug || ''
      };
    } catch {
      // One malformed archive or inaccessible file should not prevent the rest of
      // the instance's mods from appearing in the manager.
      return null;
    }
  });
  return { folder, installed: true, version: context.metadata.version || context.release.version, loader: context.metadata.loader || 'Fabric', mods: mods.filter(Boolean) };
}

async function openInstanceModsFolder(folder) {
  const context = getInstanceModContext(folder, false);
  try {
    const stat = fs.lstatSync(context.modsPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The selected mods folder is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(context.modsPath, { recursive: true });
  }
  const error = await shell.openPath(context.modsPath);
  if (error) throw new Error(`Could not open this instance’s mods folder: ${error}`);
  return { opened: true };
}

function assertModFolderIdle(folder) {
  if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
    throw new Error('Close Minecraft and wait for any install or launch to finish before changing mods.');
  }
}

async function setInstanceModEnabled(folder, fileName, enabled) {
  assertModFolderIdle(folder);
  const context = getInstanceModContext(folder);
  const expectedSuffix = enabled ? '.jar.disabled' : '.jar';
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(expectedSuffix)) throw new Error('That mod file could not be found.');
  const source = path.resolve(context.modsPath, fileName);
  if (path.dirname(source) !== path.resolve(context.modsPath)) throw new Error('That mod file path is invalid.');
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That mod file is invalid.');
  const destinationName = enabled ? fileName.slice(0, -'.disabled'.length) : `${fileName}.disabled`;
  const destination = path.join(context.modsPath, destinationName);
  if (fs.existsSync(destination)) throw new Error('A mod with that filename already exists.');
  fs.renameSync(source, destination);
  return listInstanceMods(folder);
}

async function removeInstanceMod(folder, fileName) {
  assertModFolderIdle(folder);
  const context = getInstanceModContext(folder);
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !/\.jar(?:\.disabled)?$/i.test(fileName)) throw new Error('That mod file could not be found.');
  const target = path.resolve(context.modsPath, fileName);
  if (path.dirname(target) !== path.resolve(context.modsPath)) throw new Error('That mod file path is invalid.');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That mod file is invalid.');
  const builtIns = ensureBuiltInModRecord(context);
  fs.unlinkSync(target);
  if (builtIns.has(baseJarName(fileName))) context.metadata.builtInMods = context.metadata.builtInMods.filter(name => name !== baseJarName(fileName));
  fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
  const registry = readModrinthRegistry(context.modsPath);
  delete registry[baseJarName(fileName)];
  writeModrinthRegistry(context.modsPath, registry);
  return listInstanceMods(folder);
}

async function modrinthJson(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.modrinth.com') throw new Error('The Modrinth API URL was invalid.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': MODRINTH_USER_AGENT } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.description || body.error || `Modrinth returned HTTP ${response.status}.`);
    return body;
  } finally { clearTimeout(timeout); }
}

async function searchModrinthMods(query, folder) {
  const context = getInstanceModContext(folder, false);
  const search = String(query || '').trim();
  if (!search) return { folder, installed: context.installed, projects: [] };
  const params = new URLSearchParams({
    query: search,
    facets: JSON.stringify([['project_type:mod'], ['categories:fabric'], [`versions:${context.metadata.version || context.release.version}`]]),
    index: 'relevance',
    limit: '24'
  });
  const body = await modrinthJson(`${MODRINTH_API}/search?${params}`);
  return {
    folder,
    installed: context.installed,
    projects: (body.hits || []).map(project => ({
      id: String(project.project_id || ''),
      slug: String(project.slug || ''),
      title: String(project.title || project.slug || 'Untitled mod'),
      description: String(project.description || ''),
      icon: secureModrinthIcon(project.icon_url),
      downloads: Number(project.downloads) || 0,
      follows: Number(project.follows) || 0,
      versions: Array.isArray(project.versions) ? project.versions : []
    }))
  };
}

function secureModrinthIcon(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com')) ? url.href : '';
  } catch { return ''; }
}

async function findCompatibleModrinthVersion(projectId, context, requestedVersionId = '') {
  if (requestedVersionId) {
    const version = await modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(requestedVersionId)}`);
    if (version.project_id !== projectId || !version.loaders?.includes('fabric') || !version.game_versions?.includes(context.metadata.version || context.release.version)) {
      throw new Error('A required mod version does not support this Fabric instance.');
    }
    return version;
  }
  const params = new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([context.metadata.version || context.release.version]), include_changelog: 'false' });
  const versions = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  const gameVersion = context.metadata.version || context.release.version;
  const compatible = Array.isArray(versions) ? versions.filter(version => version.loaders?.includes('fabric') && version.game_versions?.includes(gameVersion)) : [];
  if (!compatible.length) throw new Error('This mod has no Fabric version for this Minecraft version.');
  return compatible.find(version => version.version_type === 'release') || compatible[0];
}

function chooseModrinthJar(version) {
  const files = Array.isArray(version.files) ? version.files : [];
  const jarFiles = files.filter(file => typeof file.filename === 'string' && file.filename.toLowerCase().endsWith('.jar'));
  const file = jarFiles.find(candidate => candidate.primary) || jarFiles[0];
  if (!file || !file.url || !file.hashes || (!file.hashes.sha512 && !file.hashes.sha1)) throw new Error('Modrinth did not provide a verifiable JAR file for this version.');
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !(url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth returned an unsafe download URL.');
  return file;
}

async function downloadModrinthJar(file, destination, report) {
  const maxBytes = Math.min(MODRINTH_MAX_JAR_SIZE, Number.isFinite(file.size) && file.size > 0 ? file.size : MODRINTH_MAX_JAR_SIZE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(file.url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'application/java-archive, application/octet-stream', 'User-Agent': MODRINTH_USER_AGENT } });
    if (!response.ok || !response.body) throw new Error(`Modrinth download failed with HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'modrinth.com' || finalUrl.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth redirected to an unsafe download URL.');
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > maxBytes) throw new Error('This mod file is larger than Eclipse allows.');
    let received = 0;
    const algorithm = file.hashes.sha512 ? 'sha512' : 'sha1';
    const hash = crypto.createHash(algorithm);
    const meter = new (require('stream').Transform)({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) return callback(new Error('This mod file is larger than Eclipse allows.'));
        hash.update(chunk);
        report?.(received, Number(file.size) || contentLength || 0);
        callback(null, chunk);
      }
    });
    await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal });
    if (Number(file.size) > 0 && received !== Number(file.size)) throw new Error('The downloaded mod file has an unexpected size.');
    if (hash.digest('hex').toLowerCase() !== String(file.hashes[algorithm]).toLowerCase()) throw new Error('The downloaded mod failed its Modrinth checksum verification.');
    return received;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally { clearTimeout(timeout); }
}

async function installModrinthProject(event, folder, projectId) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error('That Modrinth project could not be found.');
  assertModFolderIdle(folder);
  const context = getInstanceModContext(folder);
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-modrinth-'));
  activeModInstalls.add(folder);
  const createdModFiles = [];
  const sendProgress = update => { if (!event.sender.isDestroyed()) event.sender.send('mods:install-progress', { folder, ...update }); };
  try {
    const current = await listInstanceMods(folder, true);
    const existingProjects = new Set(current.map(mod => mod.modrinthProjectId).filter(Boolean));
    const existingModIds = new Set(current.map(mod => String(mod.id || '').toLowerCase()).filter(Boolean));
    const registry = readModrinthRegistry(context.modsPath);
    const projectCache = new Map();
    const getProject = async id => {
      if (!projectCache.has(id)) projectCache.set(id, await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}`));
      return projectCache.get(id);
    };
    const isInstalled = async id => {
      if (existingProjects.has(id)) return true;
      const project = await getProject(id);
      return existingModIds.has(String(project.slug || '').toLowerCase());
    };
    const visiting = new Set();
    const scheduled = new Set();
    const resolved = [];
    const visit = async (id, label, versionId = '') => {
      if (scheduled.has(id)) return;
      if (visiting.has(id)) return;
      visiting.add(id);
      const installedRecord = Object.values(registry).find(mod => mod?.projectId === id);
      const installed = await isInstalled(id);
      const version = await findCompatibleModrinthVersion(id, context, versionId || (installed ? installedRecord?.versionId || '' : ''));
      for (const dependency of version.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        const dependencyId = dependency.project_id || (dependency.version_id ? (await modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(dependency.version_id)}`)).project_id : '');
        if (!dependencyId) throw new Error(`${label} has a required external dependency that Eclipse cannot resolve automatically.`);
        const project = await getProject(dependencyId);
        await visit(dependencyId, project.title || project.name || project.slug || 'Required dependency', dependency.version_id || '');
      }
      const project = await getProject(id);
      if (!installed) {
        const file = chooseModrinthJar(version);
        resolved.push({ projectId: id, slug: String(project.slug || ''), name: String(project.title || label), description: String(project.description || ''), icon: secureModrinthIcon(project.icon_url), versionId: version.id, version: version.version_number, file });
      }
      scheduled.add(id);
      visiting.delete(id);
    };
    sendProgress({ status: 'Checking compatible versions and dependencies', percent: 4 });
    await visit(projectId, 'Selected mod');
    if (!resolved.length) {
      sendProgress({ status: 'The mod and its required dependencies are already installed', percent: 100, complete: true });
      return { ...(await listInstanceMods(folder, true)), installedCount: 0 };
    }

    const staged = [];
    for (let index = 0; index < resolved.length; index++) {
      const item = resolved[index];
      const filename = path.basename(item.file.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
      if (!filename.toLowerCase().endsWith('.jar')) throw new Error('Modrinth returned a file that is not a JAR.');
      const stagedPath = path.join(staging, `${index}.jar`);
      sendProgress({ status: `Downloading ${item.name}`, percent: Math.round(8 + 84 * index / resolved.length) });
      await downloadModrinthJar(item.file, stagedPath, (received, total) => {
        const downloadPart = total ? Math.round(84 * (index + received / total) / resolved.length) : 0;
        sendProgress({ status: `Downloading ${item.name}`, percent: Math.min(92, 8 + downloadPart) });
      });
      staged.push({ ...item, filename, stagedPath });
    }

    const newNames = new Set();
    for (const item of staged) {
      let filename = item.filename;
      if (fs.existsSync(path.join(context.modsPath, filename)) || newNames.has(filename.toLowerCase())) {
        const stem = filename.slice(0, -4);
        filename = `${stem}-${item.versionId.slice(0, 6)}.jar`;
      }
      if (fs.existsSync(path.join(context.modsPath, filename)) || newNames.has(filename.toLowerCase())) throw new Error(`A mod file named ${filename} already exists.`);
      item.filename = filename;
      newNames.add(filename.toLowerCase());
    }

    for (const item of staged) {
      const destination = path.resolve(context.modsPath, item.filename);
      if (path.dirname(destination) !== path.resolve(context.modsPath)) throw new Error('A mod download contained an unsafe filename.');
      fs.copyFileSync(item.stagedPath, destination, fs.constants.COPYFILE_EXCL);
      createdModFiles.push(destination);
      registry[item.filename] = { projectId: item.projectId, slug: item.slug, name: item.name, description: item.description, icon: item.icon, modId: '', version: item.version, versionId: item.versionId };
    }
    writeModrinthRegistry(context.modsPath, registry);
    sendProgress({ status: `Installed ${resolved.length} mod${resolved.length === 1 ? '' : 's'} with required dependencies`, percent: 100, complete: true });
    return { ...(await listInstanceMods(folder, true)), installedCount: staged.length };
  } catch (error) {
    for (const filePath of createdModFiles) fs.rmSync(filePath, { force: true });
    sendProgress({ status: error.message || 'Mod installation failed', percent: null, error: true });
    throw error;
  } finally {
    activeModInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installJavaRuntime(component, progress) {
  const platform = runtimePlatform();
  const runtimeIndex = await fetchJson(MOJANG_RUNTIME_MANIFEST);
  const available = runtimeIndex[platform]?.[component];
  if (!Array.isArray(available) || !available.length) throw new Error(`Mojang does not provide ${component} for ${platform}.`);
  const manifestInfo = available[0];
  const runtimeManifest = await fetchJson(manifestInfo.manifest.url);
  const basePath = runtimeDirectory(component, manifestInfo.version.name);
  const javaPath = runtimeJavaPath(component, manifestInfo.version.name);
  const files = Object.entries(runtimeManifest.files || {}).filter(([, item]) => item.type === 'file');
  const tasks = files.filter(([relative, item]) => {
    if (!item.downloads?.raw) throw new Error(`Java runtime file has no download: ${relative}`);
    const destination = path.join(basePath, relative);
    return !fs.existsSync(destination) || fs.statSync(destination).size !== item.downloads.raw.size;
  });
  fs.mkdirSync(basePath, { recursive: true });
  let completed = files.length - tasks.length;
  let nextTask = 0;
  const worker = async () => {
    while (nextTask < tasks.length) {
      const [relative, item] = tasks[nextTask++];
      const destination = path.join(basePath, relative);
      const resolved = path.resolve(destination);
      if (!resolved.startsWith(`${path.resolve(basePath)}${path.sep}`)) throw new Error('Mojang runtime manifest contains an unsafe file path.');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await downloadFile(item.downloads.raw.url, destination);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(destination)).digest('hex');
      if (hash !== item.downloads.raw.sha1) {
        fs.rmSync(destination, { force: true });
        throw new Error(`Java runtime verification failed for ${relative}.`);
      }
      if (process.platform !== 'win32' && item.executable) fs.chmodSync(destination, 0o755);
      completed++;
      progress({ phase: 'runtime', status: `Setting up Java ${manifestInfo.version.name}`, percent: Math.round((completed / files.length) * 100) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, worker));
  if (!fs.existsSync(javaPath)) throw new Error('Java runtime installation did not produce its launcher executable.');
  fs.writeFileSync(path.join(basePath, '.eclipse-runtime-ready.json'), JSON.stringify({
    component,
    version: manifestInfo.version.name,
    files: files.map(([relative, item]) => ({ path: relative, size: item.downloads.raw.size, sha1: item.downloads.raw.sha1 }))
  }, null, 2));
  return { javaPath, runtimeVersion: manifestInfo.version.name };
}

async function installInstance(event, folder) {
  if (typeof folder !== 'string' || path.basename(folder) !== folder || !INSTANCE_RELEASES[folder]) {
    throw new Error('There is no installer configured for this instance.');
  }
  if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder)) throw new Error('This instance is already installing or changing mods.');
  const instancePath = path.join(instancesDir, folder);
  if (!fs.existsSync(instancePath) || !fs.statSync(instancePath).isDirectory()) throw new Error('That Minecraft instance could not be found.');
  const release = INSTANCE_RELEASES[folder];
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-instance-'));
  const archive = path.join(staging, 'instance.zip');
  const extracted = path.join(staging, 'extracted');
  activeInstanceInstalls.add(folder);
  try {
    sendInstallProgress(event, folder, { phase: 'download', status: 'Downloading instance files', percent: 0 });
    await downloadFile(release.url, archive, (received, total) => {
      sendInstallProgress(event, folder, { phase: 'download', status: 'Downloading instance files', percent: total ? Math.min(100, Math.round(received / total * 100)) : null, received, total });
    });
    sendInstallProgress(event, folder, { phase: 'extract', status: 'Checking and extracting files', percent: null });
    await extractZip(archive, {
      dir: extracted,
      onEntry(entry) {
        const normalized = entry.fileName.replace(/\\/g, '/');
        const parts = normalized.split('/');
        if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || entry.fileName.includes('\\')) {
          throw new Error(`The instance archive contains an unsafe file path: ${entry.fileName}`);
        }
        const mode = (entry.externalFileAttributes >> 16) & 0xF000;
        if (mode === 0xA000) throw new Error('The instance archive contains an unsupported symbolic link.');
      }
    });

    const modsPath = path.join(extracted, 'mods');
    const configPath = path.join(extracted, 'config');
    const hasArchiveMarker = fs.existsSync(path.join(extracted, 'downloaded.txt'));
    if (!hasArchiveMarker || !fs.existsSync(modsPath) || !fs.statSync(modsPath).isDirectory() || !hasModJar(extracted) || !hasContentFile(configPath)) {
      throw new Error('The downloaded pack is incomplete. It needs downloaded.txt, at least one mod, and config files.');
    }

    sendInstallProgress(event, folder, { phase: 'fabric', status: 'Preparing Fabric profile', percent: null });
    const fabricProfile = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(release.version)}/${encodeURIComponent(release.fabricLoader)}/profile/json`);
    if (fabricProfile.id !== release.launchProfile || fabricProfile.inheritsFrom !== release.version || !Array.isArray(fabricProfile.libraries)) {
      throw new Error('Fabric returned an unexpected launch profile.');
    }
    const profileDir = path.join(extracted, 'versions', release.launchProfile);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, `${release.launchProfile}.json`), JSON.stringify(fabricProfile, null, 2), 'utf8');

    sendInstallProgress(event, folder, { phase: 'runtime', status: 'Setting up the required Java runtime', percent: 0 });
    const runtimeComponent = release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma';
    const runtime = await installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update));

    sendInstallProgress(event, folder, { phase: 'finalize', status: 'Finishing instance setup', percent: null });
    await fs.promises.cp(extracted, instancePath, {
      recursive: true,
      force: false,
      filter(source) { return path.basename(source).toLowerCase() !== 'eclipse-instance.json'; }
    });
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};
    const finalProfilePath = path.join(instancePath, 'versions', release.launchProfile, `${release.launchProfile}.json`);
    fs.mkdirSync(path.dirname(finalProfilePath), { recursive: true });
    fs.copyFileSync(path.join(profileDir, `${release.launchProfile}.json`), finalProfilePath);
    const installedMetadata = { ...metadata, version: release.version, loader: 'Fabric', launchProfile: release.launchProfile, runtimeComponent, runtimeVersion: runtime.runtimeVersion, builtInMods: listJarFiles(path.join(extracted, 'mods')).map(baseJarName) };
    fs.writeFileSync(metadataPath, JSON.stringify(installedMetadata, null, 2));
    const markerPath = path.join(instancePath, 'downloaded.txt');
    fs.writeFileSync(markerPath, 'Installed and verified by Eclipse Launcher.\n', 'utf8');
    if (!isInstanceInstalled(folder, installedMetadata)) {
      fs.rmSync(markerPath, { force: true });
      throw new Error('The instance did not pass its final installation checks.');
    }
    sendInstallProgress(event, folder, { phase: 'complete', status: 'Installation complete', percent: 100 });
    return { ok: true, folder };
  } catch (error) {
    sendInstallProgress(event, folder, { phase: 'error', status: error.message || 'Installation failed', percent: null });
    throw error;
  } finally {
    activeInstanceInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
function ensureDirs() {
  fs.mkdirSync(instancesDir, { recursive: true });
  if (!isDev) {
    const bundledInstances = path.join(app.getAppPath(), 'instances');
    if (fs.existsSync(bundledInstances)) {
      for (const entry of fs.readdirSync(bundledInstances, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const destination = path.join(instancesDir, entry.name);
        copyMissingBundledFiles(path.join(bundledInstances, entry.name), destination);
      }
    }
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      profile: { mode: 'offline', name: 'Steve', status: 'online' },
      profiles: [{ id: 'offline-default', type: 'offline', mode: 'offline', name: 'Steve', status: 'online' }],
      selectedProfileId: 'offline-default',
      animationSpeed: 'normal',
      playAnimationSpeed: 'relaxed',
      showPlaytime: true,
      playtimePosition: 'left',
      showFriendsBox: true,
      showQuickLaunch: true,
      newsEnabled: true,
      sidebarOrder: ['home', 'mods', 'profile', 'settings'],
      pinnedInstances: [],
      theme: 'dark',
      background: null,
      installedInstances: {}
    }, null, 2));
  }
}

function readSettings() {
  ensureDirs();
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); }
  catch { return normalizeSettings({ profile: { mode: 'offline', name: 'Steve', status: 'online' }, theme: 'dark', background: null, installedInstances: {} }); }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(normalizeSettings(settings), null, 2));
}

function normalizeSettings(settings = {}) {
  const storedProfiles = Array.isArray(settings.profiles) ? settings.profiles.filter(profile => profile && typeof profile.id === 'string') : [];
  const profiles = storedProfiles.length ? storedProfiles : [{
    id: 'offline-default',
    type: 'offline',
    mode: 'offline',
    name: settings.profile?.name || 'Steve',
    status: settings.profile?.status || 'online'
  }];
  const requestedId = settings.selectedProfileId || settings.profile?.id;
  const selected = profiles.find(profile => profile.id === requestedId) || profiles[0];
  const normalizedProfiles = profiles.map(profile => ({ ...profile, note: typeof profile.note === 'string' ? profile.note : '', mode: profile.type === 'microsoft' ? 'microsoft' : 'offline' }));
  const selectedProfile = normalizedProfiles.find(profile => profile.id === selected.id) || normalizedProfiles[0];
  const animationSpeeds = new Set(['fast', 'normal', 'relaxed', 'slow', 'off']);
  const animationSpeed = animationSpeeds.has(settings.animationSpeed) ? settings.animationSpeed : 'normal';
  const playAnimationSpeed = animationSpeeds.has(settings.playAnimationSpeed) ? settings.playAnimationSpeed : 'relaxed';
  const showPlaytime = settings.showPlaytime !== false;
  const playtimePosition = settings.playtimePosition === 'right' ? 'right' : 'left';
  const showFriendsBox = typeof settings.showFriendsBox === 'boolean'
    ? settings.showFriendsBox
    : settings.hideFriendsBox !== true;
  const showQuickLaunch = settings.showQuickLaunch !== false;
  const sidebarPages = ['home', 'mods', 'profile', 'settings'];
  const requestedSidebarOrder = Array.isArray(settings.sidebarOrder) ? settings.sidebarOrder.filter(page => sidebarPages.includes(page)) : [];
  const sidebarOrder = [...new Set(requestedSidebarOrder), ...sidebarPages.filter(page => !requestedSidebarOrder.includes(page))];
  const newsEnabled = settings.newsEnabled !== false;
  const pinnedInstances = Array.isArray(settings.pinnedInstances) ? [...new Set(settings.pinnedInstances.filter(folder => typeof folder === 'string'))] : [];
  return { ...settings, animationSpeed, playAnimationSpeed, showPlaytime, playtimePosition, showFriendsBox, showQuickLaunch, newsEnabled, sidebarOrder, pinnedInstances, profiles: normalizedProfiles, selectedProfileId: selectedProfile.id, profile: selectedProfile };
}

function publicSettings(settings) {
  const normalized = normalizeSettings(settings);
  const publicProfiles = normalized.profiles.map(({ refreshTokenEncrypted, ...profile }) => profile);
  const selectedProfile = publicProfiles.find(profile => profile.id === normalized.selectedProfileId) || publicProfiles[0];
  return { ...normalized, profiles: publicProfiles, profile: selectedProfile };
}

function patchSettings(current, patch) {
  const updated = { ...current, ...patch };
  if (patch.profile && current.selectedProfileId) {
    updated.profiles = current.profiles.map(profile => profile.id === current.selectedProfileId
      ? { ...profile, ...patch.profile, id: profile.id, type: profile.type }
      : profile);
  }
  return normalizeSettings(updated);
}

function encryptRefreshToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device. Microsoft sign-in cannot be saved safely.');
  return safeStorage.encryptString(token).toString('base64');
}

function decryptRefreshToken(profile) {
  if (!profile.refreshTokenEncrypted || !safeStorage.isEncryptionAvailable()) {
    throw new Error('This Microsoft profile needs to be connected again.');
  }
  return safeStorage.decryptString(Buffer.from(profile.refreshTokenEncrypted, 'base64'));
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function plainText(value = '') {
  return decodeXml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function rawTag(block, tag) {
  const escaped = tag.replace(':', '\\:');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function tagText(block, tag) {
  return plainText(rawTag(block, tag));
}

function attribute(block, tag, attr) {
  const escaped = tag.replace(':', '\\:');
  const re = new RegExp(`<${escaped}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*\\/?\\s*>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

function normalizeImage(url) {
  if (!url) return '';
  const cleaned = decodeXml(url).trim();
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  if (/^https:\/\//i.test(cleaned)) return cleaned;
  return '';
}

function trustedNewsImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['minecraft.net', 'mojang.com'].some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function parseMinecraftRss(xml, sourceLabel = 'Minecraft.net') {
  const items = [];
  const blocks = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks.slice(0, 20)) {
    const title = tagText(block, 'title');
    let link = tagText(block, 'link') || tagText(block, 'guid');
    if (!link) link = attribute(block, 'link', 'href');
    const rawDescription = rawTag(block, 'description') || rawTag(block, 'content:encoded') || rawTag(block, 'content') || rawTag(block, 'summary');
    const description = plainText(rawDescription);
    const pubDate = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date');
    let image = normalizeImage(
      attribute(block, 'media:content', 'url') ||
      attribute(block, 'media:thumbnail', 'url') ||
      attribute(block, 'enclosure', 'url') ||
      attribute(block, 'image', 'url')
    );
    if (!image) {
      const imageMatch = decodeXml(rawDescription).match(/<img\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
      if (imageMatch) image = normalizeImage(imageMatch[1]);
    }
    // Do not allow arbitrary external URLs into the article-opening window.
    if (!link) link = attribute(block, 'a10:link', 'href');
    let officialLink = false;
    try {
      const parsedLink = new URL(link);
      officialLink = parsedLink.protocol === 'https:' && ['minecraft.net', 'www.minecraft.net'].includes(parsedLink.hostname);
    } catch {}
    if (title && officialLink) {
      items.push({ title, link, description, pubDate, image, source: sourceLabel });
    }
  }
  return items;
}

async function requestText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    const xmlEncoding = bytes.subarray(0, 160).toString('ascii').match(/encoding\s*=\s*["']([^"']+)/i)?.[1];
    const declaredEncoding = contentType.match(/charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim();
    const encoding = (declaredEncoding || xmlEncoding || 'utf-8').toLowerCase();
    const body = new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '').trim();
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(body.slice(0, 2000))) {
      const hint = /<(?:!doctype\s+html|html)\b/i.test(body.slice(0, 500)) ? 'The server returned an HTML page instead of a feed (possibly a bot/challenge page).' : 'The server did not return an RSS/XML feed.';
      throw new Error(hint);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArticleImage(articleUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok || !trustedNewsImage(response.url)) return '';
    const html = await response.text();
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const key = attribute(tag, 'meta', 'property') || attribute(tag, 'meta', 'name');
      if (!/^og:image$/i.test(key)) continue;
      const image = normalizeImage(attribute(tag, 'meta', 'content'));
      if (image && trustedNewsImage(image)) return image;
    }
  } catch {
    // An article still displays normally with its per-card fallback if image metadata is unavailable.
  } finally {
    clearTimeout(timeout);
  }
  return '';
}

async function addArticleImages(items) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (!item.image) item.image = await fetchArticleImage(item.link);
    }
  });
  await Promise.all(workers);
}

async function fetchMinecraftNews(forceRefresh = false) {
  if (!forceRefresh && cachedMinecraftNews && Date.now() - cachedMinecraftNewsAt < NEWS_CACHE_MS) {
    return cachedMinecraftNews;
  }
  if (minecraftNewsRequest) return minecraftNewsRequest;

  minecraftNewsRequest = (async () => {
    for (const feed of MINECRAFT_RSS_FEEDS) {
      try {
        const xml = await requestText(feed.url);
        const items = parseMinecraftRss(xml, feed.source);
        if (items.length) {
          await addArticleImages(items.slice(0, 6));
          cachedMinecraftNews = items;
          cachedMinecraftNewsAt = Date.now();
          return items;
        }
      } catch {
        // Return cached content if present; otherwise the renderer shows its retry state.
      }
    }
    // Keep the home screen usable during a temporary outage and avoid repeated console errors.
    return cachedMinecraftNews || [];
  })();
  try {
    return await minecraftNewsRequest;
  } finally {
    minecraftNewsRequest = null;
  }
}

async function fetchJsonResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(url, options = {}) {
  const { response, body } = await fetchJsonResponse(url, options);
    if (!response.ok) {
      const detail = body.error_description || body.Message || body.error || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    return body;
}

async function exchangeMicrosoftForMinecraft(msaAccessToken) {
  const xbox = await requestJson('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  });
  const { response: xstsResponse, body: xsts } = await fetchJsonResponse('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' })
  });
  if (!xstsResponse.ok) {
    if (xsts.XErr === 2148916233) throw new Error('This Microsoft account does not have an Xbox profile yet. Create one, then try again.');
    if (xsts.XErr === 2148916238) throw new Error('This child Microsoft account needs an adult account to finish Xbox setup.');
    throw new Error(xsts.Message || `Xbox sign-in failed (HTTP ${xstsResponse.status}).`);
  }
  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!userHash || !xsts.Token) throw new Error('Xbox sign-in returned an incomplete response.');
  const minecraft = await requestJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` })
  });
  const { response: profileResponse, body: profile } = await fetchJsonResponse('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' }
  });
  if (profileResponse.status === 404) throw new Error('This Microsoft account has no Minecraft: Java Edition profile.');
  if (!profileResponse.ok) throw new Error(profile.errorMessage || `Could not load the Minecraft profile (HTTP ${profileResponse.status}).`);
  if (!profile.id || !profile.name || !minecraft.access_token) throw new Error('Minecraft returned an incomplete profile.');
  const xuid = xsts.DisplayClaims?.xui?.[0]?.xid || xbox.DisplayClaims?.xui?.[0]?.xid || '';
  return { accessToken: minecraft.access_token, uuid: profile.id, name: profile.name, xuid };
}

async function receiveMicrosoftAuthorizationCode(clientId) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('hex');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const redirectUri = `http://localhost:${address.port}`;
  let timeout;
  const codePromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Microsoft sign-in timed out. Please try again.')), 3 * 60 * 1000);
    server.on('request', (request, response) => {
      const callback = new URL(request.url, redirectUri);
      if (callback.pathname !== '/') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (callback.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Sign-in could not be verified. Return to Eclipse and try again.');
        reject(new Error('Microsoft sign-in could not be verified. Please try again.'));
        return;
      }
      const error = callback.searchParams.get('error');
      const code = callback.searchParams.get('code');
      response.writeHead(error || !code ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(error || !code
        ? '<!doctype html><title>Sign-in cancelled</title><p>Sign-in was not completed. You can close this tab and return to Eclipse.</p>'
        : '<!doctype html><title>Sign-in complete</title><p>Sign-in complete. You can close this tab and return to Eclipse Launcher.</p>');
      if (error) reject(new Error(callback.searchParams.get('error_description') || 'Microsoft sign-in was cancelled.'));
      else if (code) resolve(code);
      else reject(new Error('Microsoft did not return an authorization code.'));
    });
  });

  try {
    const authorize = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'XboxLive.signin offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account'
    }).toString();
    await shell.openExternal(authorize.href);
    const code = await codePromise;
    return { code, verifier, redirectUri };
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

async function addMicrosoftProfile(clientId) {
  const normalizedClientId = String(clientId || '').trim();
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(normalizedClientId)) {
    throw new Error('Enter the Microsoft app Client ID first. Eclipse needs its own registered public app ID to open secure sign-in.');
  }
  const settings = readSettings();
  settings.microsoftClientId = normalizedClientId;
  writeSettings(settings);

  const { code, verifier, redirectUri } = await receiveMicrosoftAuthorizationCode(normalizedClientId);
  const token = await requestJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: normalizedClientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: 'XboxLive.signin offline_access'
    })
  });
  if (!token.access_token || !token.refresh_token) throw new Error('Microsoft sign-in did not return a renewable session. Check that the app registration allows public client flows.');
  const minecraft = await exchangeMicrosoftForMinecraft(token.access_token);
  const profile = {
    id: crypto.randomUUID(),
    type: 'microsoft',
    mode: 'microsoft',
    name: minecraft.name,
    uuid: minecraft.uuid,
    status: 'online',
    refreshTokenEncrypted: encryptRefreshToken(token.refresh_token)
  };
  settings.profiles.push(profile);
  settings.selectedProfileId = profile.id;
  writeSettings(settings);
  return publicSettings(settings);
}

async function refreshMicrosoftSession(profile, settings) {
  if (!settings.microsoftClientId) throw new Error('Add a Microsoft app Client ID in the profile setup first.');
  const token = await requestJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: settings.microsoftClientId,
      grant_type: 'refresh_token',
      refresh_token: decryptRefreshToken(profile),
      scope: 'XboxLive.signin offline_access'
    })
  });
  const session = await exchangeMicrosoftForMinecraft(token.access_token);
  if (profile.uuid && profile.uuid !== session.uuid) throw new Error('The signed-in Minecraft profile does not match this saved account. Reconnect the profile.');
  if (token.refresh_token) {
    const current = readSettings();
    current.profiles = current.profiles.map(saved => saved.id === profile.id
      ? { ...saved, refreshTokenEncrypted: encryptRefreshToken(token.refresh_token), name: session.name, uuid: session.uuid }
      : saved);
    writeSettings(current);
  }
  return session;
}

function secureSkinImageUrl(value) {
  try {
    const imageUrl = new URL(value);
    if (imageUrl.protocol === 'http:' && ['ely.by', 'textures.minecraft.net'].some(domain => imageUrl.hostname === domain || imageUrl.hostname.endsWith(`.${domain}`))) {
      imageUrl.protocol = 'https:';
    }
    const allowedHost = ['ely.by', 'textures.minecraft.net'].some(domain => imageUrl.hostname === domain || imageUrl.hostname.endsWith(`.${domain}`));
    return imageUrl.protocol === 'https:' && allowedHost ? imageUrl.href : '';
  } catch { return ''; }
}

async function skinJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'EclipseLauncher/0.9.0' } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function resolveSkinUrl(name) {
  const nickname = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(nickname)) return '';
  const cacheKey = nickname.toLowerCase();
  const cached = skinUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const cacheSkin = url => skinUrlCache.set(cacheKey, { url, expiresAt: Date.now() + SKIN_URL_CACHE_MS });

  const elyTextures = await skinJson(`https://skinsystem.ely.by/textures/${encodeURIComponent(nickname)}`);
  const elySkin = secureSkinImageUrl(elyTextures?.SKIN?.url);
  if (elySkin) {
    cacheSkin(elySkin);
    return elySkin;
  }

  // Ely.by proxies premium skins too, but fall back to Mojang's public profile API if Ely.by is unavailable.
  const officialProfile = await skinJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nickname)}`);
  if (officialProfile?.id) {
    const signedProfile = await skinJson(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(officialProfile.id)}`);
    const texturesProperty = signedProfile?.properties?.find(property => property.name === 'textures');
    if (texturesProperty?.value) {
      try {
        const textureData = JSON.parse(Buffer.from(texturesProperty.value, 'base64').toString('utf8'));
        const officialSkin = secureSkinImageUrl(textureData.textures?.SKIN?.url);
        if (officialSkin) {
          cacheSkin(officialSkin);
          return officialSkin;
        }
      } catch {}
    }
  }
  cacheSkin('');
  return '';
}

async function downloadProfileSkin(profileId) {
  const profile = readSettings().profiles.find(item => item.id === profileId);
  if (!profile) throw new Error('That profile could not be found.');
  const skinUrl = await resolveSkinUrl(profile.name);
  if (!skinUrl) throw new Error(`No Minecraft skin was found for ${profile.name}.`);

  const result = await dialog.showSaveDialog({
    title: `Download ${profile.name}'s Minecraft skin`,
    defaultPath: `${profile.name}.png`,
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': 'EclipseLauncher/0.9.0' } });
    if (!response.ok || !/^image\/png\b/i.test(response.headers.get('content-type') || '')) throw new Error('Ely.by could not provide this skin image.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('The downloaded skin was not a valid PNG image.');
    fs.writeFileSync(result.filePath, bytes);
    return result.filePath;
  } finally { clearTimeout(timeout); }
}

function createNewsWindow(parent, url) {
  const newsWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    parent,
    modal: false,
    backgroundColor: '#070b16',
    title: 'Eclipse — Minecraft News',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  newsWindow.loadURL(url, { extraHeaders: 'Accept-Language: en-US,en;q=0.9\n' });
  return newsWindow;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#070b16',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  ensureDirs();

  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize());
  ipcMain.handle('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w.isMaximized() ? w.unmaximize() : w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender).close());

  ipcMain.handle('settings:get', () => {
    const settings = readSettings();
    return { ...publicSettings(settings), backgroundUrl: settings.background ? pathToFileURL(settings.background).href : null };
  });

  ipcMain.handle('settings:set', (_, patch) => {
    const current = readSettings();
    const settings = patchSettings(current, patch);
    writeSettings(settings);
    return { ...publicSettings(settings), backgroundUrl: settings.background ? pathToFileURL(settings.background).href : null };
  });

  ipcMain.handle('profile:add-offline', (_, name) => {
    const cleanName = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(cleanName)) throw new Error('Offline names must be 1–16 characters using letters, numbers, or underscores.');
    const settings = readSettings();
    const profile = { id: crypto.randomUUID(), type: 'offline', mode: 'offline', name: cleanName, status: 'online', note: '' };
    settings.profiles.push(profile);
    settings.selectedProfileId = profile.id;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('profile:select', (_, profileId) => {
    const settings = readSettings();
    if (!settings.profiles.some(profile => profile.id === profileId)) throw new Error('That profile could not be found.');
    settings.selectedProfileId = profileId;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('profile:set-note', (_, profileId, note) => {
    const cleanNote = String(note ?? '');
    if (cleanNote.length > 30000) throw new Error('This formatted note is too large to save. Please shorten it.');
    const settings = readSettings();
    const profile = settings.profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    profile.note = cleanNote;
    profile.noteFormat = 'html-v1';
    writeSettings(settings);
    return true;
  });

  ipcMain.handle('profile:skin-url', async (_, profileId) => {
    const profile = readSettings().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    return resolveSkinUrl(profile.name);
  });

  ipcMain.handle('profile:skin-data', async (_, profileId) => {
    const profile = readSettings().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    const skinUrl = await resolveSkinUrl(profile.name);
    if (!skinUrl) throw new Error(`No Minecraft skin was found for ${profile.name}.`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': 'EclipseLauncher/0.9.0' } });
      if (!response.ok) throw new Error(`Skin image server returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('The skin image is empty or too large to preview.');
      if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('The skin server returned an invalid PNG image.');
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } finally {
      clearTimeout(timeout);
    }
  });

  ipcMain.handle('profile:download-skin', async (_, profileId) => downloadProfileSkin(profileId));

  ipcMain.handle('profile:remove', (_, profileId) => {
    const settings = readSettings();
    if (settings.profiles.length < 2) throw new Error('Keep at least one profile in Eclipse.');
    settings.profiles = settings.profiles.filter(profile => profile.id !== profileId);
    if (settings.selectedProfileId === profileId) settings.selectedProfileId = settings.profiles[0].id;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('accounts:login-microsoft', async (_, clientId) => addMicrosoftProfile(clientId));
  ipcMain.handle('accounts:open-registration', async () => {
    await shell.openExternal('https://entra.microsoft.com/');
    return true;
  });

  ipcMain.handle('background:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp'] }]
    });
    if (result.canceled) return null;
    const settings = readSettings();
    settings.background = result.filePaths[0];
    writeSettings(settings);
    return { path: result.filePaths[0], url: pathToFileURL(result.filePaths[0]).href };
  });

  ipcMain.handle('instances:list', () => {
    ensureDirs();
    const folders = fs.readdirSync(instancesDir, { withFileTypes: true })
      .filter(x => x.isDirectory())
      .map(x => {
        const p = path.join(instancesDir, x.name);
        const metaPath = path.join(p, 'eclipse-instance.json');
        let meta = { name: x.name, version: '1.20.1', loader: 'Fabric', lastPlayed: 0 };
        if (fs.existsSync(metaPath)) {
          try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch {}
        }
        const imagePath = meta.image ? path.join(p, meta.image) : null;
        return {
          ...meta,
          folder: x.name,
          installed: isInstanceInstalled(x.name, meta),
          image: imagePath && fs.existsSync(imagePath) ? imagePath : null
        };
      });
    return folders;
  });

  ipcMain.handle('mods:list', async (_, folder) => {
    let timeout;
    try {
      return await Promise.race([
        listInstanceMods(folder),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reading this instance’s mods timed out. Try Refresh again.')), 15000); })
      ]);
    } finally { clearTimeout(timeout); }
  });
  ipcMain.handle('mods:open-folder', (_, folder) => openInstanceModsFolder(folder));
  ipcMain.handle('mods:set-enabled', (_, folder, fileName, enabled) => setInstanceModEnabled(folder, fileName, Boolean(enabled)));
  ipcMain.handle('mods:remove', (_, folder, fileName) => removeInstanceMod(folder, fileName));
  ipcMain.handle('mods:search', (_, folder, query) => searchModrinthMods(query, folder));
  ipcMain.handle('mods:install', (event, folder, projectId) => installModrinthProject(event, folder, projectId));

  ipcMain.handle('instance:install', async (event, folder) => installInstance(event, folder));

  ipcMain.handle('instance:rename', (_, folder, requestedName) => {
    if (typeof folder !== 'string' || !folder || path.basename(folder) !== folder) {
      throw new Error('That Minecraft instance could not be found.');
    }
    const name = typeof requestedName === 'string' ? requestedName.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new Error('Enter a name for this instance.');
    if (name.length > 32) throw new Error('Instance names must be 32 characters or fewer.');
    const instancePath = path.join(instancesDir, folder);
    if (!fs.existsSync(instancePath) || !fs.statSync(instancePath).isDirectory()) {
      throw new Error('That Minecraft instance could not be found.');
    }
    const metaPath = path.join(instancePath, 'eclipse-instance.json');
    let metadata = {};
    if (fs.existsSync(metaPath)) {
      try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    }
    metadata = { ...metadata, name };
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    return { folder, name };
  });

  ipcMain.handle('instance:delete-files', (_, folder) => {
    if (typeof folder !== 'string' || path.basename(folder) !== folder || !INSTANCE_RELEASES[folder]) {
      throw new Error('That Minecraft instance could not be found.');
    }
    if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('Close Minecraft and wait for any installation to finish before deleting this instance.');
    }
    const instancesRoot = path.resolve(instancesDir);
    const instancePath = path.resolve(instancesRoot, folder);
    if (path.dirname(instancePath) !== instancesRoot) throw new Error('That Minecraft instance path is invalid.');
    let instanceStat;
    try { instanceStat = fs.lstatSync(instancePath); } catch { throw new Error('That Minecraft instance could not be found.'); }
    if (!instanceStat.isDirectory() || instanceStat.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    let metadataStat;
    try { metadataStat = fs.lstatSync(metadataPath); } catch { throw new Error('The instance profile file is missing, so Eclipse cannot safely remove this instance.'); }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid, so Eclipse cannot safely remove this instance.');

    let removedEntries = 0;
    for (const entry of fs.readdirSync(instancePath, { withFileTypes: true })) {
      if (entry.name === 'eclipse-instance.json') continue;
      const childPath = path.resolve(instancePath, entry.name);
      if (path.dirname(childPath) !== instancePath) throw new Error('The instance contains an unsafe file path.');
      fs.rmSync(childPath, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 });
      removedEntries++;
    }

    const settings = readSettings();
    settings.pinnedInstances = settings.pinnedInstances.filter(pinnedFolder => pinnedFolder !== folder);
    writeSettings(settings);
    if (fileVerificationCache) {
      const prefix = `:${instancePath}${path.sep}`;
      for (const key of fileVerificationCache.keys()) if (key.includes(prefix)) fileVerificationCache.delete(key);
      saveFileVerificationCacheSoon();
    }
    return { ok: true, folder, removedEntries };
  });

  ipcMain.handle('instance:reset-playtime', (_, folder) => {
    if (typeof folder !== 'string' || path.basename(folder) !== folder || !INSTANCE_RELEASES[folder]) {
      throw new Error('That Minecraft instance could not be found.');
    }
    if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('Close Minecraft and wait for any installation or launch to finish before resetting playtime.');
    }
    const instanceRoot = path.resolve(instancesDir);
    const instancePath = path.resolve(instanceRoot, folder);
    if (path.dirname(instancePath) !== instanceRoot) throw new Error('That Minecraft instance path is invalid.');
    let instanceStat;
    try { instanceStat = fs.lstatSync(instancePath); } catch { throw new Error('That Minecraft instance could not be found.'); }
    if (!instanceStat.isDirectory() || instanceStat.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    let metadataStat;
    try { metadataStat = fs.lstatSync(metadataPath); } catch { throw new Error('The instance profile file could not be found.'); }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid.');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { throw new Error('The instance profile file could not be read.'); }
    metadata.playtimeMs = 0;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return { folder, playtimeMs: 0 };
  });

  ipcMain.handle('instance:launch', async (event, instance) => {
    const folder = instance?.folder;
    const release = INSTANCE_RELEASES[folder];
    if (!release || typeof folder !== 'string' || path.basename(folder) !== folder) throw new Error('That Minecraft instance could not be found.');
    if (activeInstanceLaunches.size || pendingInstanceLaunches.size) throw new Error('Minecraft is already starting or running from Eclipse. Close it before launching another instance.');
    if (activeModInstalls.has(folder)) throw new Error('Wait for this instance’s mod installation to finish before launching it.');
    const instanceDir = path.join(instancesDir, folder);
    const metadataPath = path.join(instanceDir, 'eclipse-instance.json');
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch {}
    if (!isInstanceInstalled(folder, metadata)) throw new Error('This instance is not installed or is missing required files. Install it before launching.');
    pendingInstanceLaunches.add(folder);
    try {
    sendLaunchStatus(event, folder, { state: 'preparing' });
    const runtimeComponent = metadata.runtimeComponent || (release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma');
    const runtimeVersion = metadata.runtimeVersion || (release.version === '26.2' ? '25.0.1' : '17.0.15');
    if (!hasSafeRuntimeMetadata(runtimeComponent, runtimeVersion)) throw new Error('This instance has invalid Java runtime metadata.');
    const javaPath = runtimeJavaPath(runtimeComponent, runtimeVersion);
    const javaProbePath = runtimeJavaProbePath(runtimeComponent, runtimeVersion);

    const launcher = new Client();
    // MCLC uses its javaPath both to probe `-version` and to spawn the game. javaw.exe
    // is ideal for the game window, but suppresses the version text MCLC's probe expects.
    // Probe its companion java.exe while keeping javaw.exe as the actual game process.
    configureLauncherHandler(launcher, javaProbePath, instanceDir);
    const settings = readSettings();
    const profile = settings.profile;
    const microsoftSession = profile.type === 'microsoft' ? await refreshMicrosoftSession(profile, settings) : null;
    const username = microsoftSession?.name || profile.name || 'Steve';

    const opts = {
      authorization: {
        access_token: microsoftSession?.accessToken || '0',
        client_token: '',
        uuid: microsoftSession?.uuid || offlinePlayerUuid(username),
        name: username,
        user_properties: '{}',
        meta: microsoftSession
          ? { type: 'msa', demo: false, xuid: microsoftSession.xuid, clientId: settings.microsoftClientId }
          : { type: 'legacy', demo: false }
      },
      root: instanceDir,
      version: {
        number: release.version,
        type: 'release',
        custom: release.launchProfile
      },
      javaPath,
      memory: { min: '1G', max: '4G' }
    };

    let lastLaunchError = null;
    let earlyExitCode = null;
    let minecraftReady = false;
    let playtimeSession = null;
    let gameProcess = null;
    let loggedMinecraftErrors = 0;
    const reportLaunchProgress = createThrottledLaunchProgress(event, folder);
    const launchProgress = createLaunchProgressReporter(reportLaunchProgress);
    launchProgress.advance(5, true);
    const markMinecraftReady = () => {
      if (minecraftReady) return;
      minecraftReady = true;
      try {
        playtimeSession = startInstancePlaytime(folder, (playtimeMs, lastPlayed) => {
          sendLaunchStatus(event, folder, { state: 'playing', playtimeMs, lastPlayed });
        });
      } catch (error) {
        console.warn('[Minecraft] Could not start instance playtime tracking:', error.message);
      }
      sendLaunchStatus(event, folder, {
        state: 'playing',
        playtimeMs: playtimeSession?.initialPlaytimeMs,
        lastPlayed: playtimeSession?.startedAt
      });
    };
    launcher.on('debug', msg => {
      const message = String(msg);
      if (message.includes('[MCLC]: Failed to start due to')) {
        lastLaunchError = message.replace(/^.*?Failed to start due to /, '').replace(/, closing\.\.\.$/, '');
        console.error('[Minecraft launcher]', lastLaunchError);
      }
    });
    launcher.on('data', msg => {
      const output = String(msg);
      const mods = output.match(/Loading (\d+) mods:/);
      if (mods) reportLaunchProgress({ phase: 'minecraft-startup', status: `Loading ${mods[1]} mods`, percent: null });
      if (/Loading \d+ mods:/.test(output)) launchProgress.advance(92, true);
      if (/Game took [\d.]+ seconds to start/.test(output) ||
          (release.version === '26.2' && /Sound engine started/.test(output))) markMinecraftReady();
      if (loggedMinecraftErrors < 12) {
        for (const line of output.split(/\r?\n/)) {
          if (/\/(?:ERROR|FATAL)\]|Exception in thread|\bFATAL\b/.test(line)) {
            console.error('[Minecraft]', line.slice(0, 500));
            if (++loggedMinecraftErrors >= 12) break;
          }
        }
      }
    });
    launcher.on('close', code => { earlyExitCode = code; });
    launcher.on('download-status', status => {
      launchProgress.report(status.type, status.current, status.total);
    });
    launcher.on('progress', progress => {
      launchProgress.report(progress.type, progress.task, progress.total);
    });
    launcher.on('arguments', () => launchProgress.advance(86, true));

    try {
      gameProcess = await launcher.launch(opts);
      if (!gameProcess || !gameProcess.pid) {
        const detail = lastLaunchError || (earlyExitCode != null ? `Minecraft exited before opening (exit code ${earlyExitCode}).` : 'The Minecraft process could not be started.');
        throw new Error(detail);
      }
      activeInstanceLaunches.set(folder, gameProcess);
      gameProcess.once('error', error => {
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        activeInstanceLaunches.delete(folder);
        const playtimeMs = playtimeSession?.stop();
        sendLaunchStatus(event, folder, { state: 'failed', message: error.message, playtimeMs });
      });
      gameProcess.once('close', (code, signal) => {
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        activeInstanceLaunches.delete(folder);
        const playtimeMs = playtimeSession?.stop();
        sendLaunchStatus(event, folder, { state: 'closed', code, signal, playtimeMs });
      });
      if (minecraftReady) {
        sendLaunchStatus(event, folder, {
          state: 'playing',
          playtimeMs: playtimeSession?.persistElapsed(),
          lastPlayed: playtimeSession?.startedAt
        });
      } else sendLaunchStatus(event, folder, { state: 'loading' });
      return { ok: true };
    } catch (error) {
      const playtimeMs = playtimeSession?.stop();
      sendLaunchStatus(event, folder, { state: 'failed', message: error.message, playtimeMs });
      throw error;
    }
    } finally {
      pendingInstanceLaunches.delete(folder);
    }
  });

  ipcMain.handle('news:list', async (_, options) => fetchMinecraftNews(Boolean(options?.refresh)));
  ipcMain.handle('news:open', async (event, url) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { throw new Error('This Minecraft article link is invalid.'); }
    if (parsedUrl.protocol !== 'https:' || !['minecraft.net', 'www.minecraft.net'].includes(parsedUrl.hostname)) throw new Error('Only official Minecraft.net articles can be opened.');
    const parent = BrowserWindow.fromWebContents(event.sender);
    createNewsWindow(parent, parsedUrl.href);
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
