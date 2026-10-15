// The web console in a real browser (installed Edge/Chrome via playwright-core),
// including the `tether login` browser hand-off.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, TestUser } from './helpers/server.js';
import { Machine } from './helpers/machine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consoleDir = path.join(root, 'packages/console/dist');
const shots = process.env.TETHER_SCREENSHOTS;
const browserPath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
const skip = !browserPath ? 'no Chrome/Edge installed' : !fs.existsSync(path.join(consoleDir, 'index.html')) ? 'console not built (npm run console:build)' : false;

let srv, cli, browser, page;
const shot = async (p, name, opts = {}) => shots && p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true, ...opts });

before(async () => {
  if (skip) return;
  const { chromium } = await import('playwright-core');
  srv = await startTestServer({ consoleDir });
  cli = await new Machine(srv.url, 'web').start();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
  await cli?.stop();
  await srv?.stop();
});

test('sign up and create a repository', { skip }, async () => {
  await page.goto(srv.url);
  await shot(page, 'signin');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill('web@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Your repositories' }).waitFor();
  await shot(page, 'dashboard-empty');
  await page.getByRole('link', { name: 'New repository' }).click();
  await page.getByLabel('Repository name').fill('docs');
  await shot(page, 'new-repo');
  await page.getByRole('button', { name: 'Create repository' }).click();
  await page.getByText('This repository is empty').waitFor();
});

test('tether login completes through the console', { skip }, async () => {
  const { url, state } = await cli.ipc('login.start');
  assert.match(url, /\/cli-login\?port=\d+&state=/);
  const waiting = cli.ipc('login.wait', { state });
  await page.goto(url);
  await page.getByText('Sign in the Tether CLI?').waitFor();
  await shot(page, 'cli-login');
  await page.getByRole('button', { name: 'Authorize CLI' }).click();
  await page.getByText('Tether CLI signed in').waitFor();
  assert.equal((await waiting).email, 'web@example.com');
  assert.match((await cli.run(['whoami'])).stdout, /web@example.com/);
});

test('a forged callback with the wrong state is rejected', { skip }, async () => {
  const { url } = await cli.ipc('login.start');
  const port = new URL(url).searchParams.get('port');
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
  assert.equal(res.status, 400);
});

test('repository, file preview, sharing, and history', { skip }, async () => {
  const friend = await new TestUser(srv.url).signup('friend@example.com');
  cli.write('guide.md', '# Guide\n\nHow we work.\n');
  await cli.run(['manage', 'guide.md', '--repo', 'docs']);
  cli.write('kit/README.md', '# kit\n');
  cli.write('kit/src/app.js', 'console.log(1);\n');
  cli.write('kit/logo.bin', '\u0000\u0001');
  await cli.run(['manage', 'kit', '--repo', 'docs']);
  await cli.run(['edit', 'guide.md']);
  cli.write('guide.md', '# Guide\n\nHow we work, v2.\n');
  await cli.run(['done', 'guide.md']);

  await page.goto(srv.url);
  await page.getByRole('link', { name: /docs/ }).first().click();
  await page.getByRole('link', { name: 'guide.md' }).waitFor();
  await shot(page, 'repo');

  // folder browser
  await page.getByRole('link', { name: 'kit', exact: true }).click();
  await page.getByRole('link', { name: 'src' }).click();
  await page.getByRole('link', { name: 'app.js' }).waitFor();
  await page.goBack();
  await page.getByRole('link', { name: 'logo.bin' }).click();
  await page.getByText('Binary file not shown.').waitFor();

  // file view with line numbers
  await page.goto(srv.url);
  await page.getByRole('link', { name: /docs/ }).first().click();
  await page.getByRole('link', { name: 'guide.md' }).click();
  const code = page.getByRole('table', { name: 'File content' });
  await code.getByText('How we work, v2.').waitFor();
  await shot(page, 'file');

  // sharing: add an editor, who can then pull as an editor
  await page.getByRole('link', { name: 'Sharing' }).click();
  const shareId = (await page.getByTestId('share-id').textContent()).trim();
  await page.getByLabel('Email address to add').fill('friend@example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('listitem', { name: 'friend@example.com' }).waitFor();
  await shot(page, 'sharing');
  assert.equal((await friend.call('POST', '/pull', { shareId })).role, 'editor');

  // history: restore v1 for everyone
  await page.getByRole('link', { name: /History/ }).click();
  await page.getByRole('listitem', { name: 'v2 Updated content' }).waitFor();
  await page.getByRole('listitem', { name: 'v1 Created' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('listitem', { name: 'v3 Restored v1' }).waitFor();
  await shot(page, 'history');
  await cli.sync();
  assert.equal(cli.read('guide.md').replace(/\r\n/g, '\n'), '# Guide\n\nHow we work.\n');

  // rotate the share ID
  await page.getByRole('link', { name: 'Sharing' }).click();
  await page.getByRole('button', { name: 'Rotate' }).click();
  await page.waitForFunction((old) => document.querySelector('[data-testid="share-id"]')?.textContent.trim() !== old, shareId);

  if (shots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('link', { name: 'Code' }).click();
    await shot(page, 'file-mobile');
    await page.setViewportSize({ width: 1280, height: 860 });
  }
});

test('shared-with-me, editor view, dark mode', { skip }, async () => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await p.goto(srv.url);
  await p.getByLabel('Email').fill('friend@example.com');
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('heading', { name: 'Shared with you' }).waitFor();
  await shot(p, 'dashboard-dark');
  await p.getByRole('link', { name: 'guide.md' }).click();
  await p.getByText('you are editor').waitFor();
  assert.equal(await p.getByRole('link', { name: 'Sharing' }).count(), 0); // editors don't manage sharing
  await p.reload();
  await p.getByRole('link', { name: /History/ }).click();
  await p.getByRole('listitem', { name: /v3 Restored v1/ }).waitFor();
  assert.equal(await p.getByRole('button', { name: 'Restore' }).count(), 0); // only the owner restores
  await shot(p, 'history-dark');
  await p.getByRole('button', { name: 'Account menu' }).click();
  await p.getByRole('button', { name: 'Sign out' }).click();
  await p.getByRole('heading', { name: 'Sign in to Tether' }).waitFor();
  await p.close();
});
