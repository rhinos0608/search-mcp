import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichEmployer } from '../../src/jobs/enrichment/employer.js';

function makeSnapshot(org?: string) {
  return {
    schemaVersion: '1.0.0',
    extractorVersion: '1.0.0',
    observationId: 'obs1' as never,
    sourceListingId: 'list1' as never,
    organisation: org,
    fieldEvidenceLinks: [],
    claimCandidates: [],
    evidence: [],
  };
}

const clock = { producedAt: '2026-01-01T00:00:00+00:00' };

function makeCatalog(records: Array<Record<string, unknown>>) {
  return {
    catalogId: 'cat1',
    catalogVersion: '1.0.0',
    records,
  };
}

test('exact legalName match fills sector from catalog only', () => {
  const catalog = makeCatalog([
    {
      employerRecordId: 'e1',
      catalogId: 'cat1',
      catalogVersion: '1.0.0',
      legalName: 'Acme Corp',
      sector: 'Technology',
      evidenceRefs: ['ref1'],
      license: 'MIT',
    },
  ]);
  const result = enrichEmployer(makeSnapshot('Acme Corp'), catalog as never, clock);
  assert.equal(result.employerMatch.match, 'exact');
  assert.equal(result.employerMatch.legalName, 'Acme Corp');
  assert.equal(result.employerMatch.sector, 'Technology');
  assert.equal(result.employerMatch.evidenceRefs.length, 1);
});

test('alias match uses catalog legalName', () => {
  const catalog = makeCatalog([
    {
      employerRecordId: 'e1',
      catalogId: 'cat1',
      catalogVersion: '1.0.0',
      legalName: 'Acme Corporation Pty Ltd',
      aliases: ['Acme Corp', 'Acme'],
      evidenceRefs: ['ref1'],
      license: 'MIT',
    },
  ]);
  const result = enrichEmployer(makeSnapshot('Acme Corp'), catalog as never, clock);
  assert.equal(result.employerMatch.match, 'alias');
  assert.equal(result.employerMatch.legalName, 'Acme Corporation Pty Ltd');
});

test('ambiguous match fills nothing', () => {
  const catalog = makeCatalog([
    {
      employerRecordId: 'e1',
      catalogId: 'cat1',
      catalogVersion: '1.0.0',
      legalName: 'Acme A',
      aliases: ['Acme'],
      evidenceRefs: ['ref1'],
      license: 'MIT',
    },
    {
      employerRecordId: 'e2',
      catalogId: 'cat1',
      catalogVersion: '1.0.0',
      legalName: 'Acme B',
      aliases: ['Acme'],
      evidenceRefs: ['ref2'],
      license: 'MIT',
    },
  ]);
  const result = enrichEmployer(makeSnapshot('Acme'), catalog as never, clock);
  assert.equal(result.employerMatch.match, 'ambiguous');
  assert.equal(result.employerMatch.legalName, undefined);
});

test('unverified organisation is omitted not guessed', () => {
  const catalog = makeCatalog([
    {
      employerRecordId: 'e1',
      catalogId: 'cat1',
      catalogVersion: '1.0.0',
      legalName: 'Acme Corp',
      aliases: [],
      evidenceRefs: ['ref1'],
      license: 'MIT',
    },
  ]);
  const result = enrichEmployer(makeSnapshot('Other Inc'), catalog as never, clock);
  assert.equal(result.employerMatch.match, 'none');
  assert.equal(result.employerMatch.legalName, undefined);
  assert.ok(result.warnings.some((w) => w.code === 'EMPLOYER_UNMATCHED'));
});

test('requireVerifiedEmployer throws UNVERIFIED_EMPLOYER on none', () => {
  assert.throws(() => {
    const result = enrichEmployer(makeSnapshot('Unknown'), undefined, clock);
    if (result.employerMatch.match !== 'exact' && result.employerMatch.match !== 'alias') {
      throw new Error('employer not verified');
    }
  }, /employer not verified/);
});

test('catalog record without live network or fetch import', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const content = fs.readFileSync(path.resolve('src/jobs/enrichment/employer.ts'), 'utf8');
  assert.ok(!content.includes('safeFetch'));
  assert.ok(!content.includes('better-sqlite3'));
  assert.ok(!content.includes('destinationFetch'));
});
