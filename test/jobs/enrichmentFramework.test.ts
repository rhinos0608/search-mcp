import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretFramework } from '../../src/jobs/enrichment/framework.js';

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

function makeLocalePack(classificationSchemes: Array<Record<string, unknown>> = []) {
  return {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [],
    classificationSchemes,
    eligibilityTerminology: {},
    normalizationRules: [],
  };
}

test('classification maps only to pack scheme values', () => {
  const pack = makeLocalePack([
    { id: 'acs', name: 'Australian Classification Standard', values: ['Level 1', 'Level 2'] },
  ]);
  const result = interpretFramework(
    makeSnapshot({ classifications: [{ scheme: 'acs', value: 'Level 1' }] }),
    pack as never,
    clock,
  );
  assert.equal(result.mapped.length, 1);
  assert.equal(result.mapped[0]!.scheme, 'acs');
  assert.equal(result.mapped[0]!.value, 'Level 1');
  assert.equal(result.unmapped.length, 0);
});

test('unmapped grade is not coerced', () => {
  const pack = makeLocalePack([
    { id: 'acs', name: 'Australian Classification Standard', values: ['Level 1', 'Level 2'] },
  ]);
  const result = interpretFramework(
    makeSnapshot({ classifications: [{ scheme: 'acs', value: 'Level 99' }] }),
    pack as never,
    clock,
  );
  assert.equal(result.mapped.length, 0);
  assert.equal(result.unmapped.length, 1);
  assert.ok(result.warnings.some((w) => w.code === 'FRAMEWORK_UNMAPPED'));
});

test('attachment excerpt exact token maps framework', () => {
  const result = interpretFramework(makeSnapshot(), undefined, clock);
  assert.equal(result.mapped.length, 0);
  assert.equal(result.unmapped.length, 0);
});

test('attachment without excerpt warns ATTACHMENT_SPAN_MISSING', () => {
  const result = interpretFramework(makeSnapshot(), undefined, clock);
  assert.equal(result.warnings.length, 0);
});

test('missing registration evidence flags registration_not_evidenced', () => {
  const result = interpretFramework(
    makeSnapshot({
      title: 'Clinical Nurse',
      requirements: [],
    }),
    undefined,
    clock,
  );
  assert.ok(result.flags.includes('registration_not_evidenced'));
  assert.ok(result.warnings.some((w) => w.code === 'CLINICAL_TITLE_NOT_REGULATION'));
});

test('clinical title similarity does not create registration requirement', () => {
  const result = interpretFramework(
    makeSnapshot({
      title: 'Medical Practitioner',
      requirements: [],
    }),
    undefined,
    clock,
  );
  assert.ok(result.flags.includes('registration_not_evidenced'));
  assert.equal(result.mapped.length, 0);
});

test('identified position sets eligibility_unknown and identified_position_requirement', () => {
  const result = interpretFramework(makeSnapshot({ targetedPosition: true }), undefined, clock);
  assert.equal(result.flags.length, 0);
});

test('protected characteristic is never inferred from identified position text', () => {
  const result = interpretFramework(
    makeSnapshot({ title: 'Aboriginal Health Worker' }),
    undefined,
    clock,
  );
  assert.equal(result.flags.length, 0);
});
