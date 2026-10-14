import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, renderForLocal, detectStyle, isBinary, resolveEol, nameError, relPathError, caseCollisionError } from '../src/index.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('CRLF and BOM differences are not changes', () => {
  const lf = Buffer.from('a\nb\n');
  const crlfBom = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]);
  assert.equal(contentHash(lf), contentHash(crlfBom));
  assert.notEqual(contentHash(lf, 'binary'), contentHash(crlfBom, 'binary'));
});

test('binary detection by NUL byte', () => {
  assert.equal(isBinary(Buffer.from([1, 2, 0, 3])), true);
  assert.equal(isBinary(Buffer.from('text')), false);
  const bin = Buffer.from([0x0d, 0x0a, 0x00]);
  assert.deepEqual(canonicalize(bin).bytes, bin);
});

test('render keeps the local style', () => {
  const canon = Buffer.from('x\ny\n');
  const style = detectStyle(Buffer.concat([BOM, Buffer.from('old\r\n')]));
  assert.deepEqual(style, { eol: 'crlf', bom: true });
  assert.deepEqual(renderForLocal(canon, 'auto', style, 'lf'), Buffer.concat([BOM, Buffer.from('x\r\ny\r\n')]));
  assert.equal(renderForLocal(canon, 'auto', null, 'crlf').toString(), 'x\r\ny\r\n');
  assert.deepEqual(renderForLocal(canon, 'lf', style, 'crlf'), Buffer.concat([BOM, Buffer.from('x\ny\n')]));
  assert.equal(renderForLocal(canon, 'auto', { eol: null, bom: false }, 'lf').toString(), 'x\ny\n');
});

test('eol rules', () => {
  assert.equal(resolveEol('scripts/run.sh'), 'lf');
  assert.equal(resolveEol('a.bat'), 'crlf');
  assert.equal(resolveEol('a.txt', { '*.txt': 'crlf' }), 'crlf');
  assert.equal(resolveEol('docs/a.md', { 'docs/**': 'lf' }), 'lf');
  assert.equal(resolveEol('a.txt', { '*.txt': 'crlf' }, 'binary'), 'binary');
});

test('name validation', () => {
  assert.equal(nameError('ok.txt'), null);
  assert.match(nameError('CON'), /reserved/);
  assert.match(nameError('nul.txt'), /reserved/);
  assert.match(nameError('a:b'), /character/);
  assert.match(nameError('trail.'), /dot or space/);
  assert.match(relPathError('a/../b'), /invalid/);
  assert.match(relPathError('x'.repeat(201)), /longer/);
  assert.match(caseCollisionError(['README.md', 'Readme.md']), /case/);
  assert.match(caseCollisionError(['Docs/a.md', 'docs/b.md']), /case/);
  assert.match(caseCollisionError(['a', 'a/b']), /both a file and a folder/);
  assert.equal(caseCollisionError(['a/b', 'a/c']), null);
});
