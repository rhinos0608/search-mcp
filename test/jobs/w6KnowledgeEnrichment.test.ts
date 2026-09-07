import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichKnowledge } from '../../src/jobs/enrichment/index.js';
import { resolveClaim } from '../../src/jobs/domain/claims.js';

function makeValidInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    snapshot: {
      schemaVersion: '1.0.0',
      extractorVersion: '1.0.0',
      observationId: 'obs1' as never,
      sourceListingId: 'list1' as never,
      fieldEvidenceLinks: [],
      claimCandidates: [],
      evidence: [],
    },
    listing: {
      sourceListingId: 'list1',
      adapterId: 'adapter1',
      currentObservationId: 'obs1',
    },
    observation: {
      observationId: 'obs1',
      sourceListingId: 'list1',
      immutable: true,
    },
    budget: { units: 50 },
    clock: { producedAt: '2026-01-01T00:00:00+00:00' },
    ...overrides,
  };
}

test('W6-J 1. never fabricates employer sector or salary', () => {
  const result = enrichKnowledge(makeValidInput());
  assert.equal(result.employer.match, 'none');
  assert.equal(result.employer.legalName, undefined);
  assert.equal(result.employer.sector, undefined);
  assert.equal(result.salaries.length, 0);
});

test('W6-J 2. packs interpret but cannot invent requirements', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test-locale',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: { 'right to work': 'work_rights' },
    normalizationRules: [],
  };
  const result = enrichKnowledge(
    makeValidInput({
      localePack,
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
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
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  assert.equal(result.requirementsInterpreted.length, 1);
});

test('W6-J 3. employer enrichment requires verified catalog evidence', () => {
  const catalog = {
    catalogId: 'cat1',
    catalogVersion: '1.0.0',
    records: [
      {
        employerRecordId: 'e1',
        catalogId: 'cat1',
        catalogVersion: '1.0.0',
        legalName: 'Acme Corp',
        sector: 'Tech',
        evidenceRefs: ['ref1'],
        license: 'MIT',
      },
    ],
  };
  const result = enrichKnowledge(
    makeValidInput({
      employerCatalog: catalog,
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        organisation: 'Acme Corp',
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  assert.equal(result.employer.match, 'exact');
  assert.equal(result.employer.sector, 'Tech');
  assert.equal(result.employer.evidenceRefs.length, 1);
});

test('W6-J 4. salary normalization preserves currency interval period', () => {
  const result = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        salaries: [
          { min: 30, max: 40, currency: 'AUD', unit: 'hour', period: 'stated', raw: '$30-40/hr' },
        ],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  assert.equal(result.salaries.length, 1);
  assert.equal(result.salaries[0]!.currency, 'AUD');
  assert.equal(result.salaries[0]!.unit, 'hour');
  assert.equal(result.salaries[0]!.period, 'stated');
});

test('W6-J 5. observed claims survive resolveClaim against derived', () => {
  const input = makeValidInput({
    snapshot: {
      schemaVersion: '1.0.0',
      extractorVersion: '1.0.0',
      observationId: 'obs1' as never,
      sourceListingId: 'list1' as never,
      claimCandidates: [
        {
          candidateId: 'obs-claim-1',
          value: 'Observed Value',
          evidenceRefs: ['ref1'],
          confidence: 0.9,
          origin: 'observed',
          method: 'structured_field',
          provenance: {
            component: 'jobs.extraction',
            version: '1.0.0',
            producedAt: '2026-01-01T00:00:00+00:00',
          },
        },
      ],
      fieldEvidenceLinks: [],
      evidence: [],
    },
  });
  const result = enrichKnowledge(input);
  assert.equal(input.snapshot.claimCandidates.length, 1);
  assert.equal(result.derivedClaimCandidates.length, 0);
  const resolved = resolveClaim(input.snapshot.claimCandidates);
  assert.equal(resolved.state, 'resolved');
  if (resolved.state === 'resolved') {
    assert.equal(resolved.selected.value, 'Observed Value');
  }
});

test('W6-J 6. no network sqlite mcp llm imports', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('src/jobs/enrichment');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const forbidden = [
      'safeFetch',
      'better-sqlite3',
      'destinationFetch',
      'jobs.sqlite',
      'LLM_',
      'src/rag/',
      'src/tools/',
    ];
    for (const pattern of forbidden) {
      assert.ok(!content.includes(pattern), `${file} contains forbidden: ${pattern}`);
    }
  }
});

test('W6-J 7. destinationFetch is not used', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('src/jobs/enrichment');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!content.includes('destinationFetch'), `${file} imports destinationFetch`);
  }
});

test('W6-J 8. full EnrichmentResult passes EnrichmentResultSchema', async () => {
  const result = enrichKnowledge(makeValidInput());
  const { EnrichmentResultSchema } = await import('../../src/jobs/enrichment/index.js');
  EnrichmentResultSchema.parse(result);
});

test('W6-J 9. empty core pass_through status', () => {
  const result = enrichKnowledge(makeValidInput());
  assert.equal(result.status, 'pass_through');
});

test('W6-J 10. ADR-016 administrative assistant registered and community cases', () => {
  // Case 1: admin officer, no registration req → no registration_not_evidenced
  const r1 = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        title: 'Administrative Officer',
        requirements: [],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  const gap1 = r1.qualitySignals.find((s) => s.name === 'registration_gap');
  assert.ok(gap1);
  assert.equal(gap1.value, 0);

  // Case 2: clinical assistant, no registration → clinical token present
  const r2 = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        title: 'Clinical Assistant',
        requirements: [],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  const gap2 = r2.qualitySignals.find((s) => s.name === 'registration_gap');
  assert.ok(gap2);
  assert.equal(gap2.value, 1);
  assert.ok(r2.flags.includes('registration_not_evidenced'));

  // Case 3: registered nurse with registration req → no flag
  const r3 = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        title: 'Registered Nurse',
        requirements: [
          {
            rawText: 'current AHPRA registration',
            category: 'registration',
            force: 'mandatory',
            evidenceRefs: ['ref1'],
            confidence: 1.0,
            interpretationProvenance: 'extraction',
          },
        ],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  const gap3 = r3.qualitySignals.find((s) => s.name === 'registration_gap');
  assert.ok(gap3);
  assert.equal(gap3.value, 0);

  // Case 4: community support worker, no registration → no invented blocker
  const r4 = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        title: 'Community Support Worker',
        requirements: [],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  const gap4 = r4.qualitySignals.find((s) => s.name === 'registration_gap');
  assert.ok(gap4);
  assert.equal(gap4.value, 0);

  // Case 5: registered nurse, no registration requirement → flag
  const r5 = enrichKnowledge(
    makeValidInput({
      snapshot: {
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1' as never,
        sourceListingId: 'list1' as never,
        title: 'Registered Nurse',
        requirements: [],
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
      },
    }),
  );
  const gap5 = r5.qualitySignals.find((s) => s.name === 'registration_gap');
  assert.ok(gap5);
  assert.equal(gap5.value, 1);
  assert.ok(r5.flags.includes('registration_not_evidenced'));
});
