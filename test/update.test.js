// `tether update` end to end: install 0.x from a tarball, offer a newer version through a
// stub registry, update in place, and check the daemon restarts on the new code.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
let tmp, registry, env;

function npm(args, cwd) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(cli)
    ? execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
    : execFileSync('npm', args, { cwd, encoding: 'utf8', shell: isWindows });
}
const tether = (prefix, args) => new Promise((resolve) => {
  const bin = isWindows ? path.join(prefix, 'node_modules', 'tether-sync', 'bin', 'tether.js') : path.join(prefix, 'lib', 'node_modules', 'tether-sync', 'bin', 'tether.js');
  execFile(process.execPath, [bin, ...args], { env, timeout: 240000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

before(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-update-')));
  npm(['run', 'build:cli'], root);
  const current = JSON.parse(fs.readFileSync(path.join(root, 'dist/npm/package.json'), 'utf8')).version;
  // the "new" release: same build, version bumped
  fs.cpSync(path.join(root, 'dist/npm'), path.join(tmp, 'next'), { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(tmp, 'next/package.json'), 'utf8'));
  pj.version = '99.0.0';
  fs.writeFileSync(path.join(tmp, 'next/package.json'), JSON.stringify(pj, null, 2));
  npm(['pack', '--pack-destination', tmp], path.join(root, 'dist/npm'));
  npm(['pack', '--pack-destination', tmp], path.join(tmp, 'next'));
  npm(['install', '-g', '--prefix', path.join(tmp, 'prefix'), path.join(tmp, `tether-sync-${current}.tgz`)], tmp);
  registry = http.createServer((req, res) => res.end(JSON.stringify({ name: 'tether-sync', version: '99.0.0' })));
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  env = {
    ...process.env,
    TETHER_HOME: path.join(tmp, 'home'),
    TETHER_SERVER: 'http://127.0.0.1:9',
    TETHER_UPDATE_REGISTRY: `http://127.0.0.1:${registry.address().port}`,
    TETHER_UPDATE_SPEC: path.join(tmp, 'tether-sync-99.0.0.tgz'),
  };
});
after(async () => {
  await tether(path.join(tmp, 'prefix'), ['daemon', 'stop']);
  registry?.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('update --check reports a newer version', async () => {
  const r = await tether(path.join(tmp, 'prefix'), ['update', '--check']);
  assert.match(r.stdout, /update available: \S+ -> 99\.0\.0/);
});

test('update replaces the install and restarts the daemon on the new code', { timeout: 300000 }, async () => {
  const prefix = path.join(tmp, 'prefix');
  const before = await tether(prefix, ['daemon', 'start']);
  const oldPid = before.stdout.match(/pid (\d+)/)[1];
  const r = await tether(prefix, ['update']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /updated to 99\.0\.0/);
  const pkgDir = isWindows ? path.join(prefix, 'node_modules', 'tether-sync') : path.join(prefix, 'lib', 'node_modules', 'tether-sync');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '99.0.0');
  let status = '';
  for (let i = 0; i < 50 && !/running: pid/.test(status); i++) {
    await new Promise((res) => setTimeout(res, 200));
    status = (await tether(prefix, ['daemon', 'status'])).stdout;
  }
  assert.match(status, /running: pid (\d+)/);
  assert.notEqual(status.match(/running: pid (\d+)/)[1], oldPid);
});

test('a development checkout refuses to self-update', async () => {
  const r = await new Promise((resolve) => execFile(process.execPath, [path.join(root, 'packages/client/bin/tether.js'), 'update'], { env }, (err, stdout, stderr) => resolve({ stdout, stderr })));
  assert.match(r.stderr, /development copy/);
});
