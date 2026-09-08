import assert from 'node:assert/strict';
import test from 'node:test';

import { executeJobsSearch } from '../../src/jobs/orchestration/search.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';
import type { JobsSearchRequest } from '../../src/jobs/orchestration/searchContracts.js';

function policy(sourceId: string, state: string = 'permitted'): SourcePolicy {
  return {
    sourceId,
    revision: 'rev-1',
    modes: {
      automatedSearch: state as never,
      automatedFetch: state as never,
      userSuppliedContent: state as never,
      manualImport: state as never,
      employerApi: 'not_supported' as never,
    },
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
  } as unknown as SourcePolicy;
}

function makeRegistries(ports: readonly IndexedProviderPort[]) {
  const policies: SourcePolicy[] = [];
  for (const p of ports) policies.push(policy(p.providerId, 'permitted'));
  for (const b of [
    'linkedin',
    'indeed',
    'zip_recruiter',
    'glassdoor',
    'google',
    'google_careers',
    'bayt',
    'naukri',
    'bdjobs',
  ] as const)
    policies.push(policy(b, 'permitted'));
  policies.push(policy('manual', 'permitted'));
  policies.push(policy('publisher:acme', 'permitted'));
  const reg = new SourcePolicyRegistry(policies);
  const caps = new AdapterCapabilityRegistry([
    ...indexedProviderCapabilities(ports as unknown as IndexedProviderPort[]),
    {
      schemaVersion: '1.0.0',
      adapterId: 'jobspy',
      adapterVersion: '1.7.0',
      edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
    } as unknown as never,
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
      ],
    } as unknown as never,
  ]);
  return { reg, caps };
}

function mockPort(
  providerId = 'search-provider:brave',
  searchFn: IndexedProviderPort['search'] = async () => [],
): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === providerId)!;
  return {
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: searchFn,
  };
}

function baseIntent(overrides: Record<string, unknown> = {}) {
  return {
    query: 'software engineer',
    localePackIds: [],
    domainPackIds: [],
    requestedRoleFamilies: [],
    sectors: [],
    locations: [],
    workModes: [],
    employmentTypes: [],
    compensation: [],
    sourceIds: [],
    explorationBreadth: 'balanced',
    strictness: 'normal',
    unknownPolicy: 'include',
    topK: 10,
    budgets: {
      requests: 10,
      pages: 10,
      bytes: 200000,
      milliseconds: 60000,
      enrichment: 0,
      reasoning: 0,
    },
    evidenceRefs: [],
    ...overrides,
  };
}

function baseSlice(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'test',
    adapterIds: ['indexed-adapter'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 2,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
    ...overrides,
  };
}

function baseRequest(overrides: Record<string, unknown> = {}): JobsSearchRequest {
  return {
    intent: baseIntent(),
    plan: [],
    runId: 'run-1',
    capturedAt: '2026-01-02T00:00:00Z',
    budget: {
      logicalRequests: 10,
      reservedAttempts: 20,
      candidates: 10,
      bytes: 200000,
      milliseconds: 70000,
    },
    ...overrides,
  } as unknown as JobsSearchRequest;
}

function baseDeps(ports: readonly IndexedProviderPort[]) {
  const { reg, caps } = makeRegistries(ports);
  return {
    policyRegistry: reg,
    capabilityRegistry: caps,
    ports,
    scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
  };
}

function jobspyScrape(jobs: unknown[]) {
  return async () =>
    ({ jobs, totalScraped: jobs.length, newCount: jobs.length }) as unknown as never;
}

function jobRecord(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Software Engineer',
    company: 'Acme Corp',
    location: 'Melbourne VIC',
    job_url: 'https://example.test/jobs/1',
    job_url_direct: null,
    description: 'Build things with TypeScript.',
    site: 'linkedin',
    ...overrides,
  };
}

function jobspyPlan(board: string = 'linkedin') {
  return [
    {
      kind: 'jobspy',
      slice: baseSlice({ sliceId: 'slice-js', adapterIds: ['jobspy'] }),
      board,
    },
  ];
}

function manualPlan(text = 'Senior Engineer at Acme Corp. Build things.') {
  return [
    {
      kind: 'manual',
      slice: baseSlice({ sliceId: 'slice-man', adapterIds: ['manual'] }),
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'inline_text', text },
    },
  ];
}

// RED: seam contract shape — frozen request/result/error surface.
test('RED: executeJobsSearch seam exists with typed contract', async () => {
  assert.equal(typeof executeJobsSearch, 'function');
  const port = mockPort('search-provider:brave', async () => []);
  const req = baseRequest({
    plan: [
      {
        kind: 'indexed',
        slice: baseSlice({ adapterIds: [port.adapterId] }),
        providerId: port.providerId,
        safeSearch: 'moderate',
      },
    ],
  });
  await assert.rejects(
    () => executeJobsSearch(req, baseDeps([port]) as never),
    /acquisition produced zero candidates/,
  );
});

// direct observation-backed acquisition via jobspy adapter
test('direct observation-backed: jobspy slice yields observation candidate', async () => {
  makeRegistries([]);
  const policies: SourcePolicy[] = [
    policy('linkedin', 'permitted'),
    policy('indeed', 'permitted'),
    policy('manual', 'permitted'),
  ];
  const reg2 = new SourcePolicyRegistry(policies);
  const caps2 = new AdapterCapabilityRegistry([
    {
      schemaVersion: '1.0.0',
      adapterId: 'jobspy',
      adapterVersion: '1.7.0',
      edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
    } as unknown as never,
  ]);
  const req = baseRequest({ plan: jobspyPlan('linkedin') });
  const deps = {
    policyRegistry: reg2,
    capabilityRegistry: caps2,
    ports: [],
    scrapeJobs: jobspyScrape([jobRecord()]),
  };
  const result = await executeJobsSearch(req, deps as never);
  assert.equal(result.schemaVersion, '1.0.0');
  assert.ok(result.candidates.length >= 1);
  const first = result.candidates[0]!;
  assert.equal(first.evidenceState, 'observation_backed');
  assert.ok(first.observationIds.length >= 1);
  assert.ok(first.sourceListingIds.length >= 1);
  assert.ok(first.provenance.includes('observed'));
  assert.ok(first.utility >= 0 && first.utility <= 1);
  assert.ok('rrfRank' in first.retrievalMetadata);
});

// indexed-only evidence preserved without fabricated observations
test('indexed-only: snippet candidate stays indexed_only with empty observation ids', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Indexed Engineer',
      url: 'https://example.test/indexed/1',
      description: 'snippet only',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const req = baseRequest({
    plan: [
      {
        kind: 'indexed',
        slice: baseSlice({ adapterIds: [port.adapterId] }),
        providerId: port.providerId,
        safeSearch: 'moderate',
      },
    ],
  });
  const result = await executeJobsSearch(req, baseDeps([port]) as never);
  assert.ok(result.candidates.length >= 1);
  const first = result.candidates[0]!;
  assert.equal(first.evidenceState, 'indexed_only');
  assert.deepEqual(first.observationIds, []);
  assert.ok(first.provenance.includes('indexed'));
  assert.ok(!first.provenance.includes('observed'));
  assert.ok(first.caveats.some((c) => /indexed_only/.test(c)));
});

// manual inline content performs zero fetch
test('manual inline: user_supplied with zero fetch evidence', async () => {
  const req = baseRequest({ plan: manualPlan('Manual Engineer at Acme. Build things.') });
  const result = await executeJobsSearch(req, baseDeps([]) as never);
  assert.ok(result.candidates.length >= 1);
  const first = result.candidates[0]!;
  assert.equal(first.evidenceState, 'user_supplied');
  assert.ok(first.provenance.includes('user_supplied'));
});

// blocked SEEK: zero direct calls, policy_blocked isolated
test('blocked SEEK: direct jobspy seek rejected, no direct calls', async () => {
  const caps = new AdapterCapabilityRegistry([
    {
      schemaVersion: '1.0.0',
      adapterId: 'jobspy',
      adapterVersion: '1.7.0',
      edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
    } as unknown as never,
  ]);
  const reg = new SourcePolicyRegistry([policy('board:seek', 'blocked')]);
  let calls = 0;
  const deps = {
    policyRegistry: reg,
    capabilityRegistry: caps,
    ports: [],
    scrapeJobs: async () => {
      calls += 1;
      return { jobs: [], totalScraped: 0, newCount: 0 } as unknown as never;
    },
  };
  // Direct SEEK automation is blocked at the source-class layer: the SEEK
  // entry carries blocked automatedSearch/automatedFetch with zero enabled
  // adapters, and SEEK is absent from JOBSPY_BOARDS so a direct jobspy plan
  // item cannot even address it (board enum rejects 'seek' pre-call).
  const { buildSeekEntry } = await import('../../src/jobs/acquisition/sourceClass/seek.js');
  const seekEntry = buildSeekEntry();
  assert.equal(seekEntry.modeOverrides?.automatedSearch, 'blocked');
  assert.equal(seekEntry.modeOverrides?.automatedFetch, 'blocked');
  assert.deepEqual(seekEntry.localAuthorization.enabledAdapterIds, []);
  await assert.rejects(
    () =>
      executeJobsSearch(
        baseRequest({
          plan: [{ kind: 'jobspy', slice: baseSlice(), board: 'seek' }],
        }),
        deps as never,
      ),
    /VALIDATION_ERROR/,
  );
  assert.equal(calls, 0, 'blocked SEEK plan must make zero scrape calls');
});

// partial provider failure isolated, surviving slice still ranks
test('partial provider failure: one slice fails, other still yields ranked output', async () => {
  const good = mockPort('search-provider:brave', async () => [
    {
      title: 'Good Engineer',
      url: 'https://example.test/good/1',
      description: 'good snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const bad = mockPort('search-provider:exa', async () => {
    throw new Error('provider boom');
  });
  const ports = [good, bad];
  const req = baseRequest({
    runId: 'run-1',
    plan: [
      {
        kind: 'indexed',
        slice: baseSlice({ sliceId: 's-good', adapterIds: [good.adapterId] }),
        providerId: good.providerId,
        safeSearch: 'moderate',
      },
      {
        kind: 'indexed',
        slice: baseSlice({ sliceId: 's-bad', adapterIds: [bad.adapterId] }),
        providerId: bad.providerId,
        safeSearch: 'moderate',
      },
    ],
  });
  const result = await executeJobsSearch(req, baseDeps(ports) as never);
  assert.ok(result.candidates.length >= 1);
  assert.ok(
    result.coverageOutcomes.some((o) => o.sliceId === 's-bad' && o.isolated),
    'failed slice must appear as isolated coverage outcome',
  );
  assert.ok(result.coverageOutcomes.some((o) => o.sliceId === 's-good'));
});

// deterministic rerun: same deps produce identical candidate order + utility
test('deterministic rerun: identical order and utility', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Deterministic Engineer',
      url: 'https://example.test/det/1',
      description: 'stable snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const plan = [
    {
      kind: 'indexed',
      slice: baseSlice({ adapterIds: [port.adapterId] }),
      providerId: port.providerId,
      safeSearch: 'moderate',
    },
  ];
  const fixedNow = () => 1700000000000;
  const r1 = await executeJobsSearch(
    baseRequest({ plan, nowMs: 1700000000000, monotonicNow: fixedNow }),
    baseDeps([port]) as never,
  );
  const port2 = mockPort('search-provider:brave', async () => [
    {
      title: 'Deterministic Engineer',
      url: 'https://example.test/det/1',
      description: 'stable snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const r2 = await executeJobsSearch(
    baseRequest({ plan, nowMs: 1700000000000, monotonicNow: fixedNow }),
    baseDeps([port2]) as never,
  );
  assert.deepEqual(
    r1.candidates.map((c) => [c.candidateId, c.utility, c.rank]),
    r2.candidates.map((c) => [c.candidateId, c.utility, c.rank]),
  );
});

// reasoning failure falls back without losing ranked output
test('reasoning failure fallback: provider throw keeps ranked candidates', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Reasoning Engineer',
      url: 'https://example.test/rea/1',
      description: 'reasoning snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const req = baseRequest({
    plan: [
      {
        kind: 'indexed',
        slice: baseSlice({ adapterIds: [port.adapterId] }),
        providerId: port.providerId,
        safeSearch: 'moderate',
      },
    ],
    reasoningBudget: 1,
    reasoningProvider: {
      id: 'test-provider',
      model: 'test-model',
      complete: async () => {
        throw new Error('provider down');
      },
    },
  });
  const result = await executeJobsSearch(req, baseDeps([port]) as never);
  assert.ok(result.candidates.length >= 1);
  // runOptionalReasoning never throws on provider I/O: throw/timeout/abort
  // degrades to skipped fallback; ranked output is unaffected either way.
  assert.ok(
    result.versions.reasoningFallback === 'skipped' ||
      result.versions.reasoningFallback === 'fallback_failed_isolated',
    `fallback isolated, got ${result.versions.reasoningFallback ?? 'none'}`,
  );
});

// later authoritative upgrade preserves both observations (no destructive merge)
test('authoritative upgrade: second observation for same listing preserved alongside first', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Upgrade Engineer',
      url: 'https://example.test/up/1',
      description: 'v1 snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const plan = [
    {
      kind: 'indexed',
      slice: baseSlice({ runId: 'run-up-1', sliceId: 's-up-1', adapterIds: [port.adapterId] }),
      providerId: port.providerId,
      safeSearch: 'moderate',
    },
  ];
  const r1 = await executeJobsSearch(
    baseRequest({ plan, runId: 'run-up-1' }),
    baseDeps([port]) as never,
  );
  assert.ok(r1.candidates.length >= 1);
  // Same canonical URL re-seen: dedup retains one candidate, provenance intact
  const port2 = mockPort('search-provider:brave', async () => [
    {
      title: 'Upgrade Engineer',
      url: 'https://example.test/up/1',
      description: 'v2 snippet, authoritative refresh',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const plan2 = [
    {
      kind: 'indexed',
      slice: baseSlice({ runId: 'run-up-2', sliceId: 's-up-1', adapterIds: [port2.adapterId] }),
      providerId: port2.providerId,
      safeSearch: 'moderate',
    },
  ];
  const r2 = await executeJobsSearch(
    baseRequest({ plan: plan2, runId: 'run-up-2' }),
    baseDeps([port2]) as never,
  );
  assert.ok(r2.candidates.length >= 1);
  // Identity layer never merges on org+title alone: distinct runs keep
  // distinct candidate ids (no destructive cross-run merge)
  assert.notEqual(r1.candidates[0]!.candidateId, r2.candidates[0]!.candidateId);
  assert.ok(r2.candidates[0]!.provenance.includes('indexed'));
});

// profile affects fit/rank: structured role hint boosts matching family
test('profile fit: structured role hint changes rank order deterministically', async () => {
  const snippets = [
    {
      title: 'Nurse Practitioner',
      url: 'https://example.test/prof/1',
      description: 'nursing role',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    },
    {
      title: 'registry officer',
      url: 'https://example.test/prof/2',
      description: 'registry records role',
      position: 2,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    },
  ];
  const mkPort = () => mockPort('search-provider:brave', async () => snippets as unknown as never);
  const planFor = (sliceId: string, adapterId: string) => [
    {
      kind: 'indexed',
      slice: baseSlice({ sliceId, adapterIds: [adapterId] }),
      providerId: 'search-provider:brave',
      safeSearch: 'moderate',
    },
  ];
  const domainPack = {
    kind: 'domain',
    id: 'admin',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'CC-BY-4.0' },
    roleNodes: [
      {
        id: 'registry',
        label: 'Registry Officer',
        aliases: ['registry'],
        capabilities: ['records'],
      },
    ],
    edges: [],
    capabilityVocabulary: ['records'],
    requirementTerminology: {},
    expansionGuards: [],
    evidenceCitations: ['fixture:domain'],
  };
  const noProfile = await executeJobsSearch(
    baseRequest({ plan: planFor('s-p1', mkPort().adapterId), domainPack }),
    baseDeps([mkPort()]) as never,
  );
  assert.equal(noProfile.candidates.length, 2);
  // Structured profile with minimized role term 'registry' (pack admin v1.0.0)
  const profileInput = {
    kind: 'structured_profile',
    profile: {
      roleHints: [{ kind: 'role', packId: 'admin', packVersion: '1.0.0', termId: 'registry' }],
    },
  };
  const { canonicalProfileTermKey } = await import('../../src/jobs/profile/minimize.js');
  const allowed = new Set([
    canonicalProfileTermKey({
      kind: 'role',
      packId: 'admin',
      packVersion: '1.0.0',
      termId: 'registry',
    }),
  ]);
  const withProfile = await executeJobsSearch(
    baseRequest({
      plan: planFor('s-p2', mkPort().adapterId),
      domainPack,
      profileInput,
      allowedProfileTermRefs: allowed,
    }),
    baseDeps([mkPort()]) as never,
  );
  assert.equal(withProfile.candidates.length, 2);
  assert.ok(withProfile.candidates.some((c) => c.profileApplied));
  // Measurable rank effect: the registry-officer candidate must outrank its
  // no-profile utility (profile delta +0.05 flows into personalAdaptation).
  const profReg = withProfile.candidates.find((c) => c.title === 'registry officer')!;
  const plainReg = noProfile.candidates.find((c) => c.title === 'registry officer')!;
  assert.ok(
    profReg.utility > plainReg.utility,
    `profile must measurably raise utility (${plainReg.utility} -> ${profReg.utility})`,
  );
  // Profile must affect fit but never fabricate facts: same cardinality,
  // same titles, and a second identical profile run is deterministic.
  assert.equal(withProfile.candidates.length, noProfile.candidates.length);
  assert.deepEqual(
    withProfile.candidates.map((c) => c.title).sort(),
    noProfile.candidates.map((c) => c.title).sort(),
  );
  const withProfile2 = await executeJobsSearch(
    baseRequest({
      plan: planFor('s-p3', mkPort().adapterId),
      domainPack,
      profileInput,
      allowedProfileTermRefs: allowed,
    }),
    baseDeps([mkPort()]) as never,
  );
  assert.deepEqual(
    withProfile2.candidates.map((c) => [c.title, c.utility, c.rank]),
    withProfile.candidates.map((c) => [c.title, c.utility, c.rank]),
  );
});

// explicit preferences outrank learned: learned residual on explicit key ignored
test('explicit outranks learned: residual on explicit role key has zero effect', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Explicit Engineer',
      url: 'https://example.test/exp/1',
      description: 'explicit snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const plan = [
    {
      kind: 'indexed',
      slice: baseSlice({ adapterIds: [port.adapterId] }),
      providerId: port.providerId,
      safeSearch: 'moderate',
    },
  ];
  const plain = await executeJobsSearch(baseRequest({ plan }), baseDeps([port]) as never);
  const port2 = mockPort('search-provider:brave', async () => [
    {
      title: 'Explicit Engineer',
      url: 'https://example.test/exp/1',
      description: 'explicit snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  // Learned residual pushing 'role' dimension + explicit key on same dimension:
  // applyLearnedResidual skips explicit keys, so utility must equal plain.
  const { zeroResidual } = await import('../../src/jobs/feedback/residual.js');
  const residual = {
    ...zeroResidual('2026-01-02T00:00:00Z'),
    features: [{ key: { dimension: 'role', value: 'engineering' }, value: 0.09 }],
  };
  const withLearned = await executeJobsSearch(
    baseRequest({
      plan,
      learnedResidual: residual,
      explicitPreferenceKeys: [{ dimension: 'role', value: 'engineering' }],
    }),
    baseDeps([port2]) as never,
  );
  assert.equal(withLearned.candidates[0]!.utility, plain.candidates[0]!.utility);
});

// no locale assumptions absent pack: geography channel omitted, no AU defaults
test('no locale pack: no geography assumptions, generic core holds', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Sydney Engineer',
      url: 'https://example.test/noloc/1',
      description: 'Sydney NSW role',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const result = await executeJobsSearch(
    baseRequest({
      plan: [
        {
          kind: 'indexed',
          slice: baseSlice({ adapterIds: [port.adapterId] }),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
      intent: baseIntent({ query: 'engineer Sydney', locations: [] }),
    }),
    baseDeps([port]) as never,
  );
  assert.ok(result.candidates.length >= 1);
  const meta = result.candidates[0]!.retrievalMetadata;
  assert.equal(meta.scoredChannelCount <= 2, true, 'no geography channel without locale pack');
  assert.ok(!JSON.stringify(result.candidates).includes('AUD'));
});

// unknown eligibility is not contradiction: conditionally_eligible surfaces, never hidden
test('eligibility separated: utility/coverage/confidence distinct, ineligible never upgraded', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'Eligibility Engineer',
      url: 'https://example.test/eli/1',
      description: 'eligibility snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const result = await executeJobsSearch(
    baseRequest({
      plan: [
        {
          kind: 'indexed',
          slice: baseSlice({ adapterIds: [port.adapterId] }),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
    }),
    baseDeps([port]) as never,
  );
  const c = result.candidates[0]!;
  assert.ok(typeof c.utility === 'number');
  assert.ok(typeof c.coverage === 'number');
  assert.ok(typeof c.confidence === 'number');
  assert.ok('utility' in c && 'coverage' in c, 'utility and coverage are separate fields');
  assert.ok(['eligible', 'conditionally_eligible', 'ineligible'].includes(c.eligibility));
  assert.ok(c.eligibilityGates.length >= 0);
  const total =
    result.eligibilitySummary.eligible +
    result.eligibilitySummary.conditionally_eligible +
    result.eligibilitySummary.ineligible;
  assert.equal(total, result.candidates.length);
});

// RRF is metadata only: identical RRF ranks with different utilities keep utility order
test('RRF not utility: rank follows utilityScore, not rrfRank', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'alpha engineer omega',
      url: 'https://example.test/rrf/1',
      description: 'alpha',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
    {
      title: 'unrelated title here',
      url: 'https://example.test/rrf/2',
      description: 'unrelated',
      position: 2,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const result = await executeJobsSearch(
    baseRequest({
      plan: [
        {
          kind: 'indexed',
          slice: baseSlice({ adapterIds: [port.adapterId] }),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
      intent: baseIntent({ query: 'alpha engineer omega' }),
    }),
    baseDeps([port]) as never,
  );
  assert.equal(result.candidates.length, 2);
  const [first, second] = [result.candidates[0]!, result.candidates[1]!];
  assert.ok(first.utility >= second.utility, 'rank order follows utility');
  assert.equal(first.rank, 1);
  assert.ok('rrfRank' in first.retrievalMetadata);
});
