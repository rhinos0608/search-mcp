import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveQualitySignals } from '../../src/jobs/enrichment/quality.js';

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

test('missing salary lowers coverage and does not redistribute', () => {
  const result = deriveQualitySignals(
    makeSnapshot({ title: 'Engineer' }),
    [],
    'none',
    false,
    clock,
  );
  const coverage = result.qualitySignals.find((s) => s.name === 'evidence_coverage');
  assert.ok(coverage);
  assert.ok(coverage.value <= 0.125);
  const missingSalary = result.qualitySignals.find((s) => s.name === 'missing_salary');
  assert.ok(missingSalary);
  assert.equal(missingSalary.value, 1);
});

test('junk signal does not use AU Sydney TLD or seniority heuristics', () => {
  const result = deriveQualitySignals(
    makeSnapshot({ title: 'Senior Officer Sydney NSW' }),
    [],
    'none',
    false,
    clock,
  );
  const junk = result.qualitySignals.find((s) => s.name === 'junk_or_non_job_intent');
  assert.ok(junk);
  assert.equal(junk.value, 0);
});

test('conflicting derived vs observed sets conflicting_source_evidence and keeps observed', () => {
  const derivedClaims = [
    {
      candidateId: 'derived-1',
      value: 'Value A',
      evidenceRefs: ['ref1'],
      confidence: 0.5,
      origin: 'deterministic_derived' as const,
      method: 'test',
      provenance: { component: 'test', version: '1.0.0', producedAt: clock.producedAt },
    },
  ];
  const result = deriveQualitySignals(
    makeSnapshot({
      claimCandidates: [
        {
          candidateId: 'obs-1',
          value: 'Value B',
          evidenceRefs: ['ref2'],
          confidence: 0.9,
          origin: 'observed' as const,
          method: 'test',
          provenance: { component: 'test', version: '1.0.0', producedAt: clock.producedAt },
        },
      ],
    }),
    derivedClaims as never,
    'none',
    false,
    clock,
  );
  const conflict = result.qualitySignals.find((s) => s.name === 'conflicting_claims');
  assert.ok(conflict);
  assert.equal(conflict.value, 1);
  assert.ok(result.flags.includes('conflicting_source_evidence'));
});

test('quality module does not import rag quality defaults', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const content = fs.readFileSync(path.resolve('src/jobs/enrichment/quality.ts'), 'utf8');
  assert.ok(!content.includes('src/rag/'));
  assert.ok(!content.includes('DEFAULT_QUALITY_CONFIG'));
});
