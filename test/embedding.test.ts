import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbeddingResponse } from '../src/rag/embedding.js';

// ── Sidecar shape ────────────────────────────────────────────────────────

test('normalizeEmbeddingResponse: accepts native sidecar shape', () => {
  const raw = {
    embeddings: [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ],
    model: 'test-model',
    modelRevision: 'abc123',
    dimensions: 3,
    mode: 'document',
    truncatedIndices: [],
  };

  const result = normalizeEmbeddingResponse(raw, 2);
  assert.equal(result.provider, 'sidecar');
  assert.equal(result.embeddings.length, 2);
  assert.deepStrictEqual(result.embeddings[0], [0.1, 0.2, 0.3]);
  assert.deepStrictEqual(result.embeddings[1], [0.4, 0.5, 0.6]);
});

test('normalizeEmbeddingResponse: accepts single sidecar embedding', () => {
  const raw = {
    embeddings: [[1.0, 2.0, 3.0, 4.0]],
  };

  const result = normalizeEmbeddingResponse(raw, 1);
  assert.equal(result.provider, 'sidecar');
  assert.equal(result.embeddings.length, 1);
  assert.deepStrictEqual(result.embeddings[0], [1.0, 2.0, 3.0, 4.0]);
});

// ── OpenAI/LM Studio shape ───────────────────────────────────────────────

test('normalizeEmbeddingResponse: accepts OpenAI-compatible shape', () => {
  const raw = {
    object: 'list',
    data: [
      { object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 },
      { object: 'embedding', embedding: [0.4, 0.5, 0.6], index: 1 },
    ],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 4, total_tokens: 4 },
  };

  const result = normalizeEmbeddingResponse(raw, 2);
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.embeddings.length, 2);
  assert.deepStrictEqual(result.embeddings[0], [0.1, 0.2, 0.3]);
  assert.deepStrictEqual(result.embeddings[1], [0.4, 0.5, 0.6]);
});

test('normalizeEmbeddingResponse: accepts LM Studio / local OpenAI shape', () => {
  const raw = {
    data: [
      { embedding: [0.001, -0.002, 0.003], index: 0 },
    ],
    model: 'local-model',
  };

  const result = normalizeEmbeddingResponse(raw, 1);
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.embeddings[0]!.length, 3);
});

// ── Error: neither shape ─────────────────────────────────────────────────

test('normalizeEmbeddingResponse: throws on missing both schemas', () => {
  const raw = { foo: 'bar', baz: 42 };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('did not match sidecar or OpenAI-compatible schema') &&
        err.message.includes('keys=[foo,baz]') &&
        err.message.includes('hasDataArray=false')
      );
    },
  );
});

test('normalizeEmbeddingResponse: throws on data array without embedding', () => {
  const raw = {
    data: [
      { not_an_embedding: 'hello', index: 0 },
    ],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('data[0].embedding is missing') &&
        err.message.includes('not_an_embedding')
      );
    },
  );
});

test('normalizeEmbeddingResponse: throws on null input', () => {
  assert.throws(
    () => normalizeEmbeddingResponse(null, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.includes('is not an object');
    },
  );
});

test('normalizeEmbeddingResponse: throws on string input', () => {
  assert.throws(
    () => normalizeEmbeddingResponse('not json', 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.includes('is not an object');
    },
  );
});

// ── Count mismatch ───────────────────────────────────────────────────────

test('normalizeEmbeddingResponse: throws on wrong embedding count (sidecar)', () => {
  const raw = {
    embeddings: [[0.1, 0.2]],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 3),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('Expected 3 embeddings') &&
        err.message.includes('received 1')
      );
    },
  );
});

test('normalizeEmbeddingResponse: throws on wrong embedding count (OpenAI)', () => {
  const raw = {
    data: [
      { embedding: [0.1, 0.2], index: 0 },
      { embedding: [0.3, 0.4], index: 1 },
    ],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('Expected 1 embeddings') &&
        err.message.includes('received 2')
      );
    },
  );
});

// ── Type validation ──────────────────────────────────────────────────────

test('normalizeEmbeddingResponse: throws on non-array vector', () => {
  const raw = {
    embeddings: ['not an array' as unknown as number[]],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.includes('embedding[0] is not an array');
    },
  );
});

test('normalizeEmbeddingResponse: throws on empty vector', () => {
  const raw = {
    embeddings: [[]],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.includes('is an empty vector');
    },
  );
});

test('normalizeEmbeddingResponse: throws on NaN values', () => {
  const raw = {
    embeddings: [[0.1, NaN, 0.3]],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('is not a finite number') &&
        err.message.includes('NaN')
      );
    },
  );
});

test('normalizeEmbeddingResponse: throws on Infinity values', () => {
  const raw = {
    embeddings: [[0.1, Infinity, 0.3]],
  };

  assert.throws(
    () => normalizeEmbeddingResponse(raw, 1),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('is not a finite number') &&
        err.message.includes('Infinity')
      );
    },
  );
});

// ── Dimension mismatch: logs warning, doesn't throw ──────────────────────

test('normalizeEmbeddingResponse: does not throw on dimension mismatch (sidecar)', () => {
  const raw = {
    embeddings: [[0.1, 0.2]],
  };

  // should not throw — dimension mismatch is a warning, not an error
  const result = normalizeEmbeddingResponse(raw, 1, 768);
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.embeddings[0]!.length, 2);
});

test('normalizeEmbeddingResponse: does not throw on dimension match', () => {
  const raw = {
    embeddings: [[0.1, 0.2, 0.3]],
  };

  const result = normalizeEmbeddingResponse(raw, 1, 3);
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.embeddings[0]!.length, 3);
});

// ── Edge: prefers sidecar shape over OpenAI when both present ────────────

test('normalizeEmbeddingResponse: prefers sidecar shape when both present', () => {
  const raw = {
    embeddings: [[0.1, 0.2]],
    data: [{ embedding: [0.3, 0.4], index: 0 }],
  };

  const result = normalizeEmbeddingResponse(raw, 1);
  assert.equal(result.provider, 'sidecar');
  assert.deepStrictEqual(result.embeddings[0], [0.1, 0.2]);
});
