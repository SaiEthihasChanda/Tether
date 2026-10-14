// Phase 1: identity tracking on Windows (OpenFileById), reverts, atomic saves, deletes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setup, manage } from './helpers/setup.js';
import { Machine, eventually, sleep } from './helpers/machine.js';

const isWindows = process.platform === 'win32';
let t, owner, viewer, shareId;

before(async () => {
  t = await setup(['owner', 'viewer']);
  ({ owner, viewer } = t);
  owner.write('cfg.txt', 'line one\nline two\n');
  shareId = await manage(owner, 'cfg.txt');
  await viewer.run(['pull', shareId]);
});
after(() => t?.teardown());

const ORIGINAL = 'line one\r\nline two\r\n';
const statusOf = async (m, artifactPathEnd) => (await m.status()).instances.find((i) => i.path.endsWith(artifactPathEnd));

test('renames and moves are followed, and reverts happen at the new location', async () => {
  fs.renameSync(viewer.p('cfg.txt'), viewer.p('renamed.txt'));
  fs.mkdirSync(viewer.p('deep', 'er'), { recursive: true });
  fs.renameSync(viewer.p('renamed.txt'), viewer.p('deep', 'er', 'moved.txt'));
  fs.writeFileSync(viewer.p('deep', 'er', 'moved.txt'), 'tampered\n');
  await viewer.sync();
  assert.equal(viewer.read('deep/er/moved.txt'), ORIGINAL);
  assert.ok(await statusOf(viewer, path.join('deep', 'er', 'moved.txt')));
  assert.match(await viewer.log(), /followed move/);
});

test('moves made while the daemon is stopped are found at startup', async () => {
  await viewer.ipc('shutdown');
  await sleep(500);
  fs.renameSync(viewer.p('deep', 'er', 'moved.txt'), viewer.p('offline-move.txt'));
  await viewer.start();
  await viewer.sync();
  const s = await statusOf(viewer, 'offline-move.txt');
  assert.equal(s?.mode, 'normal');
});

test('an atomic save (write temp, rename over) is re-linked and reverted, not treated as a delete', async () => {
  const p = viewer.p('offline-move.txt');
  fs.writeFileSync(p + '.tmp', 'atomic edit\n');
  fs.renameSync(p + '.tmp', p);
  await viewer.sync();
  assert.equal(viewer.read('offline-move.txt'), ORIGINAL);
  const s = await statusOf(viewer, 'offline-move.txt');
  assert.equal(s.mode, 'normal');
  assert.match(await viewer.log(), /re-linked after an atomic save/);
});

test('a backup-rename save (vim style) follows the path, not the backup', async () => {
  const p = viewer.p('offline-move.txt');
  fs.renameSync(p, p + '~');
  fs.writeFileSync(p, 'vim edit\n');
  await viewer.sync(); // the old ID now lives at file~
  fs.rmSync(p + '~');
  await viewer.sync();
  assert.equal(viewer.read('offline-move.txt'), ORIGINAL);
  assert.equal((await statusOf(viewer, 'offline-move.txt'))?.mode, 'normal');
});

test('a copy is not managed', async () => {
  fs.copyFileSync(viewer.p('offline-move.txt'), viewer.p('copy.txt'));
  fs.writeFileSync(viewer.p('copy.txt'), 'my own copy\n');
  await viewer.sync();
  assert.equal(viewer.read('copy.txt'), 'my own copy\n');
  assert.equal(await statusOf(viewer, 'copy.txt'), undefined);
});

test('incoming changes reach a moved copy; the copy keeps its own line endings', async () => {
  await owner.run(['edit', 'cfg.txt']);
  owner.write('cfg.txt', 'line one\nline two\nline three\n');
  await owner.run(['done', 'cfg.txt']);
  await viewer.sync();
  assert.equal(viewer.read('offline-move.txt'), 'line one\r\nline two\r\nline three\r\n');
  assert.equal(owner.read('cfg.txt'), 'line one\nline two\nline three\n');
});

test('a second pull of the same artifact is a separate instance', async () => {
  await viewer.run(['pull', shareId, 'second.txt']);
  const s = (await viewer.status()).instances.filter((i) => !i.folderInstanceId);
  assert.equal(s.length, 2);
  assert.notEqual(s[0].instanceId, s[1].instanceId);
  assert.equal(s[0].artifactId, s[1].artifactId);
  fs.writeFileSync(viewer.p('second.txt'), 'x');
  await viewer.sync();
  assert.equal(viewer.read('second.txt'), viewer.read('offline-move.txt'));
});

test('a deleted file is forgotten after the grace window; nothing changes on the server', async () => {
  fs.rmSync(viewer.p('second.txt'));
  await viewer.sync(); // starts the grace window
  await eventually(async () => !(await statusOf(viewer, 'second.txt')), { message: 'second.txt to be forgotten' });
  assert.equal(viewer.exists('second.txt'), false);
  const h = await owner.run(['history', 'cfg.txt']);
  assert.doesNotMatch(h.stdout, /delete/);
});

test('deleting to the Recycle Bin counts as a delete', { skip: !isWindows }, async () => {
  await viewer.run(['pull', shareId, 'trash-me.txt']);
  const p = viewer.p('trash-me.txt');
  execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${p}','OnlyErrorDialogs','SendToRecycleBin')`]);
  assert.equal(fs.existsSync(p), false);
  await viewer.sync();
  await eventually(async () => !(await statusOf(viewer, 'trash-me.txt')), { message: 'trash-me.txt to be forgotten' });
});

test('a locked file is retried on the next tick', { skip: !isWindows }, async () => {
  const p = viewer.p('offline-move.txt');
  fs.writeFileSync(p, 'edited then locked\n');
  // Hold the file open with no sharing, like some editors do.
  const holder = spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${p}','Open','ReadWrite','None'); Write-Output locked; Start-Sleep -Seconds 4; $f.Close()`]);
  await new Promise((r) => holder.stdout.once('data', r));
  await viewer.sync();
  const s = await statusOf(viewer, 'offline-move.txt');
  assert.ok(s.flags.some((f) => /locked/.test(f)), JSON.stringify(s.flags));
  await new Promise((r) => holder.on('exit', r));
  await viewer.sync();
  assert.equal(viewer.read('offline-move.txt'), 'line one\r\nline two\r\nline three\r\n');
});

test('reverts work offline from the local blob cache', async () => {
  const server = (await viewer.ipc('config.get', { key: 'server' })).server;
  await viewer.run(['config', 'set', 'server', 'http://127.0.0.1:9']);
  try {
    fs.writeFileSync(viewer.p('offline-move.txt'), 'offline tamper\n');
    const r = await viewer.run(['sync']);
    assert.match(r.stdout, /offline/);
    assert.equal(viewer.read('offline-move.txt'), 'line one\r\nline two\r\nline three\r\n');
  } finally {
    await viewer.run(['config', 'set', 'server', server]);
  }
});

test('the timer ticks on its own', async () => {
  const fast = await new Machine(t.srv.url, 'fast', { tickSeconds: 1 }).start();
  try {
    await fast.run(['login', '--email', 'fast@example.com', '--password', 'password123', '--signup']);
    await fast.run(['pull', shareId]);
    fs.writeFileSync(fast.p('cfg.txt'), 'nope');
    await eventually(() => fast.read('cfg.txt') !== 'nope', { timeout: 8000, message: 'timer revert' });
  } finally {
    await fast.stop();
  }
});
