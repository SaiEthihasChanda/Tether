// Starting tetherd: on demand from the CLI, and at login (DESIGN §9).
//   Windows: HKCU Run key, launched through `conhost --headless` so no console window appears.
//   Linux:   a systemd --user unit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isWindows, tetherHome } from './paths.js';

export const daemonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/tetherd.js');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const runValue = () => process.env.TETHER_RUN_VALUE || 'Tether'; // overridable for tests
const unitFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'tetherd.service');

/** Starts the daemon in the background, detached from the terminal. */
export function spawnDaemon() {
  const child = spawn(process.execPath, [daemonScript, '--home', tetherHome()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: tetherHome(), // never hold the caller's folder open
    env: process.env,
  });
  child.unref();
}

export function install() {
  const home = tetherHome();
  if (isWindows) {
    const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
    const cmd = `"${conhost}" --headless "${process.execPath}" "${daemonScript}" --home "${home}"`;
    execFileSync('reg.exe', ['add', RUN_KEY, '/v', runValue(), '/t', 'REG_SZ', '/d', cmd, '/f'], { stdio: 'pipe' });
    return { method: 'registry Run key', command: cmd };
  }
  const unit = `[Unit]
Description=Tether sync daemon

[Service]
ExecStart=${process.execPath} ${daemonScript} --home ${home}
Restart=on-failure
Environment=TETHER_SERVER=${process.env.TETHER_SERVER ?? ''}

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
  fs.writeFileSync(unitFile(), unit);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'tetherd.service']);
  return { method: 'systemd --user', unit: unitFile() };
}

export function uninstall() {
  if (isWindows) {
    try {
      execFileSync('reg.exe', ['delete', RUN_KEY, '/v', runValue(), '/f'], { stdio: 'pipe' });
    } catch {
      // not installed
    }
    return { removed: true };
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'tetherd.service'], { stdio: 'pipe' });
  } catch {
    // not installed
  }
  fs.rmSync(unitFile(), { force: true });
  return { removed: true };
}

export function installed() {
  return !!installedCommand();
}

/** The command registered to run at login, or null. */
export function installedCommand() {
  if (isWindows) {
    try {
      const out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', runValue()], { stdio: 'pipe' }).toString();
      const m = out.match(/REG_SZ\s+(.+)/);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  }
  return fs.existsSync(unitFile()) ? fs.readFileSync(unitFile(), 'utf8').match(/ExecStart=(.+)/)?.[1] ?? null : null;
}
