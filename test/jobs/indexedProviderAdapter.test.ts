import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionSliceResultSchema,
  ProviderGovernanceSchema,
} from '../../src/jobs/acquisition/contracts.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_ADAPTER_VERSION,
  runIndexedProvider,
} from '../../src/jobs/acquisition/providers/indexed.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  createDefaultIndexedProviderPorts,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SearchResult } from '../../src/types.js';
import { isToolError } from '../../src/errors.js';

function makeSlice(
  overrides: Record<string, unknown> = {},
): import('../../src/jobs/acquisition/contracts.js').AcquisitionSlice {
  const base: Record<string, unknown> = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'test',
    adapterIds: ['indexed-provider:brave'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  };
  return {
    ...base,
    ...overrides,
  } as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionSlice;
}

function makeExecutionEdge(
  port: IndexedProviderPort,
  state = 'permitted',
): import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge {
  return {
    edgeId:
      `edge-${port.providerId}-${state}` as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge['edgeId'],
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    actor: { kind: 'provider', namespace: 'search-provider', id: port.providerId },
    operation: 'automatedSearch',
    route: 'indexed',
    target: { kind: 'discovery_provider', sourceId: port.providerId },
    state: state as never,
    effect: 'authorized_operation',
    revision: 'rev-1',
    evidenceRefs: [],
    reviewedAt: new Date().toISOString(),
  };
}

function makeInfoEdge(
  target: { kind: string; sourceId: string },
  state = 'blocked',
  operation: string = 'automatedSearch',
): import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge {
  return {
    edgeId:
      `info-${target.sourceId}-${state}-${operation}` as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge['edgeId'],
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    actor: { kind: 'provider', namespace: 'search-provider', id: 'search-provider:tavily' },
    operation: operation as never,
    route: 'direct',
    target: target as never,
    state: state as never,
    effect: 'informational_capability',
    revision: 'rev-1',
    evidenceRefs: [],
    reviewedAt: new Date().toISOString(),
  };
}

function registryWith(port: IndexedProviderPort): AdapterCapabilityRegistry {
  return new AdapterCapabilityRegistry(indexedProviderCapabilities([port]));
}
function emptyRegistry(): AdapterCapabilityRegistry {
  return new AdapterCapabilityRegistry([]);
}

function mockPort(
  overrides: Partial<IndexedProviderPort> & { searchFn?: IndexedProviderPort['search'] },
): IndexedProviderPort {
  const baseDef = INDEXED_PROVIDER_DEFINITIONS[0]!;
  const gov = overrides.governance ?? baseDef.governance;
  return {
    backend: (overrides.backend ?? baseDef.backend) as never,
    adapterId: overrides.adapterId ?? baseDef.adapterId,
    providerId: overrides.providerId ?? baseDef.providerId,
    governance: gov,
    maxDurationMs: overrides.maxDurationMs ?? 70000,
    search: overrides.searchFn ?? (async () => []),
  };
}

function validResult(url: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Title',
    url,
    description: 'snippet text',
    position: 1,
    domain: 'example.test',
    source: 'brave',
    age: null,
    ageKind: 'unknown',
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet',
    generatedSummary: null,
    ...overrides,
  } as SearchResult;
}

// version
test('INDEXED_PROVIDER_ADAPTER_VERSION is 1.0.0', () => {
  assert.equal(INDEXED_PROVIDER_ADAPTER_VERSION, '1.0.0');
});

// definitions validate
test('all seven definitions validate governance and table', () => {
  assert.equal(INDEXED_PROVIDER_DEFINITIONS.length, 7);
  const expected: Array<{ backend: string; summary: boolean; strict: boolean; attempts: number }> =
    [
      { backend: 'brave', summary: false, strict: true, attempts: 3 },
      { backend: 'searxng', summary: false, strict: true, attempts: 2 },
      { backend: 'exa', summary: true, strict: true, attempts: 3 },
      { backend: 'duckduckgo', summary: false, strict: true, attempts: 2 },
      { backend: 'ollama-search', summary: false, strict: false, attempts: 2 },
      { backend: 'tavily', summary: true, strict: false, attempts: 3 },
      { backend: 'codex', summary: false, strict: false, attempts: 3 },
    ];
  for (const exp of expected) {
    const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === exp.backend);
    assert.ok(def, `missing ${exp.backend}`);
    assert.equal(def!.adapterId, `indexed-provider:${exp.backend}`);
    assert.equal(def!.providerId, `search-provider:${exp.backend}`);
    assert.equal(def!.maxDurationMs, 70000);
    const gov = def!.governance;
    ProviderGovernanceSchema.parse(gov);
    assert.equal(gov.resultRetention, 'bounded_cache');
    assert.equal(gov.sendsQueryOffDevice, true);
    assert.equal(gov.supportsUrlAttributedSummary, exp.summary);
    assert.equal(gov.supportsStrictSafeSearch, exp.strict);
    assert.equal(gov.maxAttempts, exp.attempts);
    assert.equal(gov.maxResultsPerRequest, 20);
    assert.equal(gov.mode, 'automatedSearch');
    assert.equal(gov.queryHandling, 'raw');
  }
});

test('createDefaultIndexedProviderPorts filters unavailable ports and preserves governance', async () => {
  const cfg = {
    brave: { apiKey: 'b' },
    searxng: { baseUrl: 'https://searxng.test' },
    exa: { apiKey: 'e' },
    tavily: { apiKey: 't' },
    duckduckgo: { region: 'us-en', safeSearch: 'moderate' },
    ollamaSearch: { baseUrl: '', apiKey: '' },
  } as unknown as import('../../src/config.js').SearchConfig;
  const ports = createDefaultIndexedProviderPorts(cfg);
  assert.ok(ports.length === 5 || ports.length === 6);
  assert.deepEqual(
    ports.map((p) => p.backend).filter((b) => b !== 'codex'),
    ['brave', 'searxng', 'exa', 'duckduckgo', 'tavily'],
  );
  for (const p of ports) {
    assert.equal(p.maxDurationMs, 70000);
    ProviderGovernanceSchema.parse(p.governance);
  }
});

test('indexedProviderCapabilities exact automatedSearch/indexed/discovery_provider', () => {
  const ports = INDEXED_PROVIDER_DEFINITIONS.map((d) =>
    mockPort({
      backend: d.backend as never,
      adapterId: d.adapterId,
      providerId: d.providerId,
      governance: d.governance,
    }),
  );
  const caps = indexedProviderCapabilities(ports as unknown as IndexedProviderPort[]);
  assert.equal(caps.length, 7);
  for (const c of caps) {
    assert.equal(c.edges.length, 1);
    assert.deepEqual(c.edges[0], {
      operation: 'automatedSearch',
      route: 'indexed',
      targetKind: 'discovery_provider',
    });
  }
});

// missing capability zero calls
test('missing capability makes zero calls and not_supported', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port, 'permitted');
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: emptyRegistry(), port },
  );
  assert.equal(calls, 0);
  assert.equal(res.sliceResult.coverage[0]!.state, 'not_supported');
  AcquisitionSliceResultSchema.parse(res.sliceResult);
});

// every non-permitted state zero calls
for (const state of [
  'blocked',
  'requires_configuration',
  'requires_review',
  'not_supported',
] as const) {
  test(`non-permitted state ${state} zero calls`, async () => {
    let calls = 0;
    const port = mockPort({
      searchFn: async () => {
        calls++;
        return [];
      },
    });
    const slice = makeSlice();
    const edge = makeExecutionEdge(port, state);
    const res = await runIndexedProvider(
      { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
      { capabilityRegistry: registryWith(port), port },
    );
    assert.equal(calls, 0);
    if (state === 'blocked') assert.equal(res.sliceResult.coverage[0]!.state, 'policy_blocked');
    else if (state === 'requires_configuration' || state === 'requires_review')
      assert.equal(res.sliceResult.coverage[0]!.state, 'disabled');
    else assert.equal(res.sliceResult.coverage[0]!.state, 'not_supported');
    assert.equal(res.sliceResult.candidates.length, 0);
    AcquisitionSliceResultSchema.parse(res.sliceResult);
  });
}

// short duration / attempt budget zero calls
test('short slice duration makes zero calls BUDGET_EXHAUSTED', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 1000,
    },
  });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(calls, 0);
  assert.equal(res.sliceResult.coverage[0]!.state, 'failed');
  assert.equal(res.sliceResult.coverage[0]!.errorCode, 'BUDGET_EXHAUSTED');
});

test('short attempt budget makes zero calls BUDGET_EXHAUSTED', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 1,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  }); // needs 3
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(calls, 0);
  assert.equal(res.sliceResult.coverage[0]!.state, 'failed');
});

// one provider invocation only
test('one provider invocation only', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [validResult('https://example.test/a'), validResult('https://example.test/b')];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(calls, 1);
  assert.equal(res.sliceResult.candidates.length, 2);
});

// valid unique credential-free canonical HTTP URLs to indexed_only
test('maps only valid unique credential-free canonical URLs to indexed_only', async () => {
  const port = mockPort({
    searchFn: async () => [
      validResult('https://example.test/a'),
      validResult('https://example.test/a#frag'), // same canonical after fragment removal -> deduped
      validResult('https://user:pass@example.test/b'), // credential -> discarded
      validResult('ftp://example.test/c'), // non-http -> discarded
      validResult('not a url'), // malformed
      validResult('https://example.test/d'),
      validResult('https://example.test/d'), // duplicate
    ],
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  // should have 2 unique valid: /a and /d
  assert.equal(res.sliceResult.candidates.length, 2);
  for (const c of res.sliceResult.candidates) assert.equal(c.state, 'indexed_only');
  assert.equal(res.sliceResult.observations.length, 0);
  const urls = res.sliceResult.candidates
    .map(
      (c) =>
        (c.provenance as unknown as { destination: { canonicalUrl: string } }).destination
          .canonicalUrl,
    )
    .sort();
  assert.deepEqual(urls, ['https://example.test/a', 'https://example.test/d']);
  // discoverer/donor concrete provider
  for (const c of res.sliceResult.candidates) {
    const prov = c.provenance as unknown as {
      discoverers: Array<{ providerId: string }>;
      contentDonor: { providerId: string };
    };
    assert.equal(prov.discoverers[0]!.providerId, port.providerId);
    assert.equal(prov.contentDonor.providerId, port.providerId);
  }
});

// publisher never from host/domain, only informational
test('host/domain never synthesizes publisher', async () => {
  const port = mockPort({
    searchFn: async () => [validResult('https://publisher.example.test/job/1')],
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  const prov = res.sliceResult.candidates[0]!.provenance as unknown as { publisher?: unknown };
  assert.equal(prov.publisher, undefined);
});

test('unambiguous informational target supplies publisher', async () => {
  const port = mockPort({ searchFn: async () => [validResult('https://example.test/a')] });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const info = makeInfoEdge({ kind: 'publisher', sourceId: 'publisher:acme' }, 'blocked');
  const res = await runIndexedProvider(
    {
      slice,
      executionEdge: edge,
      informationalEdges: [info],
      safeSearch: 'moderate',
      capturedAt: new Date().toISOString(),
    },
    { capabilityRegistry: registryWith(port), port },
  );
  const prov = res.sliceResult.candidates[0]!.provenance as unknown as {
    publisher?: { sourceId: string };
  };
  assert.deepEqual(prov.publisher, { kind: 'publisher', sourceId: 'publisher:acme' });
});

test('ambiguous informational publishers omit publisher', async () => {
  const port = mockPort({ searchFn: async () => [validResult('https://example.test/a')] });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const info1 = makeInfoEdge({ kind: 'publisher', sourceId: 'pub-a' }, 'blocked');
  const info2 = makeInfoEdge({ kind: 'board', sourceId: 'pub-b' }, 'blocked');
  const res = await runIndexedProvider(
    {
      slice,
      executionEdge: edge,
      informationalEdges: [info1, info2],
      safeSearch: 'moderate',
      capturedAt: new Date().toISOString(),
    },
    { capabilityRegistry: registryWith(port), port },
  );
  const prov = res.sliceResult.candidates[0]!.provenance as unknown as { publisher?: unknown };
  assert.equal(prov.publisher, undefined);
});

test('SearXNG upstreamEngines metadata only', async () => {
  const port = mockPort({
    backend: 'searxng' as never,
    adapterId: 'indexed-provider:searxng',
    providerId: 'search-provider:searxng',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'searxng')!.governance,
    searchFn: async () => [
      validResult('https://example.test/a', {
        upstreamEngines: ['Google', 'Bing'],
      } as unknown as Partial<SearchResult>),
    ],
  });
  const slice = makeSlice({ adapterIds: ['indexed-provider:searxng'] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  const disc = (
    res.sliceResult.candidates[0]!.provenance as unknown as {
      discoverers: Array<{ upstreamEngines?: string[] }>;
    }
  ).discoverers[0]!;
  assert.deepEqual(disc.upstreamEngines?.sort(), ['Bing', 'Google']);
  // no extra candidate for upstream
  assert.equal(res.sliceResult.candidates.length, 1);
});

// snippet vs summary vs generatedSummary
test('normal snippet maps to indexed_snippet capped 8192', async () => {
  const long = 'a'.repeat(9000);
  const port = mockPort({
    searchFn: async () => [
      validResult('https://example.test/a', { description: long, contentKind: 'snippet' }),
    ],
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.evidence[0]!.kind, 'indexed_snippet');
  assert.equal(
    (res.sliceResult.evidence[0]! as unknown as { boundedText: string }).boundedText.length,
    8192,
  );
});

test('contentKind summary including Tavily maps to provider_generated_summary', async () => {
  const port = mockPort({
    backend: 'tavily' as never,
    adapterId: 'indexed-provider:tavily',
    providerId: 'search-provider:tavily',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'tavily')!.governance,
    searchFn: async () => [
      validResult('https://example.test/a', {
        description: 'summary text',
        contentKind: 'summary',
      }),
    ],
  });
  const slice = makeSlice({ adapterIds: ['indexed-provider:tavily'] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.evidence[0]!.kind, 'provider_generated_summary');
  assert.equal(
    (res.sliceResult.evidence[0]! as unknown as { generatedBy: string }).generatedBy,
    port.providerId,
  );
});

test('matching generatedSummary including Exa maps exactly', async () => {
  const port = mockPort({
    backend: 'exa' as never,
    adapterId: 'indexed-provider:exa',
    providerId: 'search-provider:exa',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'exa')!.governance,
    searchFn: async () => [
      validResult('https://example.test/a', {
        description: 'snippet',
        generatedSummary: 'exa summary',
        generatedSummaryProvider: 'exa',
      }),
    ],
  });
  const slice = makeSlice({ adapterIds: ['indexed-provider:exa'] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.evidence.length, 2);
  const kinds = res.sliceResult.evidence.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['indexed_snippet', 'provider_generated_summary']);
  const summary = res.sliceResult.evidence.find(
    (e) => e.kind === 'provider_generated_summary',
  )! as unknown as { boundedText: string; generatedBy: string };
  assert.equal(summary.boundedText, 'exa summary');
  assert.equal(summary.generatedBy, port.providerId);
});

test('no usable text fallback provider_metadata', async () => {
  const port = mockPort({
    searchFn: async () => [
      validResult('https://example.test/a', {
        description: '   ',
        extraSnippet: null,
        generatedSummary: null,
      }),
    ],
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.evidence[0]!.kind, 'provider_metadata');
});

test('default caveats and W3-B informational caveats', async () => {
  const port = mockPort({ searchFn: async () => [validResult('https://example.test/a')] });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const info = makeInfoEdge({ kind: 'publisher', sourceId: 'pub' }, 'blocked', 'automatedSearch');
  const res = await runIndexedProvider(
    {
      slice,
      executionEdge: edge,
      informationalEdges: [info],
      safeSearch: 'moderate',
      capturedAt: new Date().toISOString(),
    },
    { capabilityRegistry: registryWith(port), port },
  );
  const caveats = res.sliceResult.candidates[0]!.caveats;
  assert.ok(caveats.includes('provider_index_only'));
  assert.ok(caveats.includes('publisher_not_fetched'));
  assert.ok(caveats.includes('stale_index_possible'));
  assert.ok(caveats.includes('direct_search_blocked'));
});

test('provider_generated_summary caveat added', async () => {
  const port = mockPort({
    backend: 'tavily' as never,
    adapterId: 'indexed-provider:tavily',
    providerId: 'search-provider:tavily',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'tavily')!.governance,
    searchFn: async () => [
      validResult('https://example.test/a', { description: 's', contentKind: 'summary' }),
    ],
  });
  const slice = makeSlice({ adapterIds: ['indexed-provider:tavily'] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.ok(res.sliceResult.candidates[0]!.caveats.includes('provider_generated_summary'));
});

test('candidate/evidence/byte/duration/attempt budgets enforced', async () => {
  const port = mockPort({
    searchFn: async () =>
      Array.from({ length: 30 }, (_, i) => validResult(`https://example.test/${i}`)),
  });
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 5,
      bytes: 50,
      milliseconds: 70000,
    },
  });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.ok(res.sliceResult.candidates.length <= 5);
  assert.ok(res.sliceResult.coverage[0]!.bytesUsed <= 50);
  assert.ok(res.sliceResult.evidence.length <= 10); // 2 per candidate
  assert.equal(res.sliceResult.coverage[0]!.attemptsReserved, port.governance.maxAttempts);
  assert.equal(res.sliceResult.coverage[0]!.logicalRequestsUsed, 1);
  AcquisitionSliceResultSchema.parse(res.sliceResult);
});

test('strict excludes unsupported without call', async () => {
  let calls = 0;
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'tavily')!;
  const port = mockPort({
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice({ adapterIds: [def.adapterId] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'strict', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(calls, 0);
  assert.equal(res.sliceResult.coverage[0]!.state, 'not_supported');
});

test('provider failure sanitized to failed with ERROR code', async () => {
  const port = mockPort({
    searchFn: async () => {
      throw new Error('secret query leak');
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.coverage[0]!.state, 'failed');
  assert.ok(res.sliceResult.coverage[0]!.errorCode);
  assert.equal(res.sliceResult.coverage[0]!.errorCode!.includes('secret'), false);
  assert.equal(res.sliceResult.coverage[0]!.errorCode!.includes('query'), false);
});

test('invalid execution edge throws VALIDATION_ERROR', async () => {
  const port = mockPort({ searchFn: async () => [] });
  const slice = makeSlice();
  const badEdge = {
    ...makeExecutionEdge(port),
    actor: { kind: 'user' as never, namespace: 'search-provider', id: port.providerId },
  };
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: badEdge as never,
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('two separately invoked providers call only permitted concrete edge', async () => {
  let callsA = 0,
    callsB = 0;
  const portA = mockPort({
    adapterId: 'indexed-provider:brave',
    providerId: 'search-provider:brave',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'brave')!.governance,
    searchFn: async () => {
      callsA++;
      return [validResult('https://example.test/a')];
    },
  });
  const portB = mockPort({
    adapterId: 'indexed-provider:exa',
    providerId: 'search-provider:exa',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'exa')!.governance,
    backend: 'exa' as never,
    searchFn: async () => {
      callsB++;
      return [validResult('https://example.test/b')];
    },
  });
  const sliceA = makeSlice({ adapterIds: ['indexed-provider:brave'] });
  const sliceB = makeSlice({ adapterIds: ['indexed-provider:exa'], sliceId: 'slice-2' });
  const edgeA = makeExecutionEdge(portA);
  const edgeB = makeExecutionEdge(portB);
  const resA = await runIndexedProvider(
    {
      slice: sliceA,
      executionEdge: edgeA,
      safeSearch: 'moderate',
      capturedAt: new Date().toISOString(),
    },
    { capabilityRegistry: registryWith(portA), port: portA },
  );
  const resB = await runIndexedProvider(
    {
      slice: sliceB,
      executionEdge: edgeB,
      safeSearch: 'moderate',
      capturedAt: new Date().toISOString(),
    },
    { capabilityRegistry: registryWith(portB), port: portB },
  );
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  assert.equal(resA.sliceResult.candidates[0]!.adapterId, portA.adapterId);
  assert.equal(resB.sliceResult.candidates[0]!.adapterId, portB.adapterId);
});

test('full result passes AcquisitionSliceResultSchema', async () => {
  const port = mockPort({
    searchFn: async () => [
      validResult('https://example.test/a'),
      validResult('https://example.test/b', { description: 'hi', contentKind: 'snippet' }),
    ],
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  AcquisitionSliceResultSchema.parse(res.sliceResult);
});

// W3-D findings coverage
test('per-candidate provider_generated_summary caveat not shared: summary-first then snippet', async () => {
  const port = mockPort({
    backend: 'tavily' as never,
    adapterId: 'indexed-provider:tavily',
    providerId: 'search-provider:tavily',
    governance: INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'tavily')!.governance,
    searchFn: async () => [
      validResult('https://example.test/a', { description: 'sum', contentKind: 'summary' }),
      validResult('https://example.test/b', { description: 'snippet', contentKind: 'snippet' }),
    ],
  });
  const slice = makeSlice({ adapterIds: ['indexed-provider:tavily'] });
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.candidates.length, 2);
  assert.ok(res.sliceResult.candidates[0]!.caveats.includes('provider_generated_summary'));
  assert.equal(
    res.sliceResult.candidates[1]!.caveats.includes('provider_generated_summary'),
    false,
  );
});

test('indexedProviderCapabilities output is deep-frozen via schema parse', () => {
  const port = mockPort({});
  const caps = indexedProviderCapabilities([port]);
  assert.equal(Object.isFrozen(caps), true);
  assert.equal(Object.isFrozen(caps[0]!), true);
  assert.equal(Object.isFrozen(caps[0]!.edges), true);
  assert.equal(Object.isFrozen(caps[0]!.edges[0]!), true);
  assert.throws(() => {
    (caps[0] as unknown as Record<string, unknown>).adapterId = 'tampered';
  });
});

test('informational edge wrong effect rejects with VALIDATION_ERROR before call', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const bad = {
    ...makeInfoEdge({ kind: 'publisher', sourceId: 'pub' }),
    effect: 'authorized_operation' as never,
  };
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: edge,
          informationalEdges: [bad as never],
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('informational edge wrong route rejects before call', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const bad = {
    ...makeInfoEdge({ kind: 'publisher', sourceId: 'pub' }),
    route: 'indexed' as never,
  };
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: edge,
          informationalEdges: [bad as never],
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('informational edge wrong target kind rejects before call', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const bad = {
    ...makeInfoEdge({ kind: 'publisher', sourceId: 'pub' }),
    target: { kind: 'discovery_provider', sourceId: 'search-provider:brave' } as never,
  };
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: edge,
          informationalEdges: [bad as never],
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('duplicate informational edge id rejects before call', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const a = makeInfoEdge({ kind: 'publisher', sourceId: 'pub' });
  const b = { ...makeInfoEdge({ kind: 'publisher', sourceId: 'pub' }), edgeId: a.edgeId };
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: edge,
          informationalEdges: [a, b as never],
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('>99 informational edges (100) rejects before provider call', async () => {
  let calls = 0;
  const port = mockPort({
    searchFn: async () => {
      calls++;
      return [];
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const many = Array.from({ length: 100 }, (_, i) => ({
    ...makeInfoEdge({ kind: 'publisher', sourceId: `pub-${i}` }),
    edgeId:
      `info-${i}` as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge['edgeId'],
  }));
  await assert.rejects(
    () =>
      runIndexedProvider(
        {
          slice,
          executionEdge: edge,
          informationalEdges: many as never,
          safeSearch: 'moderate',
          capturedAt: new Date().toISOString(),
        },
        { capabilityRegistry: registryWith(port), port },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('failure after provider invocation reports 1 logicalRequestsUsed and maxAttempts', async () => {
  const port = mockPort({
    searchFn: async () => {
      throw new Error('boom');
    },
  });
  const slice = makeSlice();
  const edge = makeExecutionEdge(port);
  const res = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt: new Date().toISOString() },
    { capabilityRegistry: registryWith(port), port },
  );
  assert.equal(res.sliceResult.coverage[0]!.state, 'failed');
  assert.equal(res.sliceResult.coverage[0]!.logicalRequestsUsed, 1);
  assert.equal(res.sliceResult.coverage[0]!.attemptsReserved, port.governance.maxAttempts);
});
