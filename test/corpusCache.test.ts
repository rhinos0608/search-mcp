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
import { createHash } from 'node:crypto';
import {
  computeCorpusId,
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
  return chunks.map((_, i) => Array.from({ length: dims }, (__, d) => (i + 1) * 0.1 + d * 0.01));
}

function computeContentHash(chunks: CorpusChunk[]): string {
  return createHash('sha256')
    .update(chunks.map((c) => c.text).join('\n'))
    .digest('hex');
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

test('roundtrip: getOrBuildCorpus writes SQLite db; loadCorpusById returns identical data', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['hello world', 'foo bar baz']);
  const embeddings = makeEmbeddings(chunks);
  let callCount = 0;

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => {
      callCount++;
      return { chunks, embeddings, model: 'test-model', contentHash: computeContentHash(chunks) };
    },
    { cacheDir },
  );

  assert.equal(callCount, 1);
  assert.equal(corpus.model, 'test-model');
  assert.equal(corpus.contentHash, computeContentHash(chunks));
  assert.equal(corpus.chunks.length, 2);
  assert.equal(corpus.embeddings.length, 2);
  assert.ok(
    fs.existsSync(path.join(cacheDir, 'corpus-cache.sqlite')),
    'Expected SQLite cache database to exist',
  );
  assert.deepEqual(
    fs.readdirSync(cacheDir).filter((file) => file.endsWith('.json') || file.endsWith('.bin')),
    [],
    'SQLite cache should not write per-corpus JSON/BIN files',
  );

  // Load by ID — should get same data back
  const loaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.ok(loaded !== null, 'Expected loaded corpus, got null');
  assert.equal(loaded.model, 'test-model');
  assert.equal(loaded.contentHash, computeContentHash(chunks));
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
    return { chunks, embeddings, model: 'model-v1', contentHash: computeContentHash(chunks) };
  };

  // First call — materializes
  await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  // Second call — should be a cache hit
  await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });

  assert.equal(callCount, 1, `Expected materializeFn called exactly once, got ${callCount}`);
});

test('empty materializations are not persisted as cache hits', async () => {
  const cacheDir = makeTmpCacheDir();
  let callCount = 0;

  const materialize = async () => {
    callCount++;
    return {
      chunks: [],
      embeddings: [],
      model: '',
      contentHash: computeContentHash([]),
    };
  };

  const first = await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  const second = await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });

  assert.equal(callCount, 2, 'empty corpora should be rebuilt rather than served from cache');
  assert.equal(first.chunks.length, 0);
  assert.equal(second.chunks.length, 0);

  const corpusFiles = fs
    .readdirSync(cacheDir)
    .filter((file) => file.endsWith('.json') || file.endsWith('.bin'));
  assert.deepEqual(
    corpusFiles,
    [],
    'empty corpora should not write metadata, embeddings, or source index files',
  );
});

test('empty corpora already in SQLite are ignored and rebuilt', async () => {
  const cacheDir = makeTmpCacheDir();
  const oldCorpusId = computeCorpusId(TEST_SOURCE, '', 0);
  const now = Date.now();
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(cacheDir, 'corpus-cache.sqlite'));
  db.exec(`
    CREATE TABLE corpora (
      corpus_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL
    );
    CREATE TABLE source_index (
      source_key TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_key, corpus_id)
    );
  `);
  db.prepare(`INSERT INTO corpora VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    oldCorpusId,
    '{"type":"url","url":"https://example.com"}',
    JSON.stringify(TEST_SOURCE),
    computeContentHash([]),
    '',
    0,
    now,
    now,
    0,
  );
  db.prepare(`INSERT INTO source_index VALUES (?, ?, ?, ?, ?)`).run(
    '{"type":"url","url":"https://example.com"}',
    oldCorpusId,
    '',
    0,
    now,
  );
  db.close();

  const chunks = makeChunks(['rebuilt content']);
  const embeddings = makeEmbeddings(chunks);
  let callCount = 0;
  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => {
      callCount++;
      return { chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) };
    },
    { cacheDir },
  );

  assert.equal(callCount, 1, 'empty disk corpus should not be treated as a cache hit');
  assert.equal(corpus.chunks.length, 1);
  assert.equal(corpus.model, 'm');
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
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  // Manipulate the metadata on disk to set createdAt far in the past
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(cacheDir, 'corpus-cache.sqlite'));
  db.prepare('UPDATE corpora SET created_at = ? WHERE corpus_id = ?').run(
    Date.now() - 100_000,
    corpus.corpusId,
  );
  db.close();

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
      async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
      { cacheDir, maxCorpora: 3 },
    );
    corpora.push(corpus);
    // Small delay so timestamps are distinguishable
    await new Promise((r) => setTimeout(r, 5));
  }

  // Access the first corpus to make it "recently used" — b.com becomes LRU
  await new Promise((r) => setTimeout(r, 5));
  await loadCorpusById(corpora[0]!.corpusId, { cacheDir });

  // Now add a 4th corpus — should evict LRU (b.com / index 1)
  const newChunks = makeChunks(['new content']);
  const newEmbeddings = makeEmbeddings(newChunks);
  await getOrBuildCorpus(
    { type: 'url', url: 'https://d.com' },
    async () => ({
      chunks: newChunks,
      embeddings: newEmbeddings,
      model: 'm',
      contentHash: computeContentHash(newChunks),
    }),
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
    await new Promise((r) => setTimeout(r, 20));
    return { chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) };
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
  const ids = new Set(results.map((r) => r.corpusId));
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
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  const Database = (await import('better-sqlite3')).default;
  const dbPath = path.join(cacheDir, 'corpus-cache.sqlite');
  let db = new Database(dbPath, { readonly: true });
  assert.equal(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM corpora WHERE corpus_id = ?')
        .get(corpus.corpusId) as { count: number }
    ).count,
    1,
    'Expected SQLite corpus row before invalidation',
  );
  db.close();

  invalidateCorpus(corpus.corpusId, { cacheDir, source: TEST_SOURCE });

  db = new Database(dbPath, { readonly: true });
  assert.equal(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM corpora WHERE corpus_id = ?')
        .get(corpus.corpusId) as { count: number }
    ).count,
    0,
    'Expected SQLite corpus row to be removed after invalidation',
  );
  db.close();

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
    return { chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) };
  };

  const corpus = await getOrBuildCorpus(TEST_SOURCE, materialize, { cacheDir });
  assert.equal(callCount, 1);

  invalidateCorpus(corpus.corpusId, { cacheDir, source: TEST_SOURCE });

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
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  // Load fresh from disk
  const loaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.ok(loaded !== null, 'Expected loaded corpus');

  const results = loaded.bm25Index.search('machine learning', 5);
  assert.ok(
    results.length >= 2,
    `Expected at least 2 results for 'machine learning', got ${results.length}`,
  );

  // The ML-related chunks should outrank the cooking chunk
  assert.ok(results[0]!.score > 0, 'Expected ML chunks to rank in top results');

  // Cooking chunk should not be top result
  const cookingScore =
    results.find(
      (r: { id: string; score: number }) =>
        r.id.includes('page1') || r.id === `${chunks[1]!.url}:${chunks[1]!.chunkIndex}`,
    )?.score ?? 0;
  const mlScore = results[0]!.score;
  assert.ok(
    mlScore > cookingScore,
    `Expected ML chunk (${mlScore}) to outrank cooking (${cookingScore})`,
  );
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
    async () => ({
      chunks,
      embeddings,
      model: 'model-abc',
      contentHash: computeContentHash(chunks),
    }),
    { cacheDir },
  );

  // Invalidate so we can re-build
  invalidateCorpus(corpus1.corpusId, { cacheDir, source: TEST_SOURCE });

  const corpus2 = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({
      chunks,
      embeddings,
      model: 'model-abc',
      contentHash: computeContentHash(chunks),
    }),
    { cacheDir },
  );

  assert.equal(
    corpus1.corpusId,
    corpus2.corpusId,
    'Expected same corpusId for same source + model',
  );
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
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  const corpus2 = await getOrBuildCorpus(
    TEST_SOURCE_2,
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  assert.notEqual(
    corpus1.corpusId,
    corpus2.corpusId,
    'Expected different corpusIds for different sources',
  );
});

// ────────────────────────────────────────────────────────────────────
// 11. Corrupted SQLite embedding blob triggers cache miss
// ────────────────────────────────────────────────────────────────────

test('loadCorpusById: corrupted embedding blob returns null', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['truncated embedding test']);
  const embeddings = makeEmbeddings(chunks, 4); // 1 chunk × 4 dims

  const corpus = await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(cacheDir, 'corpus-cache.sqlite'));
  db.prepare('UPDATE embeddings SET vector = ? WHERE corpus_id = ? AND position = 0').run(
    Buffer.alloc(3),
    corpus.corpusId,
  );
  db.close();

  const result = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.equal(result, null, 'Expected null for corpus with corrupted embedding blob');
});

// ────────────────────────────────────────────────────────────────────
// 12. Source preservation on disk roundtrip
// ────────────────────────────────────────────────────────────────────

test('roundtrip: original source is preserved through cache read/write', async () => {
  const cacheDir = makeTmpCacheDir();
  const source: SemanticCrawlSource = {
    type: 'search',
    query: 'test query',
    maxSeedUrls: 15,
  };
  const chunks = makeChunks(['source preservation test']);
  const embeddings = makeEmbeddings(chunks);

  const corpus = await getOrBuildCorpus(
    source,
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  assert.deepStrictEqual(corpus.source, source);

  const loaded = await loadCorpusById(corpus.corpusId, { cacheDir });
  assert.ok(loaded !== null);
  assert.deepStrictEqual(loaded.source, source);
});

// ────────────────────────────────────────────────────────────────────
// 13. Atomic writes leave no temp files behind
// ────────────────────────────────────────────────────────────────────

test('SQLite cache: no legacy per-corpus files or temp files remain after successful write', async () => {
  const cacheDir = makeTmpCacheDir();
  const chunks = makeChunks(['atomic write test']);
  const embeddings = makeEmbeddings(chunks);

  await getOrBuildCorpus(
    TEST_SOURCE,
    async () => ({ chunks, embeddings, model: 'm', contentHash: computeContentHash(chunks) }),
    { cacheDir },
  );

  const files = fs.readdirSync(cacheDir);
  const legacyFiles = files.filter(
    (f) => f.endsWith('.tmp') || f.endsWith('.json') || f.endsWith('.bin'),
  );
  assert.deepStrictEqual(legacyFiles, [], 'Expected no legacy/temp files in cache directory');
  assert.ok(files.includes('corpus-cache.sqlite'), 'Expected SQLite database in cache directory');
});

test('byte-weighted LRU eviction uses maxTotalBytes, not only corpus count', async () => {
  const cacheDir = makeTmpCacheDir();
  const firstChunks = makeChunks(['a'.repeat(1200)]);
  const firstEmbeddings = makeEmbeddings(firstChunks, 8);
  const first = await getOrBuildCorpus(
    { type: 'url', url: 'https://bytes-a.com' },
    async () => ({
      chunks: firstChunks,
      embeddings: firstEmbeddings,
      model: 'm',
      contentHash: computeContentHash(firstChunks),
    }),
    { cacheDir, maxCorpora: 10, maxTotalBytes: 2000 },
  );

  await new Promise((r) => setTimeout(r, 5));

  const secondChunks = makeChunks(['b'.repeat(1200)]);
  const secondEmbeddings = makeEmbeddings(secondChunks, 8);
  const second = await getOrBuildCorpus(
    { type: 'url', url: 'https://bytes-b.com' },
    async () => ({
      chunks: secondChunks,
      embeddings: secondEmbeddings,
      model: 'm',
      contentHash: computeContentHash(secondChunks),
    }),
    { cacheDir, maxCorpora: 10, maxTotalBytes: 2000 },
  );

  assert.equal(
    await loadCorpusById(first.corpusId, { cacheDir }),
    null,
    'Expected oldest corpus evicted by total byte cap',
  );
  assert.ok(
    await loadCorpusById(second.corpusId, { cacheDir }),
    'Expected newest corpus to remain',
  );
});
