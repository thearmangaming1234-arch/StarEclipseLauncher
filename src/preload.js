const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eclipse', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch)
  },
  accounts: {
    addOffline: name => ipcRenderer.invoke('profile:add-offline', name),
    select: profileId => ipcRenderer.invoke('profile:select', profileId),
    remove: profileId => ipcRenderer.invoke('profile:remove', profileId),
    setNote: (profileId, note) => ipcRenderer.invoke('profile:set-note', profileId, note),
    skinUrl: profileId => ipcRenderer.invoke('profile:skin-url', profileId),
    skinData: profileId => ipcRenderer.invoke('profile:skin-data', profileId),
    downloadSkin: profileId => ipcRenderer.invoke('profile:download-skin', profileId),
    loginMicrosoft: clientId => ipcRenderer.invoke('accounts:login-microsoft', clientId),
    openRegistration: () => ipcRenderer.invoke('accounts:open-registration')
  },
  background: {
    choose: () => ipcRenderer.invoke('background:choose')
  },
  instances: {
    list: () => ipcRenderer.invoke('instances:list'),
    install: folder => ipcRenderer.invoke('instance:install', folder),
    deleteFiles: folder => ipcRenderer.invoke('instance:delete-files', folder),
    resetPlaytime: folder => ipcRenderer.invoke('instance:reset-playtime', folder),
    onInstallProgress: callback => {
      const listener = (_, progress) => callback(progress);
      ipcRenderer.on('instance:install-progress', listener);
      return () => ipcRenderer.removeListener('instance:install-progress', listener);
    },
    onLaunchStatus: callback => {
      const listener = (_, status) => callback(status);
      ipcRenderer.on('instance:launch-status', listener);
      return () => ipcRenderer.removeListener('instance:launch-status', listener);
    },
    rename: (folder, name) => ipcRenderer.invoke('instance:rename', folder, name),
    launch: instance => ipcRenderer.invoke('instance:launch', instance)
  },
  mods: {
    list: folder => ipcRenderer.invoke('mods:list', folder),
    openFolder: folder => ipcRenderer.invoke('mods:open-folder', folder),
    setEnabled: (folder, fileName, enabled) => ipcRenderer.invoke('mods:set-enabled', folder, fileName, enabled),
    remove: (folder, fileName) => ipcRenderer.invoke('mods:remove', folder, fileName),
    search: (folder, query) => ipcRenderer.invoke('mods:search', folder, query),
    install: (folder, projectId) => ipcRenderer.invoke('mods:install', folder, projectId),
    onInstallProgress: callback => {
      const listener = (_, progress) => callback(progress);
      ipcRenderer.on('mods:install-progress', listener);
      return () => ipcRenderer.removeListener('mods:install-progress', listener);
    }
  },
  news: {
    list: options => ipcRenderer.invoke('news:list', options),
    open: url => ipcRenderer.invoke('news:open', url)
  }
});
