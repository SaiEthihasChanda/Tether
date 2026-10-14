import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand } from '../src/cli.js';

test('the login URL reaches the browser whole, including everything after &', () => {
  const url = 'http://127.0.0.1:8787/cli-login?port=51234&state=abc123';
  const [cmd, args] = browserCommand(url, 'win32');
  assert.notEqual(cmd.toLowerCase(), 'cmd');
  assert.equal(args.at(-1), url);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});
