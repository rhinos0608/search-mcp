import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichListing } from '../../src/jobs/enrichment/listing.js';

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    extractorVersion: '1.0.0',
    observationId: 'obs1' as never,
    sourceListingId: 'list1' as never,
    fieldEvidenceLinks: [],
    claimCandidates: [],
    evidence: [],
    ...overrides,
  };
}

const clock = { producedAt: '2026-01-01T00:00:00+00:00' };

test('generic core has no AU geography salary or classification defaults', () => {
  const result = enrichListing(makeSnapshot(), undefined, undefined, clock);
  assert.equal(result.roleFamilies.length, 0);
  assert.equal(result.derivedClaimCandidates.length, 0);
});

test('pack aliases bind location only on exact alias match', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [{ id: 'nsw', name: 'New South Wales', kind: 'state' as const, aliases: ['NSW'] }],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: {},
    normalizationRules: [],
  };
  const result = enrichListing(
    makeSnapshot({ locations: [{ region: 'NSW' }] }),
    localePack as never,
    undefined,
    clock,
  );
  assert.equal(result.derivedClaimCandidates.length, 1);
  assert.equal(result.derivedEvidence.length, 1);
});

test('fuzzy location does not bind', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [{ id: 'syd', name: 'Sydney', kind: 'city' as const, aliases: ['Sydney'] }],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: {},
    normalizationRules: [],
  };
  const result = enrichListing(
    makeSnapshot({ locations: [{ city: 'Sydne' }] }),
    localePack as never,
    undefined,
    clock,
  );
  assert.equal(result.derivedClaimCandidates.length, 0);
});

test('expandDomainTerms equivalent_title requires edge evidence', () => {
  const domainPack = {
    kind: 'domain' as const,
    id: 'test-domain',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    roleNodes: [
      { id: 'sw', label: 'Software Engineer', aliases: ['Developer'], capabilities: [] },
      { id: 'se', label: 'Systems Engineer', aliases: [], capabilities: [] },
    ],
    edges: [
      {
        from: 'sw',
        to: 'se',
        type: 'equivalent_title' as const,
        evidence: ['Software Engineer'],
        rule: { ruleId: 'r1', version: '1.0.0', deterministic: true as const, description: 'eq' },
      },
    ],
    capabilityVocabulary: [],
    requirementTerminology: {},
    expansionGuards: [],
    evidenceCitations: ['test-citation'],
  };
  const result = enrichListing(
    makeSnapshot({ title: 'Software Engineer' }),
    undefined,
    domainPack as never,
    clock,
  );
  assert.ok(result.roleFamilies.length >= 1);
  const families = result.roleFamilies.map((f) => f.family);
  assert.ok(families.includes('Software Engineer') || families.includes('Systems Engineer'));
});

test('generic token without context does not expand', () => {
  const domainPack = {
    kind: 'domain' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    roleNodes: [
      { id: 'off', label: 'General Officer', aliases: ['Admin Officer'], capabilities: [] },
    ],
    edges: [],
    capabilityVocabulary: [],
    requirementTerminology: {},
    expansionGuards: [{ token: 'officer', requiresContext: ['Engineering'] }],
    evidenceCitations: [],
  };
  const result = enrichListing(
    makeSnapshot({ title: 'Officer' }),
    undefined,
    domainPack as never,
    clock,
  );
  assert.equal(result.roleFamilies.length, 0);
});

test('pack terminology interprets stated requirement without inventing one', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: { 'right to work': 'work_rights' },
    normalizationRules: [],
  };
  const result = enrichListing(
    makeSnapshot({
      requirements: [
        {
          rawText: 'right to work',
          category: 'skill',
          force: 'uncertain',
          evidenceRefs: [],
          confidence: 0.5,
          interpretationProvenance: 'extraction',
        },
      ],
    }),
    localePack as never,
    undefined,
    clock,
  );
  assert.equal(result.requirementsInterpreted.length, 1);
});

test('pack cannot add mandatory force to uncertain requirement', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: { 'right to work': 'work_rights' },
    normalizationRules: [],
  };
  const result = enrichListing(
    makeSnapshot({
      requirements: [
        {
          rawText: 'right to work',
          category: 'skill',
          force: 'uncertain',
          evidenceRefs: [],
          confidence: 0.5,
          interpretationProvenance: 'extraction',
        },
      ],
    }),
    localePack as never,
    undefined,
    clock,
  );
  const req = result.requirementsInterpreted[0] as { force: string };
  assert.equal(req.force, 'uncertain');
});

test('adjacent and false_friend edges are ignored in W6', () => {
  const domainPack = {
    kind: 'domain' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    roleNodes: [
      { id: 'a', label: 'Role A', aliases: [], capabilities: [] },
      { id: 'b', label: 'Role B', aliases: [], capabilities: [] },
    ],
    edges: [
      {
        from: 'a',
        to: 'b',
        type: 'adjacent' as const,
        evidence: ['test'],
        rule: { ruleId: 'r1', version: '1.0.0', deterministic: true as const, description: 'adj' },
      },
    ],
    capabilityVocabulary: [],
    requirementTerminology: {},
    expansionGuards: [],
    evidenceCitations: [],
  };
  const result = enrichListing(
    makeSnapshot({ title: 'Role A' }),
    undefined,
    domainPack as never,
    clock,
  );
  const families = result.roleFamilies.map((f) => f.family);
  assert.ok(!families.includes('Role B'));
});
