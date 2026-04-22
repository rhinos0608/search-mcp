import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, normalizeFirstAuthor } from '../src/tools/academicSearch.js';

// --- normalizeTitle ---

test('normalizeTitle lowercases and trims whitespace', () => {
  assert.equal(normalizeTitle('  Hello World  '), 'hello world');
});

test('normalizeTitle strips LaTeX commands keeping inner text', () => {
  assert.equal(normalizeTitle('\\textbf{Important} Results'), 'important results');
});

test('normalizeTitle strips math mode', () => {
  assert.equal(normalizeTitle('Equation $E=mc^2$ Analysis'), 'equation analysis');
});

test('normalizeTitle strips punctuation', () => {
  assert.equal(normalizeTitle('Hello, World! (2024)'), 'hello world 2024');
});

test('normalizeTitle NFC normalizes', () => {
  // e + combining acute → é (NFC)
  const combined = 'équation';
  const nfc = 'équation';
  assert.equal(normalizeTitle(combined), normalizeTitle(nfc));
});

test('normalizeTitle collapses multiple spaces', () => {
  assert.equal(normalizeTitle('Hello    World'), 'hello world');
});

// --- normalizeFirstAuthor ---

test('normalizeFirstAuthor extracts last name before comma', () => {
  assert.equal(normalizeFirstAuthor('Smith, J. A.'), 'smith');
});

test('normalizeFirstAuthor extracts last word when no comma', () => {
  assert.equal(normalizeFirstAuthor('J. A. Smith'), 'smith');
});

test('normalizeFirstAuthor lowercases and trims', () => {
  assert.equal(normalizeFirstAuthor('  SMITH  '), 'smith');
});

test('normalizeFirstAuthor falls back to full string for empty split', () => {
  assert.equal(normalizeFirstAuthor(''), '');
});

test('normalizeFirstAuthor handles single word', () => {
  assert.equal(normalizeFirstAuthor('Smith'), 'smith');
});
