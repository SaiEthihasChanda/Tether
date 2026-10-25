// The desktop app (Electron) driven like a person would use it, against a local test server, next
// to a second user on the CLI. Test mode keeps it away from the real Tether setup and registry.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers/server.js';
import { Machine, eventually } from './helpers/machine.js';
import { call } from '../packages/client/src/ipc.js';
import { ipcEndpoint } from '../packages/client/src/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'packages/desktop');
const require = createRequire(import.meta.url);
let electronPath = null;
try { electronPath = require(path.join(desktop, 'node_modules/electron')); } catch { try { electronPath = require('electron'); } catch { /* not installed */ } }
// TETHER_DESKTOP_EXE=<path to Tether.exe>: test the packaged app instead of the development copy
const packagedExe = process.env.TETHER_DESKTOP_EXE;
const skip = packagedExe ? (fs.existsSync(packagedExe) ? false : `${packagedExe} not found`) : !electronPath ? 'electron not installed' : !fs.existsSync(path.join(desktop, 'renderer/dist/index.html')) ? 'desktop renderer not built (npm run build:renderer -w @tether/desktop)' : false;
const shots = process.env.TETHER_SCREENSHOTS;
const lf = (s) => s.replace(/\r\n/g, '\n');

let srv, bob, app, page, home, work;
const shot = async (name) => shots && page.screenshot({ path: path.join(shots, `desktop-${name}.png`) });
/** The next file/folder dialog returns this path (dialogs cannot be clicked by a test). */
const nextPick = (p) => app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }); }, p);
const appDaemon = (method, params) => call(ipcEndpoint(home), method, params);

before(async () => {
  if (skip) return;
  const { _electron } = await import('playwright-core');
  srv = await startTestServer();
  bob = await new Machine(srv.url, 'bob').start();
  await bob.run(['login', '--email', 'bob@example.com', '--password', 'password123', '--signup']);
  await bob.run(['repo', 'create', 'bobs']);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-desktop-home-'));
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-desktop-work-')));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: srv.url, tickSeconds: 3600, graceMs: 300, scanRoots: [work] }));
  app = await _electron.launch({
    executablePath: packagedExe ?? electronPath, args: packagedExe ? [] : [desktop],
    // (editors like VS Code export ELECTRON_RUN_AS_NODE=1, which would start Electron as plain Node)
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), TETHER_DESKTOP_TEST: '1', TETHER_HOME: home, TETHER_SERVER: srv.url, TETHER_MIN_TICK_SECONDS: '1', TETHER_NOTIFY_LOG: path.join(home, 'notify.log') },
  });
  page = await app.firstWindow();
  await page.setViewportSize?.({ width: 1180, height: 800 });
});
afterEach(async (t) => {
  if (shots && page && t.passed === false) await page.screenshot({ path: path.join(shots, `desktop-FAILED-${t.name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
});
after(async () => {
  await app?.evaluate(async ({ app: a }) => a.exit(0)).catch(() => {});
  if (home) await call(ipcEndpoint(home), 'shutdown', {}, 3000).catch(() => {});
  await bob?.stop();
  await srv?.stop();
});

test('first run: create an account with email and password', { skip }, async () => {
  await page.getByRole('heading', { name: 'Welcome to Tether' }).waitFor({ timeout: 30000 });
  await shot('signin');
  await page.getByRole('button', { name: 'Use email and password instead' }).click();
  await page.getByRole('button', { name: "I don't have an account yet" }).click();
  await page.getByLabel('Email').fill('ann@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Your files' }).waitFor();
  await page.getByText('Nothing here yet').waitFor();
  await shot('empty');
});

let code;
test('share a file: a collection is created for you, and you get a share code', { skip }, async () => {
  fs.writeFileSync(path.join(work, 'team.cfg'), 'one\n');
  await page.getByRole('button', { name: 'Share a file or folder' }).click();
  await nextPick(path.join(work, 'team.cfg'));
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('dialog').getByText(/team\.cfg/).waitFor();
  assert.equal(await page.getByLabel('Collection', { exact: true }).inputValue(), '__new');
  await shot('share');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  code = (await page.getByTestId('share-code').textContent()).trim();
  assert.match(code, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  await shot('shared');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('listitem', { name: 'team.cfg' }).getByText('In sync').waitFor();

  await bob.run(['pull', code]);
  assert.equal(lf(bob.read('team.cfg')), 'one\n');
});

test('make changes and press Done: the change reaches the other person', { skip }, async () => {
  const row = page.getByRole('listitem', { name: 'team.cfg' });
  await row.getByRole('button', { name: 'Make changes' }).click();
  await row.getByText('Making changes').waitFor();
  fs.writeFileSync(path.join(work, 'team.cfg'), 'two\n');
  await row.getByText('Changes not shared yet').waitFor();
  await shot('editing');
  await row.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('dialog', { name: 'Done' }).getByText(/Shared/).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await bob.sync();
  assert.equal(lf(bob.read('team.cfg')), 'two\n');
});

test('people: make someone an editor, then a conflict asks what to keep', { skip }, async () => {
  await page.getByRole('listitem', { name: 'team.cfg' }).getByRole('button', { name: /team\.cfg/ }).click();
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByLabel('Email address to add').fill('bob@example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('listitem', { name: 'bob@example.com' }).waitFor();
  await shot('people');
  await bob.sync();

  // both change it; bob shares first
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Make changes' }).click();
  fs.writeFileSync(path.join(work, 'team.cfg'), 'ann\n');
  await bob.run(['edit', 'team.cfg']);
  bob.write('team.cfg', 'bob\n');
  await bob.run(['done', 'team.cfg']);
  await page.getByRole('button', { name: 'Done' }).click();
  const dialog = page.getByRole('dialog', { name: 'One decision needed' });
  await dialog.getByText('someone else shared a newer version').waitFor();
  await dialog.getByRole('button', { name: 'Show the differences' }).click();
  await page.getByRole('dialog', { name: 'What changed in team.cfg' }).getByText('+ann').waitFor();
  await shot('diff');
  await page.getByRole('dialog', { name: 'What changed in team.cfg' }).getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.getByText('Keep both').click();
  await shot('decision');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await page.getByText(/Kept both/).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(lf(fs.readFileSync(path.join(work, 'team.cfg'), 'utf8')), 'bob\n');
  assert.equal(fs.readFileSync(path.join(work, 'team (local copy).cfg'), 'utf8'), 'ann\n');
});

test('history: go back to an earlier version for everyone', { skip }, async () => {
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('listitem', { name: 'Version 1' }).getByText('Shared for the first time').waitFor();
  await shot('history');
  await page.getByRole('listitem', { name: 'Version 1' }).getByRole('button', { name: 'Go back to this' }).click();
  await page.getByRole('dialog', { name: 'Go back to version 1?' }).getByRole('button', { name: 'Go back' }).click();
  await page.getByText('Now on version').waitFor();
  await bob.sync();
  assert.equal(lf(bob.read('team.cfg')), 'one\n');
});

test('devices: both computers are listed, and syncing can be stopped for bob', { skip }, async () => {
  await bob.sync(); // reports its copy
  await appDaemon('sync');
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.getByText(/2 copies/).waitFor({ timeout: 15000 });
  await shot('devices');
  const bobsDevice = page.getByRole('listitem', { name: new RegExp(`^bob@example.com on `) });
  await bobsDevice.getByRole('button', { name: 'Stop syncing here' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop syncing' }).click();
  await bob.sync();
  assert.equal((await bob.status()).instances.find((i) => i.path.endsWith('team.cfg')).mode, 'unmanaged');
});

test('open a share code from someone else and save it in a chosen folder', { skip }, async () => {
  bob.write('notes.md', '# from bob\n');
  const bobCode = (await bob.run(['manage', 'notes.md', '--repo', 'bobs'])).stdout.match(/share ID: (\S+)/)[1];
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Your files' }).click();
  await page.getByRole('button', { name: 'Open a share code' }).click();
  await page.getByLabel('Share code', { exact: true }).fill(bobCode);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByText('you can view it').waitFor();
  const inbox = path.join(work, 'inbox');
  fs.mkdirSync(inbox);
  await nextPick(inbox);
  await page.getByRole('button', { name: 'Change…' }).click();
  await page.getByText(inbox).waitFor();
  await shot('get');
  await page.getByRole('button', { name: 'Get it' }).click();
  await page.getByRole('heading', { name: "It's on your computer" }).waitFor();
  assert.equal(lf(fs.readFileSync(path.join(inbox, 'notes.md'), 'utf8')), '# from bob\n');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('listitem', { name: 'notes.md' }).getByText('In sync').waitFor();
  await shot('files');
});

test('stop syncing and sync again', { skip }, async () => {
  await page.getByRole('listitem', { name: 'notes.md' }).getByRole('button', { name: /notes\.md/ }).click();
  await page.getByRole('tab', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Stop syncing' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop syncing' }).click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByText('Not syncing').first().waitFor();
  await page.getByRole('button', { name: 'Sync again' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByText('In sync').first().waitFor();
});

test('settings: name this computer', { skip }, async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Computer name').fill('Ann laptop');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.getByText('Name saved.').waitFor();
  await shot('settings');
  await eventually(() => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).deviceName === 'Ann laptop', { message: 'device name saved' });
});
