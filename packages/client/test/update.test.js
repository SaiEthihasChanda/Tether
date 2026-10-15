import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isNewer, prefixOf, installDir } from '../src/update.js';

test('version comparison', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0-beta'), true);
  assert.equal(isNewer('0.0.0-stage', '0.1.0'), false);
  assert.equal(isNewer(null, '0.1.0'), false);
});

test('npm prefix of a global install', () => {
  const winPrefix = path.join('C:' + path.sep, 'Users', 'me', 'AppData', 'Roaming', 'npm');
  assert.equal(prefixOf(path.join(winPrefix, 'node_modules', 'tether-sync'), true), winPrefix);
  assert.equal(prefixOf(path.join(path.sep, 'usr', 'local', 'lib', 'node_modules', 'tether-sync'), false), path.join(path.sep, 'usr', 'local'));
});

test('a source checkout is not an npm install', () => {
  assert.equal(installDir(), null);
});
