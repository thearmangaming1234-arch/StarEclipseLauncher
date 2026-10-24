const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Client } = require('minecraft-launcher-core');

const isDev = !app.isPackaged;
// During development, read the instances folder sitting next to src/.
// In a packaged launcher, userData is used so the installed app can write to it.
const instancesDir = isDev
  ? path.join(__dirname, '..', 'instances')
  : path.join(app.getPath('userData'), 'instances');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const MINECRAFT_RSS_FEEDS = [
  { url: 'https://www.minecraft.net/en-us/feeds/community-content/rss', source: 'Minecraft.net' }
];
const NEWS_CACHE_MS = 10 * 60 * 1000;
const SKIN_URL_CACHE_MS = 15 * 60 * 1000;
let cachedMinecraftNews = null;
let cachedMinecraftNewsAt = 0;
let minecraftNewsRequest = null;
const skinUrlCache = new Map();
function ensureDirs() {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      profile: { mode: 'offline', name: 'Steve', status: 'online' },
      profiles: [{ id: 'offline-default', type: 'offline', mode: 'offline', name: 'Steve', status: 'online' }],
      selectedProfileId: 'offline-default',
      animationSpeed: 'normal',
      playAnimationSpeed: 'relaxed',
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
  const sidebarPages = ['home', 'mods', 'profile', 'settings'];
  const requestedSidebarOrder = Array.isArray(settings.sidebarOrder) ? settings.sidebarOrder.filter(page => sidebarPages.includes(page)) : [];
  const sidebarOrder = [...new Set(requestedSidebarOrder), ...sidebarPages.filter(page => !requestedSidebarOrder.includes(page))];
  const newsEnabled = settings.newsEnabled !== false;
  const pinnedInstances = Array.isArray(settings.pinnedInstances) ? [...new Set(settings.pinnedInstances.filter(folder => typeof folder === 'string'))] : [];
  return { ...settings, animationSpeed, playAnimationSpeed, newsEnabled, sidebarOrder, pinnedInstances, profiles: normalizedProfiles, selectedProfileId: selectedProfile.id, profile: selectedProfile };
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
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'EclipseLauncher/0.2.2' } });
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
    const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': 'EclipseLauncher/0.2.2' } });
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
          installed: true,
          image: imagePath && fs.existsSync(imagePath) ? imagePath : null
        };
      });
    return folders;
  });

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

  ipcMain.handle('instance:launch', async (_, instance) => {
    const instanceDir = path.join(instancesDir, instance.folder);
    if (!fs.existsSync(instanceDir)) throw new Error('Instance is not installed.');

    const launcher = new Client();
    const settings = readSettings();
    const profile = settings.profile;
    const microsoftSession = profile.type === 'microsoft' ? await refreshMicrosoftSession(profile, settings) : null;
    const username = microsoftSession?.name || profile.name || 'Steve';

    const opts = {
      authorization: {
        access_token: microsoftSession?.accessToken || '',
        client_token: '',
        uuid: microsoftSession?.uuid || '',
        name: username,
        user_properties: '{}',
        meta: microsoftSession
          ? { type: 'msa', demo: false, xuid: microsoftSession.xuid, clientId: settings.microsoftClientId }
          : { type: 'mojang', demo: false }
      },
      root: instanceDir,
      version: {
        number: instance.version,
        type: 'release'
      },
      memory: { min: '1G', max: '4G' }
    };

    launcher.on('debug', msg => console.log('[Minecraft]', msg));
    launcher.on('data', msg => console.log('[Minecraft]', msg));

    await launcher.launch(opts);
    return { ok: true };
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
