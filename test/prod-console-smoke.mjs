// Production check of the console and the `tether login` browser hand-off (Firebase custom tokens).
// Usage: node test/prod-console-smoke.mjs [serverUrl]   (creates a temporary account and deletes it)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { Machine } from './helpers/machine.js';

const SERVER = process.argv[2] ?? 'https://tether-b10cf.web.app';
const email = `smoke-web-${Date.now().toString(36)}@example.com`;
const password = 'Smoke-web-pw-123';
const browserPath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const shots = process.env.TETHER_SCREENSHOTS;

const cli = await new Machine(SERVER, 'prod-web').start();
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage();
try {
  await page.goto(SERVER);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Your repositories').waitFor({ timeout: 20000 });
  console.log('- signed up in the console (Firebase Auth)');

  const { url, state } = await cli.ipc('login.start');
  const waiting = cli.ipc('login.wait', { state });
  await page.goto(url);
  await page.getByRole('button', { name: 'Authorize CLI' }).click();
  await page.getByText('Tether CLI signed in').waitFor({ timeout: 20000 });
  assert.equal((await waiting).email, email);
  assert.match((await cli.run(['whoami'])).stdout, new RegExp(email));
  console.log('- tether login completed through the browser (custom token)');

  await cli.run(['repo', 'create', 'web']);
  cli.write('readme.md', '# hi\n');
  await cli.run(['manage', 'readme.md', '--repo', 'web']);
  await page.goto(SERVER);
  await page.getByRole('link', { name: /^web r_/ }).click();
  try {
    await page.getByRole('link', { name: 'readme.md' }).click({ timeout: 15000 });
  } catch (e) {
    if (shots) await page.screenshot({ path: `${shots}/prod-fail.png`, fullPage: true });
    console.log('page text:', (await page.locator('main').innerText()).slice(0, 500));
    throw e;
  }
  await page.getByRole('heading', { name: 'Sharing' }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/prod-artifact.png`, fullPage: true });
  console.log('- console shows the artifact uploaded by the CLI');

  await page.goto(SERVER);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Forgot password?' }).waitFor();
  console.log('- sign out; password reset is offered');
} finally {
  const { apiKey } = await (await fetch(`${SERVER}/v1/config`)).json();
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  }).then((x) => x.json());
  if (r.idToken) console.log(`- deleted ${email}: HTTP ${(await fetch(`${SERVER}/v1/me`, { method: 'DELETE', headers: { authorization: `Bearer ${r.idToken}` } })).status}`);
  await browser.close();
  await cli.stop();
}
console.log('production console check passed');
