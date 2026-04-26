import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeByUrl,
  dedupeByFingerprint,
  dedupeBySemantic,
  deduplicateCorpus,
  normalizeUrl,
  computeFingerprint,
  selectPreferred,
  clusterBySimilarity,
} from '../src/rag/dedup.js';

// ── dedupeByUrl ───────────────────────────────────────────────────────────

test('dedupeByUrl removes exact URL duplicates', () => {
  const items = [
    { url: 'https://example.com/job1', text: 'Job 1' },
    { url: 'https://example.com/job1', text: 'Job 1 dup' },
    { url: 'https://example.com/job2', text: 'Job 2' },
  ];
  const result = dedupeByUrl(items);
  assert.equal(result.items.length, 2);
  assert.equal(result.layers[0]!.removed, 1);
});

test('dedupeByUrl normalizes URLs before comparison', () => {
  const items = [
    { url: 'https://example.com/job?tracking=123', text: 'Job 1' },
    { url: 'https://example.com/job', text: 'Job 1 no tracking' },
  ];
  const result = dedupeByUrl(items, { normalize: true, removeTracking: true });
  assert.equal(result.items.length, 1);
});

// ── normalizeUrl ────────────────────────────────────────────────────────────

test('normalizeUrl removes UTM parameters', () => {
  const raw = 'https://example.com/job?utm_source=google&id=123';
  const normalized = normalizeUrl(raw);
  assert.ok(!normalized.includes('utm_source'));
  assert.ok(normalized.includes('id=123'));
});

test('normalizeUrl sorts remaining parameters', () => {
  const raw = 'https://example.com/job?z=1&a=2';
  const normalized = normalizeUrl(raw);
  assert.ok(normalized.indexOf('a=') < normalized.indexOf('z='));
});

// ── computeFingerprint ────────────────────────────────────────────────────

test('computeFingerprint returns consistent hash for same text', () => {
  const fp1 = computeFingerprint('Hello World');
  const fp2 = computeFingerprint('Hello World');
  assert.equal(fp1, fp2);
});

test('computeFingerprint returns different hash for different text', () => {
  const fp1 = computeFingerprint('Hello World');
  const fp2 = computeFingerprint('Goodbye World');
  assert.notEqual(fp1, fp2);
});

// ── dedupeByFingerprint ───────────────────────────────────────────────────

test('dedupeByFingerprint removes near-duplicate content', () => {
  const items = [
    { id: '1', text: 'Software Engineer role at TechCorp. Requirements: Python, React.' },
    {
      id: '2',
      text: 'Software Engineer role at TechCorp. Requirements: Python, React, TypeScript.',
    },
    { id: '3', text: '完全不同的工作内容在这里' },
  ];
  const result = dedupeByFingerprint(items, 0.8);
  assert.ok(result.items.length < 3);
});

// ── clusterBySimilarity ─────────────────────────────────────────────────────

test('clusterBySimilarity groups similar embeddings', () => {
  const embeddings = [
    [1, 0.9, 0.1],
    [0.95, 0.85, 0.15],
    [0.1, 0.2, 1.0],
  ];
  const clusters = clusterBySimilarity(embeddings, 0.85);
  assert.equal(clusters.length, 2); // First two cluster together
});

test('clusterBySimilarity puts each item in exactly one cluster', () => {
  const embeddings = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const clusters = clusterBySimilarity(embeddings, 0.99);
  const total = clusters.reduce((sum, c) => sum + c.length, 0);
  assert.equal(total, 3);
  assert.equal(clusters.length, 3);
});

// ── dedupeBySemantic ────────────────────────────────────────────────────────

test('dedupeBySemantic clusters similar items by embedding', async () => {
  const items = [
    { id: '1', text: 'Senior Software Engineer position' },
    { id: '2', text: 'Senior Software Developer role' },
    { id: '3', text: 'Marketing Manager position' },
  ];

  const mockEmbed = async (texts: string[]) => {
    return texts.map((t) => {
      if (t.includes('Engineer') || t.includes('Developer')) return [1, 0.9, 0.1];
      return [0.1, 0.2, 1];
    });
  };

  const result = await dedupeBySemantic(items, 0.85, mockEmbed);
  assert.equal(result.items.length, 2); // Engineer and Developer should cluster
});

test('dedupeBySemantic throws when embedFn is missing and embeddings are absent', async () => {
  const items = [{ id: '1', text: 'Hello' }];
  await assert.rejects(async () => dedupeBySemantic(items, 0.9));
});

// ── selectPreferred ─────────────────────────────────────────────────────────

test('selectPreferred returns only item for single-element array', () => {
  const item = { text: 'a' };
  assert.deepEqual(selectPreferred([item], 'mostComplete'), item);
});

test('selectPreferred throws for empty array', () => {
  assert.throws(() => selectPreferred([], 'mostComplete'));
});

test('selectPreferred picks longest text for mostComplete', () => {
  const items = [{ text: 'short' }, { text: 'this is much longer' }, { text: 'tiny' }];
  const selected = selectPreferred(items, 'mostComplete');
  assert.equal((selected as { text: string }).text, 'this is much longer');
});

test('selectPreferred uses scoreFn for highestScore', () => {
  const items = [{ score: 1 }, { score: 5 }, { score: 3 }];
  const selected = selectPreferred(items, 'highestScore', (i) => (i as { score: number }).score);
  assert.equal((selected as { score: number }).score, 5);
});

// ── deduplicateCorpus ──────────────────────────────────────────────────────

test('deduplicateCorpus runs all three layers in sequence', async () => {
  const config = {
    layers: { url: true, fingerprint: true, semantic: true },
    fingerprintThreshold: 0.95,
    semanticThreshold: 0.85,
    preferKeep: 'mostComplete' as const,
  };

  const items = [
    { id: '1', url: 'https://example.com/job1', text: 'Engineer role' },
    { id: '2', url: 'https://example.com/job1', text: 'Engineer role duplicate' },
    { id: '3', url: 'https://example.com/job2', text: 'Engineer position' },
  ];

  const result = await deduplicateCorpus(items, config, async (texts) =>
    texts.map(() => [0.1, 0.2, 0.3]),
  );
  assert.equal(result.layers.length, 3);
  assert.ok(result.totalTimeMs >= 0);
  assert.ok(result.items.length <= 3);
});

test('deduplicateCorpus handles disabled layers', async () => {
  const config = {
    layers: { url: true, fingerprint: false, semantic: false },
    fingerprintThreshold: 0.95,
    semanticThreshold: 0.85,
    preferKeep: 'mostComplete' as const,
  };

  const items = [
    { id: '1', url: 'https://example.com/job1', text: 'Engineer role' },
    { id: '2', url: 'https://example.com/job1', text: 'Engineer role dup' },
  ];

  const result = await deduplicateCorpus(items, config);
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0]!.name, 'url');
});
