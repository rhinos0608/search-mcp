import test from 'node:test';
import assert from 'node:assert/strict';
import Parser from 'web-tree-sitter';
import {
  getLoadedTreeSitterLanguages,
  parseCodeWithTreeSitter,
  resetTreeSitterParsersForTests,
} from '../src/rag/code/treeSitter.js';

test('tree-sitter parsers lazy-load only requested grammars', async () => {
  resetTreeSitterParsersForTests();
  assert.deepEqual(getLoadedTreeSitterLanguages(), []);

  const parsed = await parseCodeWithTreeSitter(
    'export function demo() { return 1; }\n',
    'typescript',
  );
  assert.ok(parsed);
  assert.equal(parsed.language, 'typescript');
  assert.equal(parsed.rootType, 'program');
  assert.ok(parsed.rootNode.childCount > 0);

  assert.deepEqual(getLoadedTreeSitterLanguages(), ['typescript']);
});

test('tree-sitter parser path returns null for unsupported languages', async () => {
  resetTreeSitterParsersForTests();
  const parsed = await parseCodeWithTreeSitter('# heading\n', 'markdown');
  assert.equal(parsed, null);
  assert.deepEqual(getLoadedTreeSitterLanguages(), []);
});

test('tree-sitter reset discards in-flight parser loads', async (t) => {
  resetTreeSitterParsersForTests();

  const originalLoad = Parser.Language.load.bind(Parser.Language);
  let releaseLoad: (() => void) | undefined;
  let signalLoadStarted: () => void = () => undefined;
  const loadStarted = new Promise<void>((resolve) => {
    signalLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });

  t.mock.method(Parser.Language, 'load', async (wasmPath: string) => {
    signalLoadStarted();
    await loadGate;
    return originalLoad(wasmPath);
  });

  const parsePromise = parseCodeWithTreeSitter(
    'export function demo() { return 1; }\n',
    'typescript',
  );
  await loadStarted;

  resetTreeSitterParsersForTests();
  assert.deepEqual(getLoadedTreeSitterLanguages(), []);

  releaseLoad?.();
  const parsed = await parsePromise;
  assert.equal(parsed, null);
  assert.deepEqual(getLoadedTreeSitterLanguages(), []);
});
