import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeSymbols, extractCodeSymbolsWithTreeSitter } from '../src/rag/code/symbols.js';

function loadFixture(name: string): string {
  return readFileSync(path.join(process.cwd(), 'test/fixtures/code', name), 'utf8');
}

test('extractCodeSymbols finds top-level and nested symbols in TypeScript', () => {
  const symbols = extractCodeSymbols(
    loadFixture('sample.ts'),
    'typescript',
    'test/fixtures/code/sample.ts',
  );

  const names = symbols.map((symbol) => symbol.name);
  assert.ok(names.includes('SampleService'));
  assert.ok(names.includes('formatName'));
  assert.ok(names.includes('combine'));
  assert.ok(names.includes('buildMessage'));

  const buildMessage = symbols.find((symbol) => symbol.name === 'buildMessage');
  assert.ok(buildMessage);
  assert.ok(buildMessage!.startLine < buildMessage!.endLine);
  assert.equal(buildMessage!.kind, 'method');
});

test('extractCodeSymbols keeps line ranges monotonic in Python', () => {
  const symbols = extractCodeSymbols(
    loadFixture('sample.py'),
    'python',
    'test/fixtures/code/sample.py',
  );

  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    assert.ok(previous && current);
    assert.ok(previous.endLine <= current.startLine);
  }
});

test('extractCodeSymbolsWithTreeSitter handles multiline TypeScript declarations', async () => {
  const content = `import fs from 'node:fs';

/** Build a message for display. */
export function buildMessage(
  prefix: string,
  name: string,
): string {
  return prefix + name;
}

export class Formatter {
  renderLabel(
    value: string,
  ): string {
    return value.trim();
  }
}

void fs.existsSync;
`;

  const symbols = await extractCodeSymbolsWithTreeSitter(content, 'typescript', 'src/sample.ts');
  const buildMessage = symbols.find((symbol) => symbol.name === 'buildMessage');
  const renderLabel = symbols.find((symbol) => symbol.name === 'renderLabel');

  assert.ok(buildMessage);
  assert.equal(buildMessage.kind, 'function');
  assert.equal(buildMessage.startLine, 4);
  assert.equal(buildMessage.endLine, 9);
  assert.ok(buildMessage.signature?.includes('function buildMessage'));
  assert.ok(buildMessage.imports?.includes("import fs from 'node:fs';"));
  assert.ok(buildMessage.docstring?.includes('Build a message'));

  assert.ok(renderLabel);
  assert.equal(renderLabel.kind, 'method');
  assert.equal(renderLabel.startLine, 12);
  assert.equal(renderLabel.endLine, 16);
});

test('extractCodeSymbolsWithTreeSitter preserves Python body docstrings', async () => {
  const symbols = await extractCodeSymbolsWithTreeSitter(
    loadFixture('sample.py'),
    'python',
    'test/fixtures/code/sample.py',
  );

  const formatName = symbols.find((symbol) => symbol.name === 'format_name');
  assert.ok(formatName);
  assert.ok(formatName.docstring?.includes('Normalize a name for search'));
  assert.ok(formatName.imports?.includes('from dataclasses import dataclass'));
});
