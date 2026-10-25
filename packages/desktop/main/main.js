// Tether for Windows: the app people install instead of the CLI. It keeps the background service
// running, lives in the tray, opens a window that does everything the CLI does, adds a Tether
// submenu to Explorer, and updates itself from GitHub Releases.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification } from 'electron';
import updaterPkg from 'electron-updater';
import { ensureService, request, stopService, VERSION } from './service.js';
import { registerExplorerMenu, unregisterExplorerMenu, explorerMenuInstalled, parseAction } from './explorer.js';
import { findRepo } from '../../client/src/git.js';

// (the packaged app runs this file bundled as CommonJS, where __dirname exists and import.meta does not)
const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const asset = (f) => path.join(app.getAppPath(), 'assets', f);
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const LOGIN_NAME = 'TetherApp'; // not "Tether": the npm CLI uses that Run value for its own daemon
// Test mode (TETHER_DESKTOP_TEST=1, with TETHER_HOME/TETHER_SERVER pointing at a test setup): no
// registry changes (Explorer menu, start at login), no update checks, separate app data.
const TEST = !!process.env.TETHER_DESKTOP_TEST;
if (TEST && process.env.TETHER_HOME) app.setPath('userData', path.join(process.env.TETHER_HOME, 'desktop'));

let win = null;
let tray = null;
let quitting = false;
let pendingAction = parseAction(process.argv);
let updateState = { status: 'idle' };
let hiddenNoticeShown = false;

function prefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function savePrefs(p) {
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify({ ...prefs(), ...p }, null, 2));
}

// ---------------------------------------------------------------- window
function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 760, minHeight: 540, show: false,
    title: 'Tether', icon: asset('icon.png'), backgroundColor: '#f6f8f8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  if (process.env.TETHER_RENDERER_URL) win.loadURL(process.env.TETHER_RENDERER_URL);
  else win.loadFile(path.join(app.getAppPath(), 'renderer', 'dist', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') || pendingAction) win.show();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // closing the window keeps Tether syncing in the tray
    win.hide();
    if (!hiddenNoticeShown && Notification.isSupported()) {
      hiddenNoticeShown = true;
      new Notification({ title: 'Tether is still syncing', body: 'Tether keeps your files in sync in the background. Open it from the tray icon next to the clock.', icon: asset('icon.png') }).show();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

function sendAction(a) {
  showWindow();
  const deliver = () => win.webContents.send('action', a);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
  else deliver();
}

// ---------------------------------------------------------------- tray
async function refreshTray() {
  if (!tray) return;
  let line = 'Starting…';
  try {
    const s = await request('status');
    const live = s.instances.filter((i) => !i.folderInstanceId && i.mode !== 'orphaned');
    const editing = live.filter((i) => i.mode === 'editing').length;
    const problems = s.instances.filter((i) => i.missing || i.lastError || i.detached).length;
    if (!s.user) line = 'Not signed in';
    else if (s.offline) line = 'Offline: changes sync when you are back online';
    else if (problems) line = `${problems} item${problems === 1 ? ' needs' : 's need'} attention`;
    else if (editing) line = `${editing} item${editing === 1 ? '' : 's'} being changed`;
    else line = live.length ? 'Everything is in sync' : 'Nothing shared yet';
  } catch {
    line = 'Background service is not running';
  }
  tray.setToolTip(`Tether: ${line}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: line, enabled: false },
    { type: 'separator' },
    { label: 'Open Tether', click: showWindow },
    { label: 'Sync now', click: () => request('sync').then(refreshTray, () => {}) },
    { type: 'separator' },
    { label: 'Quit Tether (stops syncing)', click: quitAll },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.on('click', showWindow);
  refreshTray();
  setInterval(refreshTray, 15000).unref();
}

async function quitAll() {
  quitting = true;
  await stopService();
  app.quit();
}

// ---------------------------------------------------------------- updates (GitHub Releases)
function setUpdate(s) {
  updateState = s;
  win?.webContents.send('update', s);
}
function setupUpdater() {
  if (!app.isPackaged) return setUpdate({ status: 'development' });
  const { autoUpdater } = updaterPkg;
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'current' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: e.message }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

// ---------------------------------------------------------------- bridge for the window
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: { message: e.message, code: e.code, status: e.status } };
    }
  });
}

function registerBridge() {
  handle('tether', (method, params) => request(method, params));
  handle('login:browser', async () => {
    const { url, state } = await request('login.start');
    await shell.openExternal(url);
    return request('login.wait', { state });
  });
  handle('pick', async ({ kind = 'file', title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: [kind === 'folder' ? 'openDirectory' : 'openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open', (p) => shell.openPath(p));
  handle('reveal', (p) => shell.showItemInFolder(p));
  handle('external', (url) => shell.openExternal(url));
  handle('gitRepoOf', (p) => findRepo(p)?.root ?? null);
  handle('info', () => ({
    version: VERSION, appVersion: app.getVersion(), packaged: app.isPackaged,
    openAtLogin: app.getLoginItemSettings({ name: LOGIN_NAME }).openAtLogin,
    explorerMenu: explorerMenuInstalled(), update: updateState, documents: app.getPath('documents'),
  }));
  handle('takeAction', () => {
    const a = pendingAction;
    pendingAction = null;
    return a;
  });
  handle('setOpenAtLogin', (on) => !TEST && app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'], name: LOGIN_NAME }));
  handle('setExplorerMenu', (on) => {
    savePrefs({ explorerMenu: !!on });
    if (TEST) return;
    if (on) registerExplorerMenu();
    else unregisterExplorerMenu();
  });
  handle('checkUpdate', () => (app.isPackaged ? updaterPkg.autoUpdater.checkForUpdates() : null));
  handle('installUpdate', async () => {
    quitting = true;
    await stopService(); // the service runs from this app's files; stop it so they can be replaced
    updaterPkg.autoUpdater.quitAndInstall(false, true);
  });
  handle('quit', quitAll);
}

// ---------------------------------------------------------------- start
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.tether.desktop');
  app.on('second-instance', (_e, argv) => {
    const a = parseAction(argv);
    if (a) sendAction(a);
    else showWindow();
  });
  app.on('window-all-closed', () => {}); // stay in the tray
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(async () => {
    registerBridge();
    const p = prefs();
    if (!p.initialized && !TEST) {
      // first run: start with Windows (in the tray) and add the Explorer menu
      app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'], name: LOGIN_NAME });
      savePrefs({ initialized: true, explorerMenu: true });
    }
    if (prefs().explorerMenu && !TEST) {
      try {
        registerExplorerMenu(); // refreshed every start, so it always points at this app
      } catch {
        // registry not writable: the app still works without the menu
      }
    }
    createTray();
    createWindow();
    try {
      await ensureService();
    } catch (e) {
      dialog.showErrorBox('Tether', `${e.message}\n\nTry restarting your computer. If it keeps happening, reinstall Tether.`);
    }
    refreshTray();
    if (!TEST) setupUpdater();
    if (pendingAction) showWindow(); // the window fetches it (takeAction) once it is ready
  });
}
