import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENRICHMENT_CONTRACT_VERSION,
  EnrichmentError,
  EnrichmentRequestSchema,
  ExtractedFieldSnapshotSchema,
  VerifiedEmployerCatalogSchema,
  deterministicEnrichmentId,
  ENRICHMENT_ID_MAX_PARTS,
} from '../../src/jobs/enrichment/index.js';

test('W6 contract version is 1.0.0', () => {
  assert.equal(ENRICHMENT_CONTRACT_VERSION, '1.0.0');
});

test('public exports match frozen allowlist', async () => {
  const mod = await import('../../src/jobs/enrichment/index.js');
  const expected = [
    'ENRICHMENT_CONTRACT_VERSION',
    'EnrichmentError',
    'deterministicEnrichmentId',
    'ENRICHMENT_ID_MAX_PARTS',
    'ENRICHMENT_ID_MAX_PREIMAGE_BYTES',
    'EnrichmentRequestSchema',
    'EnrichmentResultSchema',
    'EnrichmentStatusSchema',
    'EnrichmentWarningSchema',
    'ExtractedFieldSnapshotSchema',
    'VerifiedEmployerRecordSchema',
    'VerifiedEmployerCatalogSchema',
    'EnrichmentBudgetSchema',
    'QualitySignalSchema',
    'SalaryNormalizationResultSchema',
    'ClassificationMappingResultSchema',
    'enrichKnowledge',
    'enrichListing',
    'interpretAttachments',
    'interpretFramework',
    'enrichEmployer',
    'normalizeSalary',
    'mapClassification',
    'deriveQualitySignals',
  ];
  for (const key of expected) {
    assert.ok(key in mod, `missing export: ${key}`);
  }
});

test('EnrichmentRequestSchema rejects unknown keys', () => {
  assert.throws(
    () =>
      EnrichmentRequestSchema.parse({
        schemaVersion: '1.0.0',
        snapshot: {
          schemaVersion: '1.0.0',
          extractorVersion: '1.0.0',
          observationId: 'obs1',
          sourceListingId: 'list1',
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
        budget: { units: 10 },
        clock: { producedAt: '2026-01-01T00:00:00+00:00' },
        unknownField: true,
      }),
    /unrecognized_keys/,
  );
});

test('ExtractedFieldSnapshotSchema rejects unknown keys', () => {
  assert.throws(
    () =>
      ExtractedFieldSnapshotSchema.parse({
        schemaVersion: '1.0.0',
        extractorVersion: '1.0.0',
        observationId: 'obs1',
        sourceListingId: 'list1',
        fieldEvidenceLinks: [],
        claimCandidates: [],
        evidence: [],
        fakeField: true,
      }),
    /unrecognized_keys/,
  );
});

test('VerifiedEmployerRecordSchema requires evidenceRefs', () => {
  assert.throws(
    () =>
      VerifiedEmployerCatalogSchema.parse({
        catalogId: 'cat1',
        catalogVersion: '1.0.0',
        records: [
          {
            employerRecordId: 'emp1',
            catalogId: 'cat1',
            catalogVersion: '1.0.0',
            legalName: 'Acme Corp',
            license: 'MIT',
          },
        ],
      }),
    /evidenceRefs/,
  );
});

test('duplicate employerRecordId fails request parse', () => {
  assert.throws(
    () =>
      VerifiedEmployerCatalogSchema.parse({
        catalogId: 'cat1',
        catalogVersion: '1.0.0',
        records: [
          {
            employerRecordId: 'emp1',
            catalogId: 'cat1',
            catalogVersion: '1.0.0',
            legalName: 'Acme',
            evidenceRefs: ['ref1'],
            license: 'MIT',
          },
          {
            employerRecordId: 'emp1',
            catalogId: 'cat1',
            catalogVersion: '1.0.0',
            legalName: 'Acme2',
            evidenceRefs: ['ref2'],
            license: 'MIT',
          },
        ],
      }),
    /duplicate/,
  );
});

test('observation listing mismatch fails request parse', () => {
  assert.throws(
    () =>
      EnrichmentRequestSchema.parse({
        schemaVersion: '1.0.0',
        snapshot: {
          schemaVersion: '1.0.0',
          extractorVersion: '1.0.0',
          observationId: 'obs1',
          sourceListingId: 'list1',
          fieldEvidenceLinks: [],
          claimCandidates: [],
          evidence: [],
        },
        listing: {
          sourceListingId: 'list1',
          adapterId: 'adapter1',
          currentObservationId: 'obs-different',
        },
        observation: {
          observationId: 'obs1',
          sourceListingId: 'list1',
          immutable: true,
        },
        budget: { units: 10 },
        clock: { producedAt: '2026-01-01T00:00:00+00:00' },
      }),
    /listing observation mismatch/,
  );
});

test('deterministicEnrichmentId is stable for identical parts', () => {
  const id1 = deterministicEnrichmentId('record', ['a', 'b', 'c']);
  const id2 = deterministicEnrichmentId('record', ['a', 'b', 'c']);
  assert.equal(id1, id2);
  assert.match(id1, /^record:[0-9a-f]{64}$/);
});

test('deterministicEnrichmentId changes when contract version would change preimage', () => {
  const id1 = deterministicEnrichmentId('record', ['a', 'b']);
  const id2 = deterministicEnrichmentId('record', ['a', 'c']);
  assert.notEqual(id1, id2);
});

test('deterministicEnrichmentId rejects invalid kind', () => {
  assert.throws(
    () => deterministicEnrichmentId('invalid' as never, []),
    /invalid enrichment artifact kind/,
  );
});

test('deterministicEnrichmentId rejects too many parts', () => {
  const parts = Array.from({ length: ENRICHMENT_ID_MAX_PARTS + 1 }, (_, i) => String(i));
  assert.throws(() => deterministicEnrichmentId('record', parts), /parts exceed limit/);
});

test('EnrichmentError messages are sanitized constants', () => {
  const err = new EnrichmentError('VALIDATION_ERROR', 'invalid enrichment request');
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.equal(err.retryable, false);
  assert.equal(err.name, 'EnrichmentError');
});

test('import boundary forbids acquisition persistence rag tools httpGuards', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files = fs.readdirSync(path.resolve('src/jobs/enrichment'));
  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    const content = fs.readFileSync(path.resolve('src/jobs/enrichment', file), 'utf8');
    const forbidden = [
      'src/rag/',
      'src/tools/',
      'src/httpGuards',
      'safeFetch',
      'better-sqlite3',
      'destinationFetch',
      'jobs.sqlite',
      'LLM_',
    ];
    for (const pattern of forbidden) {
      assert.ok(!content.includes(pattern), `${file} contains forbidden import: ${pattern}`);
    }
  }
});
