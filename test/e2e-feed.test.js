// Change cursor: an idle daemon's checks are answered "unchanged" (one read on the server), and
// changes still arrive on the timer without a manual sync. Also the minimum tick interval.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';
import { eventually, sleep } from './helpers/machine.js';

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
  answers.length = 0;
  await sleep(4000);
  assert.ok(answers.filter((a) => a === 'unchanged').length >= 2, `expected cheap checks, got ${answers.join(',')}`);

  await owner.run(['edit', 'feed.txt']);
  owner.write('feed.txt', 'two\n');
  await owner.run(['done', 'feed.txt']);
  await eventually(() => viewer.read('feed.txt').replace(/\r\n/g, '\n') === 'two\n', { timeout: 8000, message: 'timer pull' });
});

test('tickSeconds below the minimum is refused', async () => {
  const r = await viewer.run(['config', 'set', 'tickSeconds', '0.5'], { allowFail: true });
  assert.match(r.stderr + r.stdout, /at least 1/);
});
