import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClusterMerge,
  applyClusterSplit,
  applyClusterKeep,
  validateClusterDecisions,
} from '../../src/research/clusterRevision.js';
import type { FindingCluster, ClusterRevisionDecision } from '../../src/research/types.js';

function makeCluster(overrides: Partial<FindingCluster> = {}): FindingCluster {
  return {
    id: 'fc-001',
    findingIds: ['f1', 'f2'],
    representativeClaim: 'Test claim',
    method: 'hybrid',
    confidence: 0.85,
    edges: [
      {
        leftFindingId: 'f1',
        rightFindingId: 'f2',
        method: 'vector',
        relation: 'near_duplicate',
        strength: 'strong',
        score: 0.9,
        rationale: 'Test edge',
        semanticScore: 0.9,
      },
    ],
    strongEdges: [],
    weakEdges: [],
    bridgeEdges: [],
    relationCounts: { near_duplicate: 1 },
    mergeStatus: 'needs_llm_review',
    ...overrides,
  };
}

// ── applyClusterMerge ──────────────────────────────────────────────────────────

test('applyClusterMerge happy path — two clusters merge into one', () => {
  const a = makeCluster({ id: 'fc-001', findingIds: ['f1', 'f2'] });
  const b = makeCluster({ id: 'fc-002', findingIds: ['f3', 'f4'] });
  const decision: ClusterRevisionDecision = {
    action: 'merge',
    clusterIds: ['fc-001', 'fc-002'],
    reasoning: 'Merge related findings',
  };

  const result = applyClusterMerge([a, b], decision);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001+fc-002');
  assert.deepStrictEqual(result[0]!.findingIds, ['f1', 'f2', 'f3', 'f4']);
  assert.strictEqual(result[0]!.mergeStatus, 'llm_merged');
  assert.strictEqual(result[0]!.confidence, 0.85); // max of 0.85 and 0.85
});

test('applyClusterMerge missing cluster IDs — returns unchanged', () => {
  const a = makeCluster({ id: 'fc-001' });
  const decision: ClusterRevisionDecision = {
    action: 'merge',
    clusterIds: [],
    reasoning: 'Empty',
  };

  const result = applyClusterMerge([a], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterMerge non-existent cluster — returns unchanged', () => {
  const a = makeCluster({ id: 'fc-001' });
  const decision: ClusterRevisionDecision = {
    action: 'merge',
    clusterIds: ['fc-001', 'fc-999'],
    reasoning: 'Non-existent',
  };

  const result = applyClusterMerge([a], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterMerge edge filtering — only edges within merged set', () => {
  const a = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2'],
    edges: [
      { leftFindingId: 'f1', rightFindingId: 'f2', method: 'vector', relation: 'near_duplicate', strength: 'strong', score: 0.9, rationale: 'Edge A', semanticScore: 0.9 },
    ],
  });
  const b = makeCluster({
    id: 'fc-002',
    findingIds: ['f3', 'f4'],
    edges: [
      { leftFindingId: 'f3', rightFindingId: 'f4', method: 'direct', relation: 'supports', strength: 'strong', score: 0.8, rationale: 'Edge B' },
    ],
  });

  const decision: ClusterRevisionDecision = {
    action: 'merge',
    clusterIds: ['fc-001', 'fc-002'],
    reasoning: 'Merge',
  };

  const result = applyClusterMerge([a, b], decision);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.edges.length, 2);
});

// ── applyClusterSplit ──────────────────────────────────────────────────────────

test('applyClusterSplit happy path — splits into 2 sub-clusters', () => {
  const cluster = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2', 'f3', 'f4'],
    confidence: 0.8,
    edges: [
      { leftFindingId: 'f1', rightFindingId: 'f2', method: 'vector', relation: 'near_duplicate', strength: 'strong', score: 0.9, rationale: 'e1', semanticScore: 0.9 },
      { leftFindingId: 'f3', rightFindingId: 'f4', method: 'lexical', relation: 'supports', strength: 'weak', score: 0.6, rationale: 'e2' },
    ],
  });

  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'Split into two groups',
    splitGroupIndices: { f1: 0, f2: 0, f3: 1, f4: 1 },
  };

  const result = applyClusterSplit([cluster], decision);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0]!.id, 'fc-001-0');
  assert.deepStrictEqual(result[0]!.findingIds, ['f1', 'f2']);
  assert.strictEqual(result[0]!.mergeStatus, 'llm_split');
  assert.strictEqual(result[1]!.id, 'fc-001-1');
  assert.deepStrictEqual(result[1]!.findingIds, ['f3', 'f4']);
  assert.strictEqual(result[1]!.mergeStatus, 'llm_split');
});

test('applyClusterSplit missing splitGroupIndices — returns unchanged', () => {
  const cluster = makeCluster({ id: 'fc-001', findingIds: ['f1', 'f2'] });
  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'No group indices',
  };

  const result = applyClusterSplit([cluster], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterSplit fewer than 2 groups — returns unchanged', () => {
  const cluster = makeCluster({ id: 'fc-001', findingIds: ['f1', 'f2'] });
  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'All in one group',
    splitGroupIndices: { f1: 0, f2: 0 },
  };

  const result = applyClusterSplit([cluster], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterSplit non-member finding IDs filtered — 3rd finding filtered out, valid 2 groups remain', () => {
  const cluster = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2'],
    confidence: 0.8,
  });

  // f3 is not in the cluster but groupIndex says it's in group 0
  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'Split with non-member ID',
    splitGroupIndices: { f1: 0, f2: 1, f3: 0 },
  };

  const result = applyClusterSplit([cluster], decision);

  // f3 filtered out, f1 in group 0, f2 in group 1 → 2 groups still valid
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0]!.id, 'fc-001-0');
  assert.deepStrictEqual(result[0]!.findingIds, ['f1']);
  assert.strictEqual(result[1]!.id, 'fc-001-1');
  assert.deepStrictEqual(result[1]!.findingIds, ['f2']);
});

test('applyClusterSplit non-member finding IDs filtered — after filtering, only 1 group remains', () => {
  const cluster = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2'],
    confidence: 0.8,
  });

  // f1 in group 0, f2 in group 0 — both valid, only 1 group
  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'All valid but still 1 group after filter',
    splitGroupIndices: { f1: 0, f2: 0 },
  };

  const result = applyClusterSplit([cluster], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterSplit non-member finding IDs — filters out all invalid entries, leaving 2 valid groups', () => {
  const cluster = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2'],
    confidence: 0.8,
  });

  // f3 is not in cluster; after filtering f3 out, only f1:0 remains
  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'Only non-member entries',
    splitGroupIndices: { f1: 0, f2: 0, f3: 1 },
  };

  const result = applyClusterSplit([cluster], decision);

  // After filtering f3 out: f1→0, f2→0 → only 1 group → unchanged
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

test('applyClusterSplit proportional confidence — sub-cluster confidence is scaled', () => {
  const cluster = makeCluster({
    id: 'fc-001',
    findingIds: ['f1', 'f2', 'f3', 'f4'],
    confidence: 0.8,
  });

  const decision: ClusterRevisionDecision = {
    action: 'split',
    clusterIds: ['fc-001'],
    reasoning: 'Split',
    splitGroupIndices: { f1: 0, f2: 0, f3: 1, f4: 1 },
  };

  const result = applyClusterSplit([cluster], decision);

  // group 0 has 2 of 4 findings → 0.8 * 2/4 = 0.4
  assert.strictEqual(result[0]!.confidence, 0.4);
  // group 1 has 2 of 4 findings → 0.8 * 2/4 = 0.4
  assert.strictEqual(result[1]!.confidence, 0.4);
});

// ── applyClusterKeep ───────────────────────────────────────────────────────────

test('applyClusterKeep happy path — mergeStatus changes to llm_kept', () => {
  const a = makeCluster({ id: 'fc-001' });
  const b = makeCluster({ id: 'fc-002' });

  const decision: ClusterRevisionDecision = {
    action: 'keep',
    clusterIds: ['fc-001'],
    reasoning: 'Keep this cluster',
  };

  const result = applyClusterKeep([a, b], decision);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0]!.id, 'fc-001');
  assert.strictEqual(result[0]!.mergeStatus, 'llm_kept');
  assert.strictEqual(result[1]!.id, 'fc-002');
  assert.strictEqual(result[1]!.mergeStatus, 'needs_llm_review');
});

test('applyClusterKeep missing cluster ID — returns unchanged', () => {
  const a = makeCluster({ id: 'fc-001' });
  const decision: ClusterRevisionDecision = {
    action: 'keep',
    clusterIds: [],
    reasoning: 'Empty',
  };

  const result = applyClusterKeep([a], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.mergeStatus, 'needs_llm_review');
});

test('applyClusterKeep non-existent cluster — returns unchanged', () => {
  const a = makeCluster({ id: 'fc-001' });
  const decision: ClusterRevisionDecision = {
    action: 'keep',
    clusterIds: ['fc-999'],
    reasoning: 'Non-existent',
  };

  const result = applyClusterKeep([a], decision);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, 'fc-001');
});

// ── validateClusterDecisions ───────────────────────────────────────────────────

test('validateClusterDecisions no conflicts — all pass through', () => {
  const decisions: ClusterRevisionDecision[] = [
    { action: 'merge', clusterIds: ['fc-001', 'fc-002'], reasoning: 'Merge A and B' },
    { action: 'keep', clusterIds: ['fc-003'], reasoning: 'Keep C' },
    { action: 'abstain', clusterIds: ['fc-004'], reasoning: 'Abstain on D' },
  ];

  const result = validateClusterDecisions(decisions);
  assert.strictEqual(result.length, 3);
});

test('validateClusterDecisions conflict detection — second merge referencing same cluster filtered out', () => {
  const decisions: ClusterRevisionDecision[] = [
    { action: 'merge', clusterIds: ['fc-001', 'fc-002'], reasoning: 'Merge A and B' },
    { action: 'merge', clusterIds: ['fc-001', 'fc-003'], reasoning: 'Also merge A and C — conflict' },
  ];

  const result = validateClusterDecisions(decisions);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.clusterIds[0], 'fc-001');
});

test('validateClusterDecisions abstain consumes cluster — later merge on same cluster filtered out', () => {
  const decisions: ClusterRevisionDecision[] = [
    { action: 'abstain', clusterIds: ['fc-001'], reasoning: 'Abstain on A' },
    { action: 'merge', clusterIds: ['fc-001', 'fc-002'], reasoning: 'Merge A and B — conflict' },
  ];

  const result = validateClusterDecisions(decisions);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.action, 'abstain');
});

test('validateClusterDecisions empty decisions — returns empty array', () => {
  const result = validateClusterDecisions([]);
  assert.strictEqual(result.length, 0);
});

test('validateClusterDecisions mixed actions on different clusters — all pass through', () => {
  const decisions: ClusterRevisionDecision[] = [
    { action: 'merge', clusterIds: ['fc-001', 'fc-002'], reasoning: 'Merge' },
    { action: 'split', clusterIds: ['fc-003'], reasoning: 'Split', splitGroupIndices: { f1: 0, f2: 1 } },
    { action: 'keep', clusterIds: ['fc-004'], reasoning: 'Keep' },
    { action: 'abstain', clusterIds: ['fc-005'], reasoning: 'Abstain' },
  ];

  const result = validateClusterDecisions(decisions);
  assert.strictEqual(result.length, 4);
});
