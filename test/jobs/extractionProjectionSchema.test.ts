import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ExtractionProjectionSchema } from '../../src/jobs/extraction/contracts.js';

const BASE_PROJECTION = {
  schemaVersion: '1.0.0',
  projectionId: 'extraction-projection:' + 'a'.repeat(64),
  extractorVersion: '1.0.0',
  adapterKind: 'manual',
  captureKind: 'manual_content',
  observationId: 'obs-1',
  sourceListingId: 'listing-1',
  contentHash: 'hash-1',
  fields: {},
  roleFamilies: [],
  requirements: [],
  desirableCriteria: [],
  applicationRequirements: [],
  selectionQuestions: [],
  licencesChecksRegistration: [],
  fieldEvidenceLinks: [],
  flags: [],
  warnings: [],
  scrub: { clean: true, redactions: 0, riskScore: 0, threatTypes: [] },
  coverage: 'succeeded',
  confidence: 0.5,
} as const;

function projectionWith(overrides: Record<string, unknown>) {
  return { ...BASE_PROJECTION, ...overrides };
}

describe('extraction projection schema is central contract, not unknown', () => {
  test('rejects unvalidated salary object', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        locations: [],
        classifications: [],
        salaries: [{ nope: true }],
      }),
    );
    assert.equal(result.success, false);
  });

  test('rejects salary with missing raw and bad currency', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        locations: [],
        classifications: [],
        salaries: [{ min: 10, max: 5, currency: 'TOOLONG', unit: 'year' }],
      }),
    );
    assert.equal(result.success, false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      assert.ok(paths.includes('salaries.0.raw'));
      assert.ok(paths.includes('salaries.0.currency'));
    }
  });

  test('rejects salary where min > max', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        locations: [],
        classifications: [],
        salaries: [{ min: 10, max: 5, currency: 'AUD', unit: 'year', raw: '$10-5' }],
      }),
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(
        result.error.issues.some((i) => i.message.includes('salary min must not exceed max')),
      );
    }
  });

  test('accepts valid salary/location/classification shapes', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        locations: [{ city: 'Melbourne' }],
        salaries: [{ min: 30, max: 40, currency: 'AUD', unit: 'hour', raw: '$30-40/hr' }],
        classifications: [{ scheme: 'anzsco', value: '2613' }],
      }),
    );
    assert.equal(result.success, true);
  });

  test('rejects unknown location value', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        salaries: [],
        classifications: [],
        locations: [{ city: 42 }],
      }),
    );
    assert.equal(result.success, false);
  });

  test('rejects free-form flag string', () => {
    const result = ExtractionProjectionSchema.safeParse(
      projectionWith({
        locations: [],
        salaries: [],
        classifications: [],
        flags: ['whatever-string'],
      }),
    );
    assert.equal(result.success, false);
  });
});
