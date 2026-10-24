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
    downloadSkin: profileId => ipcRenderer.invoke('profile:download-skin', profileId),
    loginMicrosoft: clientId => ipcRenderer.invoke('accounts:login-microsoft', clientId),
    openRegistration: () => ipcRenderer.invoke('accounts:open-registration')
  },
  background: {
    choose: () => ipcRenderer.invoke('background:choose')
  },
  instances: {
    list: () => ipcRenderer.invoke('instances:list'),
    rename: (folder, name) => ipcRenderer.invoke('instance:rename', folder, name),
    launch: instance => ipcRenderer.invoke('instance:launch', instance)
  },
  news: {
    list: options => ipcRenderer.invoke('news:list', options),
    open: url => ipcRenderer.invoke('news:open', url)
  }
});
