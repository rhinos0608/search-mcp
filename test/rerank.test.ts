// test/rerank.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_DIR = join(process.cwd(), 'models');
const MODEL_AVAILABLE =
  existsSync(join(MODEL_DIR, 'model.onnx')) &&
  existsSync(join(MODEL_DIR, 'tokenizer.json'));

// Helper: skip block if model not available
function requireModel(fn: () => void): () => void {
  return MODEL_AVAILABLE ? fn : () => { /* skipped */ };
}

describe('rerank', () => {
  // Import is dynamic so the module loads only when model is available
  let rerank: typeof import('../src/utils/rerank.js').rerank;

  before(async () => {
    if (!MODEL_AVAILABLE) {
      console.warn('⚠ Cross-encoder model not found — rerank tests SKIPPED. Run: npx tsx scripts/download-model.ts');
      return;
    }
    const mod = await import('../src/utils/rerank.js');
    rerank = mod.rerank;
  });

  it(
    'returns empty array for empty documents',
    requireModel(async () => {
      const results = await rerank!('test query', []);
      assert.deepEqual(results, []);
    }),
  );

  it(
    'returns results for single document',
    requireModel(async () => {
      const results = await rerank!('python web framework', [
        'Flask is a lightweight WSGI web application framework in Python.',
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.index, 0);
      assert.equal(typeof results[0]!.score, 'number');
      assert.ok(Number.isFinite(results[0]!.score));
      assert.equal(
        results[0]!.document,
        'Flask is a lightweight WSGI web application framework in Python.',
      );
    }),
  );

  it(
    'ranks relevant document above irrelevant',
    requireModel(async () => {
      const results = await rerank!('python web framework', [
        'The quick brown fox jumps over the lazy dog.',
        'Flask is a lightweight WSGI web application framework in Python.',
        'Django is a high-level Python web framework that encourages rapid development.',
        'Banana bread recipe: mix bananas, flour, eggs, and sugar.',
      ], { topK: 4 });

      // The two Python docs should rank above the fox and banana bread
      const pythonIndices = [1, 2];
      const topTwo = results.slice(0, 2).map(r => r.index);
      for (const idx of pythonIndices) {
        assert.ok(
          topTwo.includes(idx),
          `Expected Python doc ${idx} in top 2, got indices: ${topTwo}`,
        );
      }
    }),
  );

  it(
    'returns results in descending score order',
    requireModel(async () => {
      const results = await rerank!('machine learning', [
        'Machine learning is a subset of artificial intelligence.',
        'I like to eat pizza for dinner.',
        'Deep learning uses neural networks with many layers.',
      ], { topK: 3 });

      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1]!.score >= results[i]!.score,
          `Scores not descending at index ${i}: ${results[i - 1]!.score} < ${results[i]!.score}`,
        );
      }
    }),
  );

  it(
    'respects topK parameter',
    requireModel(async () => {
      const results = await rerank!('test', [
        'doc one about testing',
        'doc two about debugging',
        'doc three about deployment',
        'doc four about monitoring',
      ], { topK: 2 });

      assert.equal(results.length, 2);
    }),
  );

  it(
    'preserves original index in results',
    requireModel(async () => {
      const results = await rerank!('python', [
        'nothing about python here',
        'python is great',
        'still nothing',
      ], { topK: 3 });

      const indices = results.map(r => r.index).sort();
      assert.deepEqual(indices, [0, 1, 2]);
    }),
  );

  it(
    'handles documents exceeding max token length',
    requireModel(async () => {
      const longDoc = 'word '.repeat(600); // ~600 words, well over max token length
      const results = await rerank!('test query', [
        longDoc,
        'short relevant doc about test query',
      ], { topK: 2 });

      assert.equal(results.length, 2);
      // Should not crash; long doc should be truncated
    }),
  );
});
