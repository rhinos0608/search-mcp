import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings } from '../../src/research/claimClustering.js';
import type { Finding, NormalizedClaimKey } from '../../src/research/types.js';

function makeCanonicalKey(
  subject: string,
  predicate: string,
  quantifierCanonical?: string,
): NormalizedClaimKey {
  const key: NormalizedClaimKey = { subject, predicate };
  if (quantifierCanonical) key.quantifierCanonical = quantifierCanonical;
  return key;
}

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, 'id' | 'claim' | 'normalizedClaim' | 'sourceIds'>,
): Finding {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...overrides,
    id: overrides.id,
    claim: overrides.claim,
    normalizedClaim: overrides.normalizedClaim,
    subQuestionIds: overrides.subQuestionIds ?? ['sq1'],
    sourceIds: overrides.sourceIds,
    evidenceSummary: overrides.evidenceSummary ?? overrides.claim,
    evidenceDirectness: overrides.evidenceDirectness ?? 'direct',
    freshnessSensitive: overrides.freshnessSensitive ?? false,
    lastUpdated: overrides.lastUpdated ?? now,
    claimType: overrides.claimType ?? 'primary',
    createdAt: overrides.createdAt ?? now,
  };
}

test('clusterFindings matches whitespace canonical keys and counts every source id', () => {
  const result = clusterFindings([
    makeFinding({
      id: 'f1',
      claim: 'OpenAI research releases model',
      normalizedClaim: 'openai research releases model',
      sourceIds: ['s1', 's2'],
      canonicalKey: makeCanonicalKey('OpenAI research', 'releases model'),
      polarity: 'asserted',
    }),
    makeFinding({
      id: 'f2',
      claim: 'OpenAI research lab releases model',
      normalizedClaim: 'openai research lab releases model',
      sourceIds: ['s2', 's3'],
      canonicalKey: makeCanonicalKey('OpenAI research lab', 'releases model'),
      polarity: 'asserted',
    }),
  ]);

  assert.equal(result.clusters.length, 1);
  assert.equal(result.totalSources, 3);
  assert.deepEqual(result.clusters[0]?.findingIds.sort(), ['f1', 'f2']);
});

test('clusterFindings returns mixed for two sources with asserted and hedged claims', () => {
  const result = clusterFindings([
    makeFinding({
      id: 'f1',
      claim: 'System improves throughput',
      normalizedClaim: 'system improves throughput',
      sourceIds: ['s1'],
      canonicalKey: makeCanonicalKey('System', 'improves throughput'),
      polarity: 'asserted',
      hedge: 'certain',
    }),
    makeFinding({
      id: 'f2',
      claim: 'System improves throughput',
      normalizedClaim: 'system improves throughput',
      sourceIds: ['s2'],
      canonicalKey: makeCanonicalKey('System', 'improves throughput'),
      polarity: 'asserted',
      hedge: 'possible',
    }),
  ]);

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]?.consensus, 'mixed');
});

test('clusterFindings returns mixed when a cluster has agreement and uncertainty', () => {
  const result = clusterFindings([
    makeFinding({
      id: 'f1',
      claim: 'System improves throughput',
      normalizedClaim: 'system improves throughput',
      sourceIds: ['s1'],
      canonicalKey: makeCanonicalKey('System', 'improves throughput'),
      polarity: 'asserted',
      hedge: 'certain',
    }),
    makeFinding({
      id: 'f2',
      claim: 'System improves throughput',
      normalizedClaim: 'system improves throughput',
      sourceIds: ['s2'],
      canonicalKey: makeCanonicalKey('System', 'improves throughput'),
      polarity: 'asserted',
      hedge: 'certain',
    }),
    makeFinding({
      id: 'f3',
      claim: 'System improves throughput',
      normalizedClaim: 'system improves throughput',
      sourceIds: ['s3'],
      canonicalKey: makeCanonicalKey('System', 'improves throughput'),
      polarity: 'conditional',
      hedge: 'possible',
    }),
  ]);

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]?.consensus, 'mixed');
});

test('clusterFindings keeps empty-key findings unclustered', () => {
  const result = clusterFindings([
    makeFinding({
      id: 'empty',
      claim: 'a an of to',
      normalizedClaim: 'a an of to',
      sourceIds: ['s1'],
      polarity: 'asserted',
    }),
  ]);

  assert.deepEqual(result.unclustered, ['empty']);
});
