/**
 * TDD tests for src/utils/corpusCache.ts
 *
 * Each test operates with a fresh temporary cache directory so tests are
 * isolated and don't bleed state into each other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getOrBuildCorpus,
  loadCorpusById,
  invalidateCorpus,
} from '../src/utils/corpusCache.js';
import type { CorpusChunk, SemanticCrawlSource } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Create a fresh temp dir and point the cache module at it. */
function makeTmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-cache-test-'));
}

function makeChunks(texts: string[]): CorpusChunk[] {
  return texts.map((text, i) => ({
    text,
    url: `https://example.com/page${i}`,
    section: `Section ${i}`,
    charOffset: i * 100,
    chunkIndex: i,
    totalChunks: texts.length,
  }));
}

function makeEmbeddings(chunks: CorpusChunk[], dims = 4): number[][] {
  return chunks.map((_, i) =>
    Array.from({ length: dims }, (__, d) => (i + 1) * 0.1 + d * 0.01),
  );
}

const TEST_SOURCE: SemanticCrawlSource = {
  type: 'url',
  url: 'https://example.com',
};

const TEST_SOURCE_2: SemanticCrawlSource = {
  type: 'url',
  url: 'https://other.com',
};

// ────────────────────────────────────────────────────────────────────
// 1. Serialize/deserialize roundtrip
// ────────────────────────────────────────────────────────────────────

test('roundtrip: getOrBuildCorpus writes; loadCorpusById returns identical data', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['hello world', 'foo bar baz']);
  const embeddings = makeEmbeddings(chunks);
  let callCount = 0;

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => {
      callCount++;
      return { chunks, embeddings, model: 'test-model', contentHash: 'abc123' };
    },
    { cacheDir },
  );

  assert.equal(callCount, 1);
  assert.equal(corpus.model, 'test-model');
  assert.equal(corpus.contentHash, 'abc123');
  assert.equal(corpus.chunks.length, 2);
  assert.equal(corpus.embeddings.length, 2);

  // Load by ID — should get same data back
  const loaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.ok(loaded !== null, 'Expected loaded corpus, got null');
  assert.equal(loaded.model, 'test-model');
  assert.equal(loaded.contentHash, 'abc123');
  assert.equal(loaded.chunks.length, 2);
  assert.equal(loaded.embeddings.length, 2);
  assert.equal(loaded.chunks[0]!.text, 'hello world');
  assert.equal(loaded.chunks[1]!.text, 'foo bar baz');

  // Embeddings are within float32 precision
  for (let i = 0; i < embeddings.length; i++) {
    for (let d = 0; d < embeddings[i]!.length; d++) {
      const orig = embeddings[i]![d]!;
      const loaded32 = loaded.embeddings[i]![d]!;
      assert.ok(
        Math.abs(orig - loaded32) < 1e-5,
        `Embedding[${i}][${d}] mismatch: orig=${orig}, loaded=${loaded32}`,
      );
    }
  }
});

// ────────────────────────────────────────────────────────────────────
// 2. Cache hit skips materializeFn
// ────────────────────────────────────────────────────────────────────

test('cache hit: second call does NOT invoke materializeFn again', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['cache hit test']);
  const embeddings = makeEmbeddings(chunks);
  let callCount = 0;

  const materialize = async () => {
    callCount++;
    return { chunks, embeddings, model: 'model-v1', contentHash: 'hash1' };
  };

  // First call — materializes
  await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  // Second call — should be a cache hit
  await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });

  assert.equal(callCount, 1, `Expected materializeFn called exactly once, got ${callCount}`);
});

// ────────────────────────────────────────────────────────────────────
// 3. TTL expiry
// ────────────────────────────────────────────────────────────────────

test('TTL expiry: loadCorpusById returns null when createdAt exceeds ttlMs', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['ttl test']);
  const embeddings = makeEmbeddings(chunks);

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
    { cacheDir },
  );

  // Manipulate the metadata on disk to set createdAt far in the past
  const metaPath = path.join(cacheDir, `${corpus.corpusId}.json`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  meta['createdAt'] = Date.now() - 100_000; // 100 seconds ago
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  // Load with 10ms TTL — should be expired
  const result = await loadCorpusById(corpus.corpusId, { cacheDir, ttlMs: 10 });
  assert.equal(result, null, 'Expected null for TTL-expired corpus');
});

// ────────────────────────────────────────────────────────────────────
// 4. LRU eviction
// ────────────────────────────────────────────────────────────────────

test('LRU eviction: writing when at maxCorpora evicts least-recently-accessed', async () => {
  const cacheDir = makeTmpCacheDir();

  // Fill to maxCorpora=3
  const sources: SemanticCrawlSource[] = [
    { type: 'url', url: 'https://a.com' },
    { type: 'url', url: 'https://b.com' },
    { type: 'url', url: 'https://c.com' },
  ];

  const corpora: Array<{ corpusId: string }> = [];

  for (const source of sources) {
    const chunks = makeChunks([`content for ${(source as { url: string }).url}`]);
    const embeddings = makeEmbeddings(chunks);
    const corpus = await getOrBuildCorpus(
      source,
      async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
      { cacheDir, maxCorpora: 3 },
    );
    corpora.push(corpus);
    // Small delay so timestamps are distinguishable
    await new Promise(r => setTimeout(r, 5));
  }

  // Access the first corpus to make it "recently used" — b.com becomes LRU
  await new Promise(r => setTimeout(r, 5));
  await loadCorpusById(corpora[0]!.corpusId, { cacheDir });

  // Now add a 4th corpus — should evict LRU (b.com / index 1)
  const newChunks = makeChunks(['new content']);
  const newEmbeddings = makeEmbeddings(newChunks);
  await getOrBuildCorpus(
    { type: 'url', url: 'https://d.com' },
    async () => ({ chunks: newChunks, embeddings: newEmbeddings, model: 'm', contentHash: 'h' }),
    { cacheDir, maxCorpora: 3 },
  );

  // b.com (index 1) should be evicted
  const evicted = await loadCorpusById(corpora[1]!.corpusId, { cacheDir });
  assert.equal(evicted, null, 'Expected LRU corpus (b.com) to be evicted');

  // a.com and c.com should still exist
  const aStill = await loadCorpusById(corpora[0]!.corpusId, { cacheDir });
  assert.ok(aStill !== null, 'Expected a.com corpus to still exist');
  const cStill = await loadCorpusById(corpora[2]!.corpusId, { cacheDir });
  assert.ok(cStill !== null, 'Expected c.com corpus to still exist');
});

// ────────────────────────────────────────────────────────────────────
// 5. Async lock dedup (thundering herd)
// ────────────────────────────────────────────────────────────────────

test('async lock: concurrent calls for same source invoke materializeFn exactly once', async () => {
  const cacheDir = makeTmpCacheDir();
  let callCount = 0;

  const chunks = makeChunks(['thundering herd test']);
  const embeddings = makeEmbeddings(chunks);

  const materialize = async () => {
    callCount++;
    // Small delay to allow concurrency overlap
    await new Promise(r => setTimeout(r, 20));
    return { chunks, embeddings, model: 'm', contentHash: 'h' };
  };

  // Launch 5 concurrent calls for the same source
  const results = await Promise.all([
    getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir }),
    getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir }),
    getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir }),
    getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir }),
    getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir }),
  ]);

  assert.equal(callCount, 1, `Expected materializeFn called exactly once, got ${callCount}`);
  // All results should have same corpusId
  const ids = new Set(results.map(r => r.corpusId));
  assert.equal(ids.size, 1, 'Expected all results to share same corpusId');
});

// ────────────────────────────────────────────────────────────────────
// 6. invalidateCorpus removes from disk and in-memory lock
// ────────────────────────────────────────────────────────────────────

test('invalidateCorpus: removes corpus from disk', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['to be invalidated']);
  const embeddings = makeEmbeddings(chunks);

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
    { cacheDir },
  );

  const metaPath = path.join(cacheDir, `${corpus.corpusId}.json`);
  const binPath = path.join(cacheDir, `${corpus.corpusId}.bin`);
  assert.ok(fs.existsSync(metaPath), 'Expected .json file to exist before invalidation');
  assert.ok(fs.existsSync(binPath), 'Expected .bin file to exist before invalidation');

  invalidateCorpus(corpus.corpusId, { cacheDir });

  assert.ok(!fs.existsSync(metaPath), 'Expected .json file to be removed after invalidation');
  assert.ok(!fs.existsSync(binPath), 'Expected .bin file to be removed after invalidation');

  const reloaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.equal(reloaded, null, 'Expected null after invalidation');
});

test('invalidateCorpus: subsequent getOrBuildCorpus re-materializes', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['re-materialize test']);
  const embeddings = makeEmbeddings(chunks);
  let callCount = 0;

  const materialize = async () => {
    callCount++;
    return { chunks, embeddings, model: 'm', contentHash: 'h' };
  };

  const corpus = await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  assert.equal(callCount, 1);

  invalidateCorpus(corpus.corpusId, { cacheDir });

  // After invalidation, next call should re-materialize
  await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  assert.equal(callCount, 2, 'Expected materializeFn called again after invalidation');
});

// ────────────────────────────────────────────────────────────────────
// 7. Missing corpus returns null
// ────────────────────────────────────────────────────────────────────

test('loadCorpusById: returns null for nonexistent corpusId', async () => {
  const cacheDir = makeTmpCacheDir();
  const result = await loadCorpusById('nonexistent-id-that-does-not-exist', { cacheDir });
  assert.equal(result, null);
});

// ────────────────────────────────────────────────────────────────────
// 8. BM25 index rebuilt on load
// ────────────────────────────────────────────────────────────────────

test('BM25 index: loaded corpus has functional bm25Index', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks([
    'machine learning neural networks deep learning',
    'cooking recipes pasta carbonara',
    'machine learning gradient descent optimization',
  ]);
  const embeddings = makeEmbeddings(chunks);

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
    { cacheDir },
  );

  // Load fresh from disk
  const loaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.ok(loaded !== null, 'Expected loaded corpus');

  const results = loaded.bm25Index.search('machine learning', 5);
  assert.ok(results.length >= 2, `Expected at least 2 results for 'machine learning', got ${results.length}`);

  // The ML-related chunks should outrank the cooking chunk
  assert.ok(results[0]!.score > 0, 'Expected ML chunks to rank in top results');

  // Cooking chunk should not be top result
  const cookingScore = results.find((r: { id: string; score: number }) =>
    r.id.includes('page1') || r.id === `${chunks[1]!.url}:${chunks[1]!.chunkIndex}`,
  )?.score ?? 0;
  const mlScore = results[0]!.score;
  assert.ok(mlScore > cookingScore, `Expected ML chunk (${mlScore}) to outrank cooking (${cookingScore})`);
});

// ────────────────────────────────────────────────────────────────────
// 9. corpusId is deterministic (same source + model → same id)
// ────────────────────────────────────────────────────────────────────

test('corpusId is deterministic: same source produces same id on different calls', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['determinism test']);
  const embeddings = makeEmbeddings(chunks);

  const corpus1 = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'model-abc', contentHash: 'h' }),
    { cacheDir },
  );

  // Invalidate so we can re-build
  invalidateCorpus(corpus1.corpusId, { cacheDir });

  const corpus2 = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'model-abc', contentHash: 'h' }),
    { cacheDir },
  );

  assert.equal(corpus1.corpusId, corpus2.corpusId, 'Expected same corpusId for same source + model');
});

// ────────────────────────────────────────────────────────────────────
// 10. Different sources produce different corpusIds
// ────────────────────────────────────────────────────────────────────

test('corpusId differs for different sources', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['content']);
  const embeddings = makeEmbeddings(chunks);

  const corpus1 = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
    { cacheDir },
  );

  const corpus2 = await getOrBuildCorpus(
    TEST_SOURCE_2,
    async () => ({ chunks, embeddings, model: 'm', contentHash: 'h' }),
    { cacheDir },
  );

  assert.notEqual(corpus1.corpusId, corpus2.corpusId, 'Expected different corpusIds for different sources');
});
