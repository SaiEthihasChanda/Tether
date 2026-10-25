// The background service (tetherd): the desktop app runs the daemon it ships with, using its own
// Electron binary as Node (ELECTRON_RUN_AS_NODE), so nobody needs Node.js installed. A daemon that
// is already running (for example one started by the npm CLI) is reused when it is at least as new;
// an older one is asked to stop and replaced.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { call, IpcError } from '../../client/src/ipc.js';
import { ipcEndpoint, tetherHome } from '../../client/src/paths.js';
import { isNewer } from '../../client/src/update.js';
import { VERSION } from '../../client/src/version.js';

export { VERSION };

/** Where the daemon entry point lives: packaged (resources/tether) or this repository (development). */
export function daemonEntry() {
  const packaged = path.join(process.resourcesPath ?? '', 'tether', 'bin', 'tetherd.js');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.resolve(app.getAppPath(), '..', 'client', 'bin', 'tetherd.js');
}

const endpoint = () => ipcEndpoint();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ping(timeout = 2000) {
  try {
    return await call(endpoint(), 'ping', {}, timeout);
  } catch (e) {
    if (e instanceof IpcError && (e.code === 'ENODAEMON' || e.code === 'ETIMEDOUT')) return null;
    throw e;
  }
}

function spawnBundled() {
  const home = tetherHome();
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [daemonEntry(), '--home', home], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: home,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
}

async function waitFor(pred, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await pred()) return true;
  return false;
}

/** Makes sure a daemon at least as new as this app is running. Returns its ping answer. */
export async function ensureService() {
  let p = await ping();
  if (p && isNewer(VERSION, p.version)) {
    await call(endpoint(), 'shutdown', {}, 3000).catch(() => {});
    await waitFor(async () => !(await ping(500)));
    p = null;
  }
  if (!p) {
    spawnBundled();
    if (!(await waitFor(async () => !!(await ping(1000))))) throw new Error('The Tether background service did not start.');
    p = await ping();
  }
  return p;
}

/** Calls the daemon, restarting it once if it has gone away. Errors keep message/code/status. */
export async function request(method, params = {}) {
  try {
    return await call(endpoint(), method, params);
  } catch (e) {
    if (e instanceof IpcError && e.code === 'ENODAEMON') {
      await ensureService();
      return call(endpoint(), method, params);
    }
    throw e;
  }
}

export async function stopService() {
  await call(endpoint(), 'shutdown', {}, 3000).catch(() => {});
  await waitFor(async () => !(await ping(500)), 8000);
}
