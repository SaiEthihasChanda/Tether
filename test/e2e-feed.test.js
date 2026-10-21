// Change cursor and push: an idle daemon either polls cheaply ("unchanged", one read on the server)
// or, with the Firebase push channel, does not poll at all; changes arrive either way. Also the
// minimum tick interval.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';
import { Machine, eventually, sleep } from './helpers/machine.js';
import { FIREBASE } from './helpers/server.js';

let t, owner, viewer;
const answers = [];

before(async () => {
  t = await setup(['owner', 'viewer'], { viewer: { tickSeconds: 1 } });
  ({ owner, viewer } = t);
  const svc = t.srv.service;
  const checkSince = svc.checkSince.bind(svc);
  svc.checkSince = async (...args) => {
    const r = await checkSince(...args);
    answers.push(r.unchanged ? 'unchanged' : 'full');
    return r;
  };
  owner.write('feed.txt', 'one\n');
  await viewer.run(['pull', await manage(owner, 'feed.txt')]);
});
after(() => t?.teardown());

test('an idle daemon checks with its cursor, and changes still arrive on the timer', async () => {
  if (FIREBASE) await eventually(async () => /push channel connected/.test(await viewer.log()), { timeout: 15000, message: 'push channel' });
  answers.length = 0;
  await sleep(4000);
  if (FIREBASE) assert.deepEqual(answers, [], 'with push up, an idle daemon does not poll');
  else assert.ok(answers.filter((a) => a === 'unchanged').length >= 2, `expected cheap checks, got ${answers.join(',')}`);

  await owner.run(['edit', 'feed.txt']);
  owner.write('feed.txt', 'two\n');
  await owner.run(['done', 'feed.txt']);
  await eventually(() => viewer.read('feed.txt').replace(/\r\n/g, '\n') === 'two\n', { timeout: 8000, message: 'timer pull' });
});

test('push: a daemon whose timer never fires still gets changes (Firebase only)', { skip: !FIREBASE && 'push needs the Firebase backend' }, async () => {
  const idle = await new Machine(t.srv.url, 'idle', { tickSeconds: 3600 }).start();
  try {
    await idle.run(['login', '--email', 'idle@example.com', '--password', 'password123', '--signup']);
    owner.write('push.txt', 'first\n');
    await idle.run(['pull', await manage(owner, 'push.txt')]);
    await eventually(async () => /push channel connected/.test(await idle.log()), { timeout: 15000, message: 'push channel' });
    await owner.run(['edit', 'push.txt']);
    owner.write('push.txt', 'pushed\n');
    await owner.run(['done', 'push.txt']);
    await eventually(() => idle.read('push.txt').replace(/\r\n/g, '\n') === 'pushed\n', { timeout: 10000, message: 'pushed change' });
  } finally {
    await idle.stop();
  }
});

test('tickSeconds below the minimum is refused', async () => {
  const r = await viewer.run(['config', 'set', 'tickSeconds', '0.5'], { allowFail: true });
  assert.match(r.stderr + r.stdout, /at least 1/);
});
