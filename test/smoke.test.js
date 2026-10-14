import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';
import { Machine } from './helpers/machine.js';

let srv, alice, bob;
before(async () => {
  srv = await startTestServer();
  alice = await new Machine(srv.url, 'alice').start();
  bob = await new Machine(srv.url, 'bob').start();
});
after(async () => {
  await alice?.stop();
  await bob?.stop();
  await srv?.stop();
});

test('smoke: manage, pull, revert, edit/done, propagate', async () => {
  await alice.run(['login', '--email', 'alice@example.com', '--password', 'password123', '--signup']);
  await bob.run(['login', '--email', 'bob@example.com', '--password', 'password123', '--signup']);
  await alice.run(['repo', 'create', 'team']);
  alice.write('lint.json', '{\n  "rule": 1\n}\n');
  const m = await alice.run(['manage', 'lint.json', '--repo', 'team']);
  const shareId = m.stdout.match(/share ID: (\S+)/)[1];
  await bob.run(['pull', shareId]);
  assert.equal(bob.read('lint.json'), '{\r\n  "rule": 1\r\n}\r\n'); // fresh pull: platform line endings (Windows)

  bob.write('lint.json', 'hacked\n');
  await bob.sync();
  assert.equal(bob.read('lint.json'), '{\r\n  "rule": 1\r\n}\r\n');
  assert.match(await bob.log(), /local change reverted/);

  await alice.run(['edit', 'lint.json']);
  alice.write('lint.json', '{\n  "rule": 2\n}\n');
  await alice.sync();
  assert.equal(alice.read('lint.json'), '{\n  "rule": 2\n}\n'); // editing: kept
  const d = await alice.run(['done', 'lint.json']);
  assert.match(d.stdout, /push .* -> v2/);
  await bob.sync();
  assert.equal(bob.read('lint.json'), '{\r\n  "rule": 2\r\n}\r\n'); // bob keeps CRLF
});
