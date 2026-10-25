// The only bridge between the window and the rest of the app: a small, fixed set of calls.
// Every call resolves to its value or throws an Error carrying the daemon's message, code and status.
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.ok) return r.value;
  const e = new Error(r.error.message);
  e.code = r.error.code;
  e.status = r.error.status;
  throw e;
}

contextBridge.exposeInMainWorld('tether', {
  call: (method, params) => invoke('tether', method, params),
  loginWithBrowser: () => invoke('login:browser'),
  pick: (opts) => invoke('pick', opts),
  open: (p) => invoke('open', p),
  reveal: (p) => invoke('reveal', p),
  external: (url) => invoke('external', url),
  gitRepoOf: (p) => invoke('gitRepoOf', p),
  info: () => invoke('info'),
  takeAction: () => invoke('takeAction'),
  setOpenAtLogin: (on) => invoke('setOpenAtLogin', on),
  setExplorerMenu: (on) => invoke('setExplorerMenu', on),
  checkUpdate: () => invoke('checkUpdate'),
  installUpdate: () => invoke('installUpdate'),
  quit: () => invoke('quit'),
  onAction: (fn) => ipcRenderer.on('action', (_e, a) => fn(a)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, s) => fn(s)),
  // files dropped on the window: Electron's webUtils gives their real paths
  pathOf: (file) => require('electron').webUtils.getPathForFile(file),
});
