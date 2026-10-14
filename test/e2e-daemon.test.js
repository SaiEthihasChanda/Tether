// Phase 7: daemon lifecycle - auto-start from the CLI, start at login (registry / systemd).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startTestServer } from './helpers/server.js';
import { Machine, eventually } from './helpers/machine.js';
import { installedCommand } from '../packages/client/src/autostart.js';

const isWindows = process.platform === 'win32';
let srv, m;

before(async () => {
  srv = await startTestServer();
  m = new Machine(srv.url, 'life');
  m.env.TETHER_RUN_VALUE = 'TetherTest';
  process.env.TETHER_RUN_VALUE = 'TetherTest';
  m.proc = { exitCode: 0, on() {}, kill() {} }; // no daemon started by the harness
});
after(async () => {
  await m.run(['daemon', 'uninstall'], { allowFail: true });
  await m.stop();
  await srv.stop();
});

test('any CLI command starts the daemon when it is not running', async () => {
  assert.match((await m.run(['daemon', 'status'])).stdout, /not running/);
  const r = await m.run(['login', '--email', 'life@example.com', '--password', 'password123', '--signup']);
  assert.match(r.stdout, /signed in/);
  assert.match((await m.run(['daemon', 'status'])).stdout, /running: pid \d+/);
});

test('daemon stop and restart', async () => {
  assert.match((await m.run(['daemon', 'stop'])).stdout, /stopped/);
  await eventually(async () => /not running/.test((await m.run(['daemon', 'status'])).stdout), { message: 'stopped' });
  assert.match((await m.run(['daemon', 'start'])).stdout, /tetherd running/);
  assert.match((await m.run(['whoami'])).stdout, /life@example.com/); // credentials survive restarts
});

test('a second daemon refuses to start', async () => {
  const second = spawn(process.execPath, ['packages/client/bin/tetherd.js'], { env: m.env });
  let err = '';
  second.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => second.on('exit', r));
  assert.equal(code, 0);
  assert.match(err, /already running/);
});

test('install registers start-at-login, and the registered command really starts tetherd headless', { skip: !isWindows }, async () => {
  const r = await m.run(['daemon', 'install']);
  assert.match(r.stdout, /installed \(registry Run key\)/);
  const cmd = installedCommand();
  assert.match(cmd, /conhost\.exe" --headless ".*node(\.exe)?" ".*tetherd\.js" --home/);
  assert.match((await m.run(['daemon', 'status'])).stdout, /start at login: yes/);

  // Simulate a login: stop the daemon, then run exactly what Windows would run.
  await m.run(['daemon', 'stop']);
  await eventually(async () => /not running/.test((await m.run(['daemon', 'status'])).stdout), { message: 'stopped' });
  // Launch it as a new top-level process, as Windows does for Run entries at login.
  spawn('cmd.exe', ['/d', '/c', `start "" ${cmd}`], { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
  await eventually(async () => /running: pid/.test((await m.run(['daemon', 'status'])).stdout), { timeout: 15000, message: 'login-started daemon' });

  await m.run(['daemon', 'uninstall']);
  assert.equal(installedCommand(), null);
});
