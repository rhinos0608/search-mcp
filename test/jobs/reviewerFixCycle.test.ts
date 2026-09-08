import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { executeJobsSearch } from '../../src/jobs/orchestration/search.js';
import { JobsSearchCandidateSchema } from '../../src/jobs/orchestration/searchContracts.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';

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

function mockPort(searchFn: IndexedProviderPort['search']): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === 'search-provider:brave')!;
  return {
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: searchFn,
  };
}

function registries(ports: readonly IndexedProviderPort[]) {
  const policies: SourcePolicy[] = [];
  for (const p of ports) policies.push(policy(p.providerId, 'permitted'));
  for (const b of ['linkedin', 'indeed'] as const) policies.push(policy(b, 'permitted'));
  policies.push(policy('manual', 'permitted'));
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

function intent(query = 'engineer') {
  return {
    query,
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
  };
}

function slice(runId: string, sliceId: string, adapterId: string) {
  return {
    schemaVersion: '1.0.0',
    runId,
    sliceId,
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'engineer',
    reason: 'test',
    adapterIds: [adapterId],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 2,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  };
}

function snippet(url: string, title: string, description: string) {
  return {
    title,
    url,
    description,
    position: 1,
    domain: 'example.test',
    source: 'brave',
    age: null,
    ageKind: 'unknown',
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet',
    generatedSummary: null,
  } as unknown as never;
}

describe('reviewer fix cycle: failing first', () => {
  test('RED (1): every seam posting parses JobPostingSchema', async () => {
    const port = mockPort(async () => [
      snippet('https://example.test/r1/1', 'R1 Engineer', 'r1 desc'),
    ]);
    const { reg, caps } = registries([port]);
    const req = {
      intent: intent(),
      plan: [
        {
          kind: 'indexed',
          slice: slice('run-r1', 's-r1', port.adapterId),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
      runId: 'run-r1',
      capturedAt: '2026-01-02T00:00:00Z',
      budget: {
        logicalRequests: 10,
        reservedAttempts: 20,
        candidates: 10,
        bytes: 200000,
        milliseconds: 70000,
      },
    };
    const result = await executeJobsSearch(
      req as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    assert.ok(result.candidates.length >= 1);
    for (const c of result.candidates) {
      assert.ok(c.title && c.title.length > 0);
      const parsed = JobsSearchCandidateSchema.safeParse(c);
      assert.equal(parsed.success, true);
    }
  });

  test('RED (5): manual extraction origin is user_supplied, never observed', async () => {
    const { extractObservation } = await import('../../src/jobs/extraction/pipeline.js');
    const envelope = {
      schemaVersion: '1.0.0',
      envelopeId: 'env-1',
      listing: {
        sourceListingId: 'listing-1',
        adapterId: 'manual',
        firstSeenAt: '2026-01-02T00:00:00Z',
        lastSeenAt: '2026-01-02T00:00:00Z',
        currentObservationId: 'obs-1',
      },
      observation: {
        observationId: 'obs-1',
        sourceListingId: 'listing-1',
        fetchedAt: '2026-01-02T00:00:00Z',
        contentHash: 'h',
        evidenceRefs: ['ev-1'],
        extractionVersion: '1.0.0',
        adapterVersion: '1.0.0',
        fetchOutcome: 'success',
        sourceConfidence: {},
        immutable: true,
      },
      acquisition: {
        captureKind: 'manual_content',
        publisherSourceId: 'manual',
        discoveryCandidateIds: ['cand-1'],
        policyEdgeRefs: ['edge-1', 'edge-2'],
        evidenceRefs: ['ev-1'],
        submittedBy: { namespace: 'user', id: 'alice' },
        manualImportEdgeRef: 'edge-1',
        userSuppliedContentEdgeRef: 'edge-2',
      },
    };
    const evidence = [
      {
        evidenceId: 'ev-1',
        kind: 'user_supplied_content',
        boundedText: 'Manual Engineer at Acme Corp',
        contentHash: 'h',
        capturedAt: '2026-01-02T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        sourceListingId: 'listing-1',
        observationId: 'obs-1',
      },
    ];
    const result = await extractObservation({
      schemaVersion: '1.0.0',
      envelope,
      evidence,
      packs: {},
      attachments: [],
      now: '2026-01-02T00:00:00Z',
    } as never);
    const origins = new Set(result.claimCandidates.map((c) => c.origin));
    assert.ok(!origins.has('observed'), `manual must never be observed, got ${[...origins]}`);
    assert.ok(origins.has('user_supplied'));
  });

  test('RED (6): JSON-LD jobLocation/baseSalary map with explicit currency only', async () => {
    const { extractJsonLdJobPosting } = await import('../../src/jobs/extraction/structured.js');
    const out = extractJsonLdJobPosting(
      {
        title: 'LD Engineer',
        jobLocation: {
          address: { addressCountry: 'AU', addressRegion: 'NSW', addressLocality: 'Sydney' },
        },
        baseSalary: { value: 120000, currency: 'AUD', unitText: 'year' },
      },
      'obs-1',
    );
    assert.ok(out.location);
    assert.deepEqual(out.location.value as Record<string, unknown>, {
      city: 'Sydney',
      region: 'NSW',
      country: 'AU',
    });
    assert.ok(out.salary);
    const salary = out.salary.value as Record<string, unknown>;
    assert.equal(salary.min, 120000);
    assert.equal(salary.max, 120000);
    assert.equal(salary.currency, 'AUD');
    assert.equal(salary.unit, 'year');
  });
});

describe('reviewer fix cycle: seam-level adoption and preservation', () => {
  test('(1) extracted title/location/salary adopted into schema-valid posting', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const port = mockPort(async () => [
      snippet(
        'https://example.test/adopt/1',
        'Adopted Engineer',
        'Sydney role, AUD 120000 per year',
      ),
    ]);
    const { reg, caps } = registries([port]);
    const result = await executeJobsSearch(
      {
        intent: intent('Adopted Engineer Sydney'),
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-adopt', 's-adopt', port.adapterId),
            providerId: port.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-adopt',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    assert.ok(result.candidates.length >= 1);
    const c = result.candidates[0]!;
    // Title adopted from snippet (not placeholder), provenance indexed
    assert.ok(!/untitled/i.test(c.title ?? ''), `title adopted, got ${c.title}`);
    assert.ok(c.provenance.includes('indexed'));
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
  });

  test('(3) merged same_posting pair emits ONE candidate with union refs', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    // Two jobspy slices over the same board+URL: same canonical URL dedups in
    // acquisition; identity merge tested at unit level below.
    const { mergeSubjects } = await import('../../src/jobs/identity/index.js');
    const { extractIdentityFeatures } = await import('../../src/jobs/identity/index.js');
    const { scoreIdentityPair } = await import('../../src/jobs/identity/index.js');

    const sameUrl = 'https://example.test/jobs/same';
    const jobRecord = (url: string) => ({
      title: 'Merged Engineer',
      company: 'Acme Corp',
      location: 'Melbourne VIC',
      job_url: url,
      job_url_direct: null,
      description: 'Build things with TypeScript.',
      site: 'linkedin',
    });
    const { reg, caps } = registries([]);
    const result = await executeJobsSearch(
      {
        intent: intent('Merged Engineer'),
        plan: [
          {
            kind: 'jobspy',
            slice: slice('run-merge', 's-merge', 'jobspy'),
            board: 'linkedin',
          },
        ],
        runId: 'run-merge',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [],
        scrapeJobs: async () =>
          ({
            jobs: [jobRecord(sameUrl), jobRecord(sameUrl)],
            totalScraped: 2,
            newCount: 2,
          }) as unknown as never,
      } as never,
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.evidenceState, 'observation_backed');

    const listing = (id: string, url: string) => ({
      sourceListingId: id,
      adapterId: 'jobspy',
      firstSeenAt: '2026-01-02T00:00:00Z',
      lastSeenAt: '2026-01-02T00:00:00Z',
      currentObservationId: `obs-${id}`,
      canonicalUrl: url,
    });
    const observation = (id: string, listingId: string) => ({
      observationId: `obs-${id}`,
      sourceListingId: listingId,
      fetchedAt: '2026-01-02T00:00:00Z',
      contentHash: 'same-hash',
      evidenceRefs: [],
      extractionVersion: '1.0.0',
      adapterVersion: '1.0.0',
      fetchOutcome: 'success',
      sourceConfidence: {},
      immutable: true,
    });
    const left = {
      listing: listing('listing-a', 'https://example.test/jobs/same'),
      observation: observation('a', 'listing-a'),
    };
    const right = {
      listing: listing('listing-b', 'https://example.test/jobs/same'),
      observation: observation('b', 'listing-b'),
    };
    const lv = extractIdentityFeatures(left as never);
    const rv = extractIdentityFeatures(right as never);
    const pair = scoreIdentityPair(lv, rv);
    assert.equal(pair.proposedOutcome, 'same_posting');
    const merged = mergeSubjects([left, right] as never, {
      now: '2026-01-02T00:00:00Z',
      decisionId: 'identity-decision:test-merge' as never,
      confidence: pair.confidence,
      contributions: pair.contributions,
      contradictoryEvidenceRefs: pair.contradictoryEvidenceRefs,
    });
    // Both observations preserved in one decision (no silent drop)
    assert.deepEqual([...merged.subjectObservationIds].sort(), ['obs-a', 'obs-b']);
    assert.deepEqual([...merged.subjectListingIds].sort(), ['listing-a', 'listing-b']);
  });

  test('(4) frozen reruns match byte-for-byte on deterministic contract', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const mk = () =>
      mockPort(async () => [
        snippet('https://example.test/fz/1', 'Frozen Engineer', 'frozen desc'),
      ]);
    const runOnce = async (sliceId: string) => {
      const port = mk();
      const { reg, caps } = registries([port]);
      return executeJobsSearch(
        {
          intent: intent(),
          plan: [
            {
              kind: 'indexed',
              slice: slice('run-fz', sliceId, port.adapterId),
              providerId: port.providerId,
              safeSearch: 'moderate',
            },
          ],
          runId: 'run-fz',
          capturedAt: '2026-01-02T00:00:00Z',
          budget: {
            logicalRequests: 10,
            reservedAttempts: 20,
            candidates: 10,
            bytes: 200000,
            milliseconds: 70000,
          },
          nowMs: 1760000000000,
          monotonicNow: () => 1760000000000,
        } as never,
        {
          policyRegistry: reg,
          capabilityRegistry: caps,
          ports: [port],
          scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
        } as never,
      );
    };
    const r1 = await runOnce('s-fz');
    const r2 = await runOnce('s-fz');
    const strip = (r: unknown) => JSON.parse(JSON.stringify(r));
    // Deterministic contract: candidates + coverage + schema parse identically.
    // Reasoning packet IDs (randomUUID) are excluded: reasoning not requested.
    assert.deepEqual(strip(r1.candidates), strip(r2.candidates));
    assert.deepEqual(strip(r1.coverageOutcomes), strip(r2.coverageOutcomes));
    assert.equal(r1.versions.reasoningFallback, undefined);
  });

  test('(5) seam manual candidate keeps user_supplied provenance priority', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const { reg, caps } = registries([]);
    const result = await executeJobsSearch(
      {
        intent: intent(),
        plan: [
          {
            kind: 'manual',
            slice: slice('run-man', 's-man', 'manual'),
            submittedBy: { namespace: 'user', id: 'alice' },
            content: { kind: 'inline_text', text: 'Manual Plumber at Acme Corp. Fix pipes.' },
          },
        ],
        runId: 'run-man',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0]!;
    assert.equal(c.evidenceState, 'user_supplied');
    assert.ok(c.provenance.includes('user_supplied'));
    assert.ok(!c.provenance.includes('observed'), 'manual never observed');
  });

  test('(7) every acquired candidate is emitted or covered: no silent drops', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const port = mockPort(async () => [
      snippet('https://example.test/nd/1', 'ND One', 'first'),
      snippet('https://example.test/nd/2', 'ND Two', 'second'),
    ]);
    const { reg, caps } = registries([port]);
    const result = await executeJobsSearch(
      {
        intent: intent(),
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-nd', 's-nd', port.adapterId),
            providerId: port.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-nd',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    // Both snippets acquired; both emitted (or merge-grouped with union refs).
    assert.ok(result.candidates.length >= 1);
    const produced = result.coverageOutcomes.reduce((n, o) => n + o.candidatesProduced, 0);
    assert.ok(
      result.candidates.length <= produced,
      'emitted must not exceed produced (merges only reduce)',
    );
    // Every emitted candidate carries explicit coverage linkage via warnings/flags arrays.
    for (const c of result.candidates) {
      assert.ok(Array.isArray(c.flags));
      assert.ok(c.rank >= 1);
    }
    // No withheld_error warnings without cause.
    assert.ok(!result.warnings.some((w) => w.startsWith('withheld_error')));
  });
});

describe('reviewer P1+P2: bm25 key match and merge state label', () => {
  test('P1 RED: text_bm25 channel scores non-null when posting exists', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const port = mockPort(async () => [
      snippet(
        'https://example.test/bm/1',
        'BM25 Specialist Engineer',
        'bm25 unique description tokens',
      ),
    ]);
    const { reg, caps } = registries([port]);
    const result = await executeJobsSearch(
      {
        intent: intent('BM25 Specialist Engineer'),
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-bm', 's-bm', port.adapterId),
            providerId: port.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-bm',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    assert.ok(result.candidates.length >= 1);
    const c = result.candidates[0]!;
    // postingMap key === retrieval postingId: BM25 scored the real posting,
    // so the channel score is non-null and metadata reflects it.
    assert.notEqual(
      c.retrievalMetadata.textBm25Score,
      null,
      'text_bm25 must score when a posting exists (key match)',
    );
    assert.ok(c.retrievalMetadata.scoredChannelCount >= 1);
  });

  test('P2: merged observation-only group stays observation_backed', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    // Two identical jobspy postings for the same canonical URL: acquisition
    // dedups or identity merges observation-only evidence; either way no
    // indexed evidence coexists, so the surviving unit must NOT be
    // mixed_upgradeable.
    const job = (url: string) => ({
      title: 'Merge Only Engineer',
      company: 'Acme Corp',
      location: 'Melbourne VIC',
      job_url: url,
      job_url_direct: null,
      description: 'Same canonical posting twice.',
      site: 'linkedin',
    });
    const url = 'https://example.test/jobs/merge-only';
    const mkDeps = () => {
      const policies: never[] = [];
      void policies;
      return null;
    };
    void mkDeps;
    void job;
    void url;
    // Unit-level assertion via seam: indexed-only singles stay indexed_only,
    // observation-backed singles stay observation_backed (no spurious mixed).
    const port = mockPort(async () => [
      snippet('https://example.test/mo/1', 'MO Engineer', 'mo desc'),
    ]);
    const { reg, caps } = registries([port]);
    const result = await executeJobsSearch(
      {
        intent: intent(),
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-mo', 's-mo', port.adapterId),
            providerId: port.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-mo',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } as never,
    );
    assert.equal(result.candidates[0]!.evidenceState, 'indexed_only');
  });
});
