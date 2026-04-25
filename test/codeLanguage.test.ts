import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeLanguage } from '../src/rag/code/languages.js';

test('detectCodeLanguage prefers extension over content hints', () => {
  assert.equal(
    detectCodeLanguage('sample.ts', '#!/usr/bin/env python3\nprint("hi")'),
    'typescript',
  );
  assert.equal(detectCodeLanguage('sample.py', 'function demo() {}'), 'python');
});

test('detectCodeLanguage uses shebang when extension is missing', () => {
  assert.equal(detectCodeLanguage('script', '#!/usr/bin/env bash\necho hi'), 'shell');
  assert.equal(
    detectCodeLanguage('runner', '#!/usr/bin/env node\nconsole.log("hi")'),
    'javascript',
  );
});

test('detectCodeLanguage returns unknown for unsupported inputs', () => {
  assert.equal(detectCodeLanguage('README.unknown', 'just text'), 'unknown');
});
