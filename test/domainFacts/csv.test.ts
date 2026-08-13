import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../src/domainFacts/csv.js';

test('parses simple CSV', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('handles quoted fields with commas and CRLF', () => {
  const text = 'name,note\r\n"Smith, John","hello, world"\r\n';
  assert.deepEqual(parseCsv(text), [
    ['name', 'note'],
    ['Smith, John', 'hello, world'],
  ]);
});

test('handles escaped quotes', () => {
  assert.deepEqual(parseCsv('a,b\n"say ""hi""","x"'), [
    ['a', 'b'],
    ['say "hi"', 'x'],
  ]);
});

test('returns empty array for empty input', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('throws on an unterminated quoted field at end of input', () => {
  assert.throws(() => parseCsv('a,"unterminated'), /unterminated quoted field/);
});
