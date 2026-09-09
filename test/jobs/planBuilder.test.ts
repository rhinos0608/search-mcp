import assert from 'node:assert/strict';
import test from 'node:test';

import { SEEK_DESTINATION_CLASS } from '../../src/jobs/acquisition/destinationClass.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import {
  buildPlan,
  deriveJobsRunBudget,
  deriveStageBudgets,
  shareBudget,
  supportingIndexedProviderCount,
} from '../../src/tools/jobs/planBuilder.js';

function port(providerId: string, backend: string, withEnrichUrls = true): IndexedProviderPort {
  return {
    backend: backend as IndexedProviderPort['backend'],
    adapterId: `indexed-provider:${backend}`,
    providerId,
    governance: {
      schemaVersion: '1.0.0',
      providerId,
      sourcePolicyId: providerId,
      mode: 'automatedSearch',
      queryHandling: 'raw',
      resultRetention: 'bounded_cache',
      sendsQueryOffDevice: true,
      supportsUrlAttributedSummary: backend === 'exa' || backend === 'tavily',
      supportsStrictSafeSearch: true,
      maxResultsPerRequest: backend === 'exa' ? 50 : 20,
      maxAttempts: 3,
      evidenceRefs: [],
    },
    maxDurationMs: 70000,
    search: async () => [],
    ...(withEnrichUrls && (backend === 'exa' || backend === 'tavily')
      ? { enrichUrls: async () => [] as never[] }
      : {}),
  };
}

test('SEEK includeDomains is filter intent, not publisher identity', () => {
  assert.equal(SEEK_DESTINATION_CLASS.id, 'board:seek');
  assert.ok(SEEK_DESTINATION_CLASS.includeDomains.includes('seek.com.au'));
});

test('shareBudget remainder goes to first ordinals and may be zero', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => shareBudget(1, i, 5)),
    [1, 0, 0, 0, 0],
  );
  assert.deepEqual(
    [0, 1].map((i) => shareBudget(20, i, 2)),
    [10, 10],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => shareBudget(20, i, 5)),
    [4, 4, 4, 4, 4],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((i) => shareBudget(20, i, 7)),
    [3, 3, 3, 3, 3, 3, 2],
  );
});

test('deriveStageBudgets makes topK=50 acquisition-reachable', () => {
  assert.deepEqual(deriveStageBudgets(10), {
    acquisitionCandidates: 20,
    indexedEnrichment: 10,
    deepExtraction: 20,
    finalResults: 10,
  });
  assert.deepEqual(deriveStageBudgets(50), {
    acquisitionCandidates: 100,
    indexedEnrichment: 10,
    deepExtraction: 20,
    finalResults: 50,
  });
});

test('buildPlan 4-arg still emits one broad indexed slice per provider', () => {
  const plan = buildPlan({ query: 'registry officer' }, 'run-1', ['search-provider:brave'], []);
  assert.equal(plan.length, 1);
  const item = plan[0] as { kind: string; queryVariantId?: string; aiSummary?: string };
  assert.equal(item.kind, 'indexed');
  assert.equal((plan[0] as { slice: { queryVariantId: string } }).slice.queryVariantId, 'qv-broad');
  assert.equal((plan[0] as { aiSummary?: string }).aiSummary, undefined);
  assert.equal((plan[0] as { destinationClass?: unknown }).destinationClass, undefined);
});

test('4-arg buildPlan with one exa provider assigns the full stage candidate pool to its slice', () => {
  // Without ctx no class slices are emitted, so sliceCount must not count
  // classProviderIds: one slice receives deriveStageBudgets(10).acquisitionCandidates.
  const plan = buildPlan({ query: 'registry officer' }, 'run-exa', ['search-provider:exa'], []);
  assert.equal(plan.length, 1);
  const slice = (plan[0] as { slice: { queryVariantId: string; budget: { candidates: number } } })
    .slice;
  assert.equal(slice.queryVariantId, 'qv-broad');
  assert.equal(slice.budget.candidates, deriveStageBudgets(10).acquisitionCandidates);
});

test('supporting-provider criteria requires enrichUrls and is shared by slice and run budgets', () => {
  const exa = port('search-provider:exa', 'exa', false);
  const withEnrich = { ...exa, enrichUrls: async () => [] as never[] };
  assert.equal(supportingIndexedProviderCount([withEnrich]), 1);
  // supportsUrlAttributedSummary alone is not enough — enrichUrls must exist.
  assert.equal(supportingIndexedProviderCount([exa]), 0);
  const stage = deriveStageBudgets(10);
  const plan = buildPlan({ query: 'nurse sydney' }, 'run-lr', [exa.providerId], [], {
    topK: 10,
    ports: [withEnrich],
    stageBudgets: stage,
  });
  const run = deriveJobsRunBudget(plan.length, supportingIndexedProviderCount([withEnrich]), stage);
  const sliceLogical = plan.reduce(
    (acc, item) =>
      acc +
      (item as { slice: { budget: { logicalRequests: number } } }).slice.budget.logicalRequests,
    0,
  );
  assert.equal(sliceLogical, run.logicalRequests);
});

test('Exa and Tavily get SEEK class slices with includeDomains; Brave omitted', () => {
  const ports = [
    port('search-provider:brave', 'brave'),
    port('search-provider:exa', 'exa'),
    port('search-provider:tavily', 'tavily'),
  ];
  const plan = buildPlan(
    { query: 'nurse sydney' },
    'run-1',
    ports.map((p) => p.providerId),
    [],
    {
      topK: 10,
      ports,
      stageBudgets: deriveStageBudgets(10),
      informationalEdgesFor: (sourceId, providerId) => {
        assert.equal(sourceId, SEEK_DESTINATION_CLASS.id);
        return [
          {
            edgeId: `info-${providerId}-search` as never,
            schemaVersion: '1.0.0',
            actor: { kind: 'provider', namespace: 'search-provider', id: providerId },
            operation: 'automatedSearch',
            route: 'direct',
            target: { kind: 'board', sourceId: 'board:seek' },
            state: 'blocked',
            effect: 'informational_capability',
            revision: 'test',
            evidenceRefs: ['ev-1'],
            reviewedAt: '2026-07-20T00:00:00.000Z',
          },
        ];
      },
    },
  );
  const indexed = plan.filter((p) => p.kind === 'indexed');
  assert.equal(indexed.length, 5);
  const variants = indexed.map((p) => ({
    providerId: p.providerId,
    qv: p.slice.queryVariantId,
    dest: p.destinationClass?.sourceId,
    domains: p.includeDomains,
    summary: p.aiSummary,
  }));
  assert.deepEqual(
    variants.map((v) => [v.providerId, v.qv, v.dest ?? null, v.summary ?? null]),
    [
      ['search-provider:brave', 'qv-broad', null, null],
      ['search-provider:exa', 'qv-broad', null, null],
      ['search-provider:tavily', 'qv-broad', null, null],
      ['search-provider:exa', 'qv-seek', 'board:seek', null],
      ['search-provider:tavily', 'qv-seek', 'board:seek', null],
    ],
  );
  const seekSlices = indexed.filter((p) => p.slice.queryVariantId === 'qv-seek');
  for (const slice of seekSlices) {
    assert.deepEqual(slice.includeDomains, [...SEEK_DESTINATION_CLASS.includeDomains]);
    assert.equal(slice.destinationClass?.targetKind, 'board');
    assert.equal(slice.aiSummary, undefined);
    assert.ok(slice.informationalEdges?.every((e) => e.effect === 'informational_capability'));
    assert.ok(slice.informationalEdges?.every((e) => e.state === 'blocked'));
  }
  const brave = indexed.filter((p) => p.providerId === 'search-provider:brave');
  assert.equal(brave.length, 1);
  assert.equal(brave[0]?.includeDomains, undefined);
});
