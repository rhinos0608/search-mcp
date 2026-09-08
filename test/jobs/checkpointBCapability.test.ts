import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  evaluateSuite,
  fixedBudgetRecall,
  precisionAtK,
  recallAtK,
} from '../../src/jobs/evaluation/metrics.js';
import { evaluateQualityGates } from '../../src/jobs/evaluation/gates.js';
import { freezeCorpus } from '../../src/jobs/evaluation/corpus.js';
import { sha256Hex } from '../../src/jobs/evaluation/hashes.js';
import { EVALUATION_CONTRACT_VERSION } from '../../src/jobs/evaluation/types.js';
import type { FrozenCorpus } from '../../src/jobs/evaluation/types.js';
import { AU_NSW_SYDNEY_LOCALE_PACK } from '../../src/jobs/packs/auNswSydney.locale.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../src/jobs/packs/nswPublicAdmin.domain.js';
import { executeJobsSearch } from '../../src/jobs/orchestration/search.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';
import type {
  JobsSearchRequest,
  JobsSearchDeps,
} from '../../src/jobs/orchestration/searchContracts.js';
import type { AcquisitionRunId, AcquisitionSliceId } from '../../src/jobs/acquisition/ids.js';
import type { SuiteMetrics } from '../../src/jobs/evaluation/types.js';

const validMetrics: SuiteMetrics[] = [
  {
    corpusId: 'sydney-nsw-v1',
    suiteId: 'sydney_nsw',
    suiteVersion: '1.0.0',
    manifestHash: 'a'.repeat(64),
    split: 'test',
    queryCount: 1,
    macro: { precisionAt10: 1, recallAt20: 1, ndcgAt10: 1, fixedBudgetRecall: 1 },
    byCategory: {},
    perQuery: [
      {
        queryId: 'q1',
        category: 'generic',
        split: 'test',
        precisionAt10: 1,
        recallAt20: 1,
        ndcgAt10: 1,
        fixedBudgetRecall: 1,
        unlabeledCount: 0,
        labeledRelevantCount: 1,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers (deterministic, no network)
// ---------------------------------------------------------------------------

function policy(sourceId: string): SourcePolicy {
  return {
    sourceId,
    revision: 'rev-1',
    modes: {
      automatedSearch: 'permitted' as never,
      automatedFetch: 'permitted' as never,
      userSuppliedContent: 'permitted' as never,
      manualImport: 'permitted' as never,
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
  for (const p of ports) policies.push(policy(p.providerId));
  for (const b of ['linkedin', 'indeed'] as const) policies.push(policy(b));
  policies.push(policy('manual'));
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

function intent(query: string, extra: Record<string, unknown> = {}) {
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
    explorationBreadth: 'balanced' as const,
    strictness: 'normal' as const,
    unknownPolicy: 'include' as const,
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
    ...extra,
  };
}

function slice(runId: string, sliceId: string, adapterId: string, query = 'registry officer') {
  return {
    schemaVersion: '1.0.0' as const,
    runId: runId as AcquisitionRunId,
    sliceId: sliceId as AcquisitionSliceId,
    ordinal: 0,
    queryVariantId: 'qv-1',
    query,
    reason: 'sydney fixture',
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

function snippet(url: string, title: string, description: string, position = 1) {
  return {
    title,
    url,
    description,
    position,
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

// ---------------------------------------------------------------------------
// Frozen Sydney fixtures (populated, deterministic, no fake pass)
// ---------------------------------------------------------------------------

const DOCS = [
  { id: 'doc-registry', family: 'Registry Officer', city: 'Sydney', country: 'AU' },
  { id: 'doc-intel', family: 'Intelligence Officer', city: 'Parramatta', country: 'AU' },
  { id: 'doc-nurse', family: 'Nurse Practitioner', city: 'London', country: 'UK' },
] as const;

function sydneyCorpus(): FrozenCorpus {
  const documents = DOCS.map((d) => ({
    documentId: d.id,
    postingId: `posting-${d.id}`,
    identityClusterId: `cluster-${d.id}`,
    sourceListingIds: [`listing-${d.id}`],
    observationIds: [`obs-${d.id}`],
    contentHash: sha256Hex(`content-${d.id}`).slice(0, 64),
    capturedAt: '2026-01-02T00:00:00+00:00',
    asOf: '2026-01-02T00:00:00+00:00',
    fixturePath: `fixtures/sydney/${d.id}.json`,
  }));
  const queries = [
    {
      queryId: 'q-registry-sydney',
      suiteId: 'sydney_nsw' as const,
      intentFingerprint: sha256Hex('intent-registry').slice(0, 64),
      intent: { query: 'registry officer Sydney' },
      identityClusterId: 'cluster-doc-registry',
      asOf: '2026-01-02T00:00:00+00:00',
      split: 'test' as const,
      category: 'role-family',
      kPrecision: 10,
      kRecall: 20,
      kNdcg: 10,
      fixedBudget: 10,
    },
    {
      queryId: 'q-intel-parramatta',
      suiteId: 'sydney_nsw' as const,
      intentFingerprint: sha256Hex('intent-intel').slice(0, 64),
      intent: { query: 'intelligence officer Parramatta' },
      identityClusterId: 'cluster-doc-intel',
      asOf: '2026-01-02T00:00:00+00:00',
      split: 'test' as const,
      category: 'profile',
    },
  ] as unknown as FrozenCorpus['queries'];
  const labels: FrozenCorpus['labels'] = [
    {
      kind: 'binary',
      queryId: 'q-registry-sydney',
      documentId: 'doc-registry',
      relevant: true,
      annotator: 'fixture',
      labeledAt: '2026-01-02T00:00:00+00:00',
    },
    {
      kind: 'binary',
      queryId: 'q-registry-sydney',
      documentId: 'doc-nurse',
      relevant: false,
      annotator: 'fixture',
      labeledAt: '2026-01-02T00:00:00+00:00',
    },
    {
      kind: 'binary',
      queryId: 'q-intel-parramatta',
      documentId: 'doc-intel',
      relevant: true,
      annotator: 'fixture',
      labeledAt: '2026-01-02T00:00:00+00:00',
    },
  ];
  const draft: FrozenCorpus = {
    manifest: {
      schemaVersion: EVALUATION_CONTRACT_VERSION,
      corpusId: 'sydney-nsw-v1',
      suiteId: 'sydney_nsw',
      suiteVersion: '1.0.0',
      status: 'draft',
      documents: documents.map((d) => ({
        documentId: d.documentId,
        contentHash: d.contentHash,
        fixturePath: d.fixturePath,
      })),
      queries: queries.map((q) => ({ queryId: q.queryId, intentFingerprint: q.intentFingerprint })),
      labels: labels.map((l, i) => ({
        labelId: `label-${i}`,
        contentHash: sha256Hex(JSON.stringify(l)).slice(0, 64),
      })),
      splits: { train: [], dev: [], test: ['q-registry-sydney', 'q-intel-parramatta'] },
      revisions: {
        gitCommit: 'test',
        schemaVersion: '1.0.0',
        policyRevision: 'rev-1',
        rankingVersion: '1.0.0',
        packVersions: ['locale:au-nsw-sydney:1.0.0', 'domain:nsw-public-admin:1.0.0'],
        adapterVersions: ['indexed-provider:brave:1.0.0'],
        fixtureVersion: '1.0.0',
        runtimeRevision: 'node-test',
      },
      manifestHash: '0'.repeat(64),
    },
    documents,
    queries,
    labels,
  };
  return freezeCorpus(draft, '2026-01-02T00:00:00+00:00');
}

function metricsFor(corpus: FrozenCorpus): SuiteMetrics[] {
  const base = validMetrics[0]!;
  return [
    {
      ...base,
      manifestHash: corpus.manifest.manifestHash,
      queryCount: corpus.queries.filter((q) => q.split === 'test').length,
      perQuery: corpus.queries
        .filter((q) => q.split === 'test')
        .map((q) => ({ ...base.perQuery[0]!, queryId: q.queryId })),
    },
  ];
}

describe('checkpoint B capability: Sydney packs + trustworthy evaluation', () => {
  test('packs register and resolve by version', async () => {
    const { PackRegistry } = await import('../../src/jobs/packs/registry.js');
    const reg = new PackRegistry([AU_NSW_SYDNEY_LOCALE_PACK, NSW_PUBLIC_ADMIN_DOMAIN_PACK]);
    const locale = reg.resolve('locale', 'au-nsw-sydney', '2026-06-01');
    const domain = reg.resolve('domain', 'nsw-public-admin', '2026-06-01');
    assert.ok(locale);
    assert.ok(domain);
    assert.equal(locale.id, 'au-nsw-sydney');
    assert.equal(domain.id, 'nsw-public-admin');
  });

  test('generic core has no AU defaults without packs', async () => {
    const port = mockPort(async () => [
      snippet('https://example.test/g/1', 'Some Engineer', 'generic'),
    ]);
    const { reg, caps } = registries([port]);
    const result = await executeJobsSearch(
      {
        intent: intent('engineer'),
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-g', 's-g', port.adapterId),
            providerId: port.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-g',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } satisfies JobsSearchRequest,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port],
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      } satisfies JobsSearchDeps,
    );
    assert.ok(!JSON.stringify(result.candidates).includes('AUD'));
    assert.ok(!JSON.stringify(result.candidates).includes('au-nsw-sydney'));
  });

  test('Sydney pack retrieval: adjacent role families score above unrelated', async () => {
    const port = mockPort(async () => [
      snippet('https://example.test/syd/1', 'Registry Officer', 'registry records role Sydney'),
      snippet('https://example.test/syd/2', 'Nurse Practitioner', 'nursing role London'),
    ]);
    const { reg, caps } = registries([port]);
    const base = {
      intent: intent('registry officer Sydney', { requestedRoleFamilies: ['Registry Officer'] }),
      plan: [
        {
          kind: 'indexed',
          slice: slice('run-syd', 's-syd', port.adapterId, 'registry officer'),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
      runId: 'run-syd',
      capturedAt: '2026-01-02T00:00:00Z',
      budget: {
        logicalRequests: 10,
        reservedAttempts: 20,
        candidates: 10,
        bytes: 200000,
        milliseconds: 70000,
      },
      domainPack: NSW_PUBLIC_ADMIN_DOMAIN_PACK,
      localePack: AU_NSW_SYDNEY_LOCALE_PACK,
    } satisfies JobsSearchRequest;
    const deps = {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports: [port],
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    } satisfies JobsSearchDeps;
    const result = await executeJobsSearch(base, deps);
    assert.equal(result.candidates.length, 2);
    // Capability-adjacent retrieval: registry candidate ranks first via pack graph
    assert.ok(result.candidates[0]!.title?.toLowerCase().includes('registry'));
    // Geography channel active with locale pack: scored channels include geography
    assert.ok(result.candidates[0]!.retrievalMetadata.scoredChannelCount >= 2);
  });

  test('frozen Sydney corpus freezes, verifies, and scores real metrics', () => {
    const corpus = sydneyCorpus();
    assert.equal(corpus.manifest.status, 'frozen');
    assert.equal(corpus.manifest.corpusId, 'sydney-nsw-v1');
    // Real metric math on fixed fixtures (no fake pass)
    assert.ok(
      precisionAtK([{ documentId: 'doc-registry', rank: 1 }], new Set(['doc-registry']), 10) === 1,
    );
    assert.ok(
      recallAtK(
        [{ documentId: 'doc-registry', rank: 1 }],
        new Set(['doc-registry', 'doc-x']),
        20,
      ) === 0.5,
    );
    const metrics = evaluateSuite(corpus, (q) => {
      if (q.queryId === 'q-registry-sydney')
        return [
          { documentId: 'doc-registry', rank: 1, score: 0.9 },
          { documentId: 'doc-nurse', rank: 2, score: 0.1 },
        ];
      return [{ documentId: 'doc-intel', rank: 1, score: 0.9 }];
    });
    assert.equal(metrics.queryCount, 2);
    assert.ok(metrics.macro.recallAt20 > 0);
    assert.ok(metrics.macro.fixedBudgetRecall >= 0);
    // fixedBudgetRecall computed at declared budget, not percentile
    const fb = fixedBudgetRecall(
      [{ documentId: 'doc-registry', rank: 1 }],
      new Set(['doc-registry']),
      10,
    );
    assert.equal(fb, 1);
  });

  test('B/C gates pass on populated Sydney evidence; D retention stays failed', () => {
    const bReport = evaluateQualityGates({
      checkpoint: 'B',
      corpora: [sydneyCorpus()],
      metrics: metricsFor(sydneyCorpus()),
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
      extras: {
        extractionClaims: [
          { claimId: 'c1', hasEvidenceRefs: true, origin: 'observed' },
          { claimId: 'c2', hasEvidenceRefs: true, origin: 'user_supplied' },
        ],
        projectionRows: [
          { projection: 'title', present: true },
          { projection: 'organisation', present: true },
          { projection: 'location', present: true },
          { projection: 'salary', present: true },
          { projection: 'lifecycle', present: true },
        ],
        conflictCases: [{ state: 'conflicting', alternativesPreserved: true }],
        identityProbes: [
          { scenario: 'org_title_only', merged: false },
          { scenario: 'strong_match', merged: true },
        ],
        lifecycleProbes: [
          { from: 'disappeared', to: 'confirmed_closed', allowed: false },
          { from: 'active', to: 'probably_closed', allowed: true },
        ],
      },
    });
    assert.ok(bReport.passed, JSON.stringify(bReport.findings.filter((f) => !f.passed)));
    const cReport = evaluateQualityGates({
      checkpoint: 'C',
      corpora: [sydneyCorpus()],
      metrics: metricsFor(sydneyCorpus()),
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
      extras: {
        recallSnapshots: [
          { suiteId: 'sydney_nsw', fixedBudgetRecall: 0.75, computedAtBudget: true },
        ],
        bm25Probes: [{ queryId: 'q1', firstScore: 1.5, secondScore: 1.5 }],
        missingDataProbes: [
          { scenario: 'no-salary', usedNeutralPrior: true, redistributed: false },
        ],
        groupedOutputs: [
          {
            dimensions: [
              'relevance',
              'candidateFit',
              'preferenceFit',
              'marketState',
              'evidenceQuality',
              'personalAdaptation',
            ],
            rrfInUtility: false,
          },
        ],
        standaloneRuns: [{ deterministic: true, reasoningDisabled: true, complete: true }],
        hostPackets: [{ bounded: true }],
      },
    });
    assert.ok(cReport.passed, JSON.stringify(cReport.findings.filter((f) => !f.passed)));
    const dReport = evaluateQualityGates({
      checkpoint: 'D',
      corpora: [],
      metrics: [],
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
      extras: {
        precedenceProofs: [{ scenario: 'explicit-vs-learned', explicitWins: true }],
        mcpActions: [
          { compact: true, bounded: true },
          { compact: true, bounded: true },
          { compact: true, bounded: true },
        ],
        moduleInventory: [
          { module: 'jobs.seam', inArchitectureTable: true },
          { module: 'jobs.mcp', inArchitectureTable: true },
        ],
      },
    });
    const retention = dReport.findings.find((f) => f.gateId === 'D.retention_encryption');
    assert.ok(retention);
    assert.ok(!retention.passed, 'D retention must never pass while ADR-019 deferred');
    const mcp = dReport.findings.find((f) => f.gateId === 'D.mcp_progressive');
    assert.ok(mcp);
    assert.ok(mcp.passed, 'D.mcp_progressive passes with live compact/bounded actions');
  });

  test('B/C gates fail on absent evidence (no fake pass)', () => {
    const bReport = evaluateQualityGates({
      checkpoint: 'B',
      corpora: [],
      metrics: [],
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    });
    assert.ok(!bReport.passed);
    const cReport = evaluateQualityGates({
      checkpoint: 'C',
      corpora: [],
      metrics: [],
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    });
    assert.ok(!cReport.passed);
  });

  test('compensation overlap: explicit AUD overlap scores evidentiary, unknown stays neutral', async () => {
    const { assessCandidate } = await import('../../src/jobs/assessment/scorer.js');
    const posting = (salaries: never[]) =>
      ({
        postingId: 'posting-1',
        schemaVersion: '1.0.0',
        canonicalRevision: 1,
        title: 'Engineer',
        normalizedTitle: 'engineer',
        organisation: 'Acme',
        roleFamilies: [],
        locations: [{}],
        workMode: 'unknown',
        employmentType: 'unknown',
        salaries,
        classifications: [],
        listingUrls: [],
        description: 'desc',
        responsibilities: [],
        requirements: [],
        desirableCriteria: [],
        applicationRequirements: [],
        selectionQuestions: [],
        licencesChecksRegistration: [],
        verificationState: 'unverified',
        lifecycleState: 'discovered',
        flags: [],
        confidence: 0.5,
        caveats: [],
        evidenceRefs: ['ev-1'],
        sourceListingIds: [],
        observationIds: [],
        identityDecisionRevision: 'none',
      }) as never;
    const withOverlap = assessCandidate({
      posting: posting([
        {
          min: 100000,
          max: 140000,
          currency: 'AUD',
          unit: 'year',
          period: 'stated',
          raw: 'AUD 100-140k',
        },
      ] as never[]),
      intent: intent('engineer', {
        compensation: [
          {
            min: 120000,
            max: 130000,
            currency: 'AUD',
            unit: 'year',
            period: 'stated',
            raw: 'pref',
          },
        ],
      }) as never,
      nowMs: 1760000000000,
    });
    const prefGroup = withOverlap.groups.find((g) => g.group === 'preferenceFit')!;
    assert.ok(prefGroup.coverageRatio > 0, 'explicit overlap must be evidentiary');

    const withPointSalary = assessCandidate({
      posting: posting([
        {
          min: 125000,
          max: 125000,
          currency: 'AUD',
          unit: 'year',
          period: 'stated',
          raw: 'AUD 125k',
        },
      ] as never[]),
      intent: intent('engineer', {
        compensation: [
          {
            min: 120000,
            max: 130000,
            currency: 'AUD',
            unit: 'year',
            period: 'stated',
            raw: 'pref',
          },
        ],
      }) as never,
      nowMs: 1760000000000,
    });
    const pointGroup = withPointSalary.groups.find((g) => g.group === 'preferenceFit')!;
    assert.ok(
      pointGroup.coverageRatio > 0,
      'point salary within preference range must be evidentiary',
    );
    assert.ok(pointGroup.score >= 0.7, 'point salary within preference range must have high score');
    const pointComp = pointGroup.components.find((c) => c.dimension === 'compensationPreference')!;
    assert.ok(pointComp.score >= 0.8, 'point salary component must score >= 0.8');
    const unknownPref = assessCandidate({
      posting: posting([
        { min: 100000, max: 140000, currency: 'AUD', unit: 'year', period: 'stated', raw: 'AUD' },
      ] as never[]),
      intent: intent('engineer', {
        compensation: [
          {
            min: 120000,
            max: 130000,
            currency: 'XXX',
            unit: 'year',
            period: 'stated',
            raw: 'pref',
          },
        ],
      }) as never,
      nowMs: 1760000000000,
    });
    const unknownGroup = unknownPref.groups.find((g) => g.group === 'preferenceFit')!;
    const comp = unknownGroup.components.find((c) => c.dimension === 'compensationPreference')!;
    assert.equal(comp.hasEvidence, false, 'currency mismatch stays neutral');
  });
});
