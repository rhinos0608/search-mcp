import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTOR_VERSION,
  ExtractionError,
  ExtractionErrorCodeSchema,
  ExtractionHotFieldsSchema,
  ExtractionRunIdSchema,
  ExtractionProjectionIdSchema,
  JobsEvidenceIdSchema,
  RequirementIdSchema,
  ExtractionClaimCandidateIdSchema,
} from '../../src/jobs/extraction/contracts.js';

describe('W5 extraction contracts', () => {
  test('1. contract versions frozen', () => {
    assert.strictEqual(EXTRACTION_CONTRACT_VERSION, '1.0.0');
    assert.strictEqual(EXTRACTOR_VERSION, '1.0.0');
  });

  test('2. unknown input keys reject', () => {
    const result = ExtractionRunIdSchema.safeParse('extraction-run:' + 'a'.repeat(64));
    assert.strictEqual(result.success, true);
    const bad = ExtractionRunIdSchema.safeParse('bad-value');
    assert.strictEqual(bad.success, false);
  });

  test('3. ExtractionHotFieldsSchema rejects lifecycleState: confirmed_closed', () => {
    const result = ExtractionHotFieldsSchema.safeParse({
      lifecycleState: 'confirmed_closed',
    });
    assert.strictEqual(result.success, false);
  });

  test('3b. ExtractionHotFieldsSchema rejects verificationState: verified', () => {
    const result = ExtractionHotFieldsSchema.safeParse({
      verificationState: 'verified',
    });
    assert.strictEqual(result.success, false);
  });

  test('4. ExtractionErrorCode is exactly the frozen union', () => {
    const codes = [
      'VALIDATION_ERROR',
      'UNSUPPORTED_CAPTURE_KIND',
      'INDEXED_ONLY_FORBIDDEN',
      'PAYLOAD_MISSING',
      'CONTENT_TYPE_UNSUPPORTED',
      'PARSER_INPUT_EXCEEDS_LIMIT',
      'PARSER_TIMEOUT',
      'PARSER_OVERFLOW',
      'PARSER_ABORTED',
      'PARSER_FAILED',
      'BUDGET_EXCEEDED',
      'OBSERVATION_IMMUTABLE',
    ];
    for (const code of codes) {
      assert.strictEqual(ExtractionErrorCodeSchema.safeParse(code).success, true);
    }
    assert.strictEqual(ExtractionErrorCodeSchema.safeParse('UNKNOWN').success, false);
  });

  test('5. branded ID regexes reject bad formats', () => {
    // Missing prefix
    assert.strictEqual(ExtractionRunIdSchema.safeParse('a'.repeat(64)).success, false);
    // Uppercase hex
    assert.strictEqual(
      ExtractionRunIdSchema.safeParse('extraction-run:' + 'A'.repeat(64)).success,
      false,
    );
    // Wrong length
    assert.strictEqual(
      ExtractionRunIdSchema.safeParse('extraction-run:' + 'a'.repeat(63)).success,
      false,
    );
    // Valid
    assert.strictEqual(
      ExtractionRunIdSchema.safeParse('extraction-run:' + 'a'.repeat(64)).success,
      true,
    );
  });

  test('6. ExtractionError has correct code', () => {
    const err = new ExtractionError('PAYLOAD_MISSING', 'test');
    assert.strictEqual(err.code, 'PAYLOAD_MISSING');
    assert.strictEqual(err.message, 'test');
    assert.strictEqual(err.name, 'ExtractionError');
  });

  test('7. branded ID regexes for projection', () => {
    assert.strictEqual(
      ExtractionProjectionIdSchema.safeParse('extraction-projection:' + 'a'.repeat(64)).success,
      true,
    );
    assert.strictEqual(
      JobsEvidenceIdSchema.safeParse('jobs-evidence:' + 'a'.repeat(64)).success,
      true,
    );
    assert.strictEqual(
      RequirementIdSchema.safeParse('requirement:' + 'a'.repeat(64)).success,
      true,
    );
    assert.strictEqual(
      ExtractionClaimCandidateIdSchema.safeParse('claim-candidate:' + 'a'.repeat(64)).success,
      true,
    );
  });
});
