import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthorizationEvidenceSchema } from '../../src/jobs/acquisition/sourceClass/contracts.js';
import { SourceClassRegistry } from '../../src/jobs/acquisition/sourceClass/registry.js';
import { buildSeekEntry } from '../../src/jobs/acquisition/sourceClass/seek.js';
import {
  SEEK_POLICY_EVIDENCE,
  SEEK_TERMS_FETCH_EVIDENCE,
  SEEK_TERMS_SEARCH_EVIDENCE,
  indexedProviderEvidence,
  manualImportEvidence,
  requireLiveEvidenceRefs,
} from '../../src/jobs/acquisition/sourceClass/evidence/livePolicyEvidence.js';
import { buildJobsMcpDeps } from '../../src/tools/jobs/jobsDeps.js';
import type { SearchConfig } from '../../src/config.js';

test('Zod rejects evidence missing citation and hash', () => {
  const parsed = AuthorizationEvidenceSchema.safeParse({
    schemaVersion: '1.0.0',
    evidenceId: 'source-evidence:deadbeef',
    sourceId: 'board:seek',
    kind: 'published_access_terms',
    capturedAt: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(parsed.success, false);
});

test('live SEEK evidence has citation, conclusion, no contentHash, no secrets', () => {
  assert.ok(SEEK_POLICY_EVIDENCE.length >= 2);
  for (const ev of SEEK_POLICY_EVIDENCE) {
    AuthorizationEvidenceSchema.parse(ev);
    assert.ok(ev.citationRef !== undefined && ev.citationRef.length > 0);
    assert.equal(ev.contentHash, undefined);
    assert.equal(ev.conclusion, 'direct_automated_access_blocked');
    assert.equal(ev.reviewerId, 'jobs-policy/1');
    assert.doesNotMatch(JSON.stringify(ev), /api[_-]?key|secret|password/i);
  }
});

test('buildSeekEntry() without evidence still works for tests', () => {
  const seek = buildSeekEntry();
  assert.deepEqual(seek.evidenceRefs, []);
  assert.equal(seek.reviewedAt, '2025-01-01T00:00:00.000Z');
});

test('buildSeekEntry with live evidence copies max reviewedAt and refs', () => {
  const seek = buildSeekEntry(SEEK_POLICY_EVIDENCE);
  assert.equal(seek.evidenceRefs.length, SEEK_POLICY_EVIDENCE.length);
  const maxReviewedAt = SEEK_POLICY_EVIDENCE.map((e) => e.reviewedAt ?? e.capturedAt)
    .sort()
    .at(-1);
  assert.equal(seek.reviewedAt, maxReviewedAt);
  const reg = new SourceClassRegistry();
  for (const ev of SEEK_POLICY_EVIDENCE) reg.registerEvidence(ev);
  reg.register(seek);
});

test('buildSeekEntry reviewedAt is max evidence timestamp, fallback otherwise', () => {
  const mk = (evidenceId: string, reviewedAt: string) =>
    AuthorizationEvidenceSchema.parse({
      schemaVersion: '1.0.0',
      evidenceId,
      sourceId: 'board:seek',
      kind: 'robots_metadata',
      capturedAt: '2026-01-01T00:00:00.000Z',
      citationRef: 'https://example.com/robots.txt',
      reviewedAt,
    });
  const early = mk('source-evidence:early', '2026-01-01T00:00:00.000Z');
  const late = mk('source-evidence:late', '2026-07-20T00:00:00.000Z');
  assert.equal(buildSeekEntry([early, late]).reviewedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(buildSeekEntry([late, early]).reviewedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(buildSeekEntry([early]).reviewedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(buildSeekEntry().reviewedAt, '2025-01-01T00:00:00.000Z');
});

test('SEEK automatedFetch evidence is distinct and cited on the blocked fetch edge', () => {
  assert.notEqual(SEEK_TERMS_FETCH_EVIDENCE.evidenceId, SEEK_TERMS_SEARCH_EVIDENCE.evidenceId);
  assert.equal(SEEK_TERMS_FETCH_EVIDENCE.appliesTo?.operation, 'automatedFetch');
  assert.equal(SEEK_TERMS_SEARCH_EVIDENCE.appliesTo?.operation, 'automatedSearch');
  assert.notEqual(SEEK_TERMS_FETCH_EVIDENCE.citationRef, SEEK_TERMS_SEARCH_EVIDENCE.citationRef);
  assert.ok(SEEK_TERMS_FETCH_EVIDENCE.citationRef?.startsWith('https://au.seek.com/terms/en#'));
  assert.ok(SEEK_POLICY_EVIDENCE.includes(SEEK_TERMS_FETCH_EVIDENCE));
  const seek = buildSeekEntry(SEEK_POLICY_EVIDENCE);
  assert.ok(seek.evidenceRefs.includes(SEEK_TERMS_FETCH_EVIDENCE.evidenceId));
  assert.equal(seek.modeOverrides?.automatedFetch, 'blocked');
  const reg = new SourceClassRegistry();
  for (const ev of SEEK_POLICY_EVIDENCE) reg.registerEvidence(ev);
  reg.register(seek);
  const edges = reg.materializeEdgePolicies({
    capabilityRegistry: { supports: () => false },
    availableCredentialRefs: new Set<string>(),
    destinationFetchEnabled: false,
  });
  const fetchEdge = edges.find((e) => e.operation === 'automatedFetch');
  assert.ok(fetchEdge);
  assert.equal(fetchEdge.state, 'blocked');
  assert.ok(fetchEdge.evidenceRefs.includes(SEEK_TERMS_FETCH_EVIDENCE.evidenceId));
});

test('requireLiveEvidenceRefs throws on empty live evidence', () => {
  assert.throws(() => requireLiveEvidenceRefs('board:seek', []), /missing reviewed evidence/);
});

test('indexed provider and manual evidence carry distinct operator conclusions', () => {
  const exa = indexedProviderEvidence('search-provider:exa');
  const manual = manualImportEvidence();
  assert.equal(exa.conclusion, 'indexed_provider_operator_authorized');
  assert.equal(manual.conclusion, 'manual_import_user_supplied');
  assert.equal(manual.appliesTo?.operation, 'manualImport');
  assert.equal(manual.appliesTo?.route, 'user_supplied');
  assert.ok(exa.citationRef?.includes('exa.ai'));
});

test('buildJobsMcpDeps live SEEK/provider/manual policies have non-empty evidence', () => {
  const cfg = {
    brave: { apiKey: 'b' },
    searxng: { baseUrl: '' },
    exa: { apiKey: '' },
    tavily: { apiKey: '' },
    duckduckgo: { region: 'us-en', safeSearch: 'moderate' },
    ollamaSearch: { baseUrl: '', apiKey: '' },
    jobsAcquisition: {
      destinationFetchEnabled: false,
      atsTenants: [],
      jobspyBoards: [],
      jobspyFetchDescription: false,
    },
  } as unknown as SearchConfig;
  const deps = buildJobsMcpDeps(cfg);
  const seek = deps.policyRegistry.decideEdge(
    'board:seek',
    { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
    'automatedSearch',
    'direct',
    'board',
  );
  assert.equal(seek.state, 'blocked');
  assert.ok(seek.evidenceRefs.length > 0);
  const provider = deps.policyRegistry.decide('search-provider:brave', 'automatedSearch');
  assert.ok(provider.evidenceRefs.length > 0);
});

test('case 18 destination flag still cannot lift SEEK', () => {
  const seek = buildSeekEntry(SEEK_POLICY_EVIDENCE);
  assert.equal(seek.localAuthorization.destinationFetchEnabled, false);
  assert.equal(seek.modeOverrides?.automatedSearch, 'blocked');
  assert.equal(seek.modeOverrides?.automatedFetch, 'blocked');
});
