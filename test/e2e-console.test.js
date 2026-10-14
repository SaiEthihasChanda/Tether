// Phase 6: the web console in a real browser (installed Edge/Chrome via playwright-core),
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
const skip = !browserPath ? 'no Chrome/Edge installed' : !fs.existsSync(path.join(consoleDir, 'index.html')) ? 'console not built (npm run build -w @tether/console)' : false;

let srv, cli, browser, page;

before(async () => {
  if (skip) return;
  const { chromium } = await import('playwright-core');
  srv = await startTestServer({ consoleDir });
  cli = await new Machine(srv.url, 'web').start();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  await cli?.stop();
  await srv?.stop();
});

test('sign up and create a repository', { skip }, async () => {
  await page.goto(srv.url);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill('web@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Your repositories').waitFor();
  await page.getByLabel('Repository name').fill('docs');
  await page.getByRole('button', { name: 'Create repository' }).click();
  await page.getByRole('link', { name: /docs/ }).waitFor();
});

test('tether login completes through the console', { skip }, async () => {
  const { url, state } = await cli.ipc('login.start');
  assert.match(url, /\/cli-login\?port=\d+&state=/);
  const waiting = cli.ipc('login.wait', { state });
  await page.goto(url);
  await page.getByText('Sign in the Tether CLI?').waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, 'cli-login.png') });
  await page.getByRole('button', { name: 'Authorize CLI' }).click();
  await page.getByText('Tether CLI signed in').waitFor();
  const user = await waiting;
  assert.equal(user.email, 'web@example.com');
  assert.match((await cli.run(['whoami'])).stdout, /web@example.com/);
});

test('a forged callback with the wrong state is rejected', { skip }, async () => {
  const { url } = await cli.ipc('login.start');
  const port = new URL(url).searchParams.get('port');
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
  assert.equal(res.status, 400);
});

test('artifacts, sharing and history in the console', { skip }, async () => {
  const friend = await new TestUser(srv.url).signup('friend@example.com');
  cli.write('guide.md', '# Guide\n');
  await cli.run(['manage', 'guide.md', '--repo', 'docs']);
  await cli.run(['edit', 'guide.md']);
  cli.write('guide.md', '# Guide\n\nv2\n');
  await cli.run(['done', 'guide.md']);

  await page.goto(srv.url);
  await page.getByRole('link', { name: /docs/ }).click();
  await page.getByRole('link', { name: 'guide.md' }).click();
  await page.getByRole('heading', { name: 'Sharing' }).waitFor();
  const shareId = (await page.locator('code.big').textContent()).trim();

  await page.getByLabel('Editor email').fill('friend@example.com');
  await page.getByRole('button', { name: 'Add editor' }).click();
  await page.getByText('friend@example.com').waitFor();
  const pulled = await friend.call('POST', '/pull', { shareId });
  assert.equal(pulled.role, 'editor');

  await page.getByRole('row', { name: /v2/ }).waitFor();
  if (shots) {
    await page.screenshot({ path: path.join(shots, 'artifact.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, 'artifact-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Restore this' }).click();
  await page.getByRole('row', { name: /v3 rollback \(to v1\)/ }).waitFor();
  await cli.sync();
  assert.equal(cli.read('guide.md'), '# Guide\n');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Rotate' }).click();
  await page.waitForFunction((old) => document.querySelector('code.big')?.textContent.trim() !== old, shareId);
});

test('shared-with-me and deep links', { skip }, async () => {
  const friendPage = await browser.newPage();
  await friendPage.goto(srv.url);
  await friendPage.getByLabel('Email').fill('friend@example.com');
  await friendPage.getByLabel('Password').fill('password123');
  await friendPage.getByRole('button', { name: 'Sign in' }).click();
  await friendPage.getByText('Shared with you').waitFor();
  await friendPage.getByRole('link', { name: /guide.md/ }).click();
  await friendPage.getByText('you are').waitFor();
  assert.equal(await friendPage.getByRole('heading', { name: 'Sharing' }).count(), 0); // editors don't manage sharing
  await friendPage.reload();
  await friendPage.getByRole('heading', { name: 'History' }).waitFor();
  if (shots) await friendPage.screenshot({ path: path.join(shots, 'home-dark.png') });
  await friendPage.close();
});
