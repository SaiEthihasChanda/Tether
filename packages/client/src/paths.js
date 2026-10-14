// Where the client keeps its state, and how the CLI reaches the daemon.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const isWindows = process.platform === 'win32';

/** Client state directory; TETHER_HOME overrides it (used to run several clients on one machine). */
export function tetherHome() {
  if (process.env.TETHER_HOME) return path.resolve(process.env.TETHER_HOME);
  if (isWindows) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Tether');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'tether');
}

/** Named pipe (Windows) or Unix socket the daemon listens on, unique per state directory. */
export function ipcEndpoint(home = tetherHome()) {
  const tag = crypto.createHash('sha1').update(home.toLowerCase()).digest('hex').slice(0, 12);
  if (isWindows) return `\\\\.\\pipe\\tether-${os.userInfo().username}-${tag}`;
  return path.join(home, 'tetherd.sock');
}

export const files = (home = tetherHome()) => ({
  db: path.join(home, 'tether.db'),
  blobs: path.join(home, 'blobs'),
  config: path.join(home, 'config.json'),
  credentials: path.join(home, isWindows ? 'credentials.bin' : 'credentials.json'),
  log: path.join(home, 'tetherd.log'),
  pid: path.join(home, 'tetherd.pid'),
});
