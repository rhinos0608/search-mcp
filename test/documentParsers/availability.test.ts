import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDocumentParsers } from '../../src/utils/documentParsers/availability.js';

test('detectDocumentParsers resolves to booleans without throwing', async () => {
  const result = await detectDocumentParsers();
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.pdf, 'boolean');
  assert.equal(typeof result.office, 'boolean');
});

test('detectDocumentParsers reports both installed parsers as available', async () => {
  // In this repo both pdf-parse and officeparser are installed by default, so
  // discovery should report them available.
  const result = await detectDocumentParsers();
  assert.equal(result.pdf, true);
  assert.equal(result.office, true);
});
