import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractionRunId,
  extractionProjectionId,
  jobsEvidenceId,
  extractionClaimCandidateId,
  extractionRequirementId,
} from '../../src/jobs/extraction/ids.js';

describe('W5 extraction IDs', () => {
  const obsId = 'obs-' + 'a'.repeat(60);
  const contentHash = 'hash-' + 'b'.repeat(60);

  test('8. IDs stable under object key insertion order', () => {
    const id1 = extractionClaimCandidateId(obsId, 'title', 'observed', 'text_span', { a: 1, b: 2 });
    const id2 = extractionClaimCandidateId(obsId, 'title', 'observed', 'text_span', { b: 2, a: 1 });
    assert.strictEqual(id1, id2);
  });

  test('9. different fieldPath or value → different claim ID', () => {
    const id1 = extractionClaimCandidateId(obsId, 'title', 'observed', 'text_span', 'Engineer');
    const id2 = extractionClaimCandidateId(
      obsId,
      'organisation',
      'observed',
      'text_span',
      'Engineer',
    );
    assert.notStrictEqual(id1, id2);

    const id3 = extractionClaimCandidateId(obsId, 'title', 'observed', 'text_span', 'Engineer');
    const id4 = extractionClaimCandidateId(obsId, 'title', 'observed', 'text_span', 'Developer');
    assert.notStrictEqual(id3, id4);
  });

  test('10. timestamps do not change IDs', () => {
    const id1 = extractionRunId(obsId, contentHash, 'job_board', 'destination_fetch');
    const id2 = extractionRunId(obsId, contentHash, 'job_board', 'destination_fetch');
    assert.strictEqual(id1, id2);
  });

  test('11. same envelope twice → identical result IDs (idempotent)', () => {
    const run1 = extractionRunId(obsId, contentHash, 'job_board', 'destination_fetch');
    const run2 = extractionRunId(obsId, contentHash, 'job_board', 'destination_fetch');
    assert.strictEqual(run1, run2);

    const proj1 = extractionProjectionId(obsId, contentHash);
    const proj2 = extractionProjectionId(obsId, contentHash);
    assert.strictEqual(proj1, proj2);
  });

  test('runId format correct', () => {
    const id = extractionRunId(obsId, contentHash, 'ats', 'adapter_listing');
    assert.ok(/^extraction-run:[0-9a-f]{64}$/.test(id));
  });

  test('projectionId format correct', () => {
    const id = extractionProjectionId(obsId, contentHash);
    assert.ok(/^extraction-projection:[0-9a-f]{64}$/.test(id));
  });

  test('evidenceId format correct', () => {
    const id = jobsEvidenceId(obsId, 'text_span', 'title', null, null, null);
    assert.ok(/^jobs-evidence:[0-9a-f]{64}$/.test(id));
  });

  test('requirementId normalizes rawText', () => {
    const id1 = extractionRequirementId(obsId, '  Java  Developer  ', 'skill', 'mandatory');
    const id2 = extractionRequirementId(obsId, 'java developer', 'skill', 'mandatory');
    assert.strictEqual(id1, id2);
  });
});
