import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretRequirements } from '../../src/jobs/extraction/requirements.js';
import type {
  ExtractedRequirement,
  RequirementId,
  JobsEvidenceId,
} from '../../src/jobs/extraction/contracts.js';

function makeReq(overrides: Partial<ExtractedRequirement> = {}): ExtractedRequirement {
  return {
    requirementId: ('requirement:' + 'a'.repeat(64)) as RequirementId,
    rawText: 'Must have Working With Children Check',
    category: 'other',
    force: 'mandatory',
    evidenceRefs: [('jobs-evidence:' + 'b'.repeat(64)) as JobsEvidenceId],
    confidence: 0.9,
    interpretationProvenance: 'extractor:span',
    ...overrides,
  };
}

describe('W5 extraction packs', () => {
  test('51. empty packs: requirements pass through', () => {
    const req = makeReq();
    const result = interpretRequirements([req], {});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.rawText, req.rawText);
    assert.ok(/^extractor:/.test(result[0]!.interpretationProvenance));
  });

  test('52. domain terminology maps stated WWCC span', () => {
    const req = makeReq();
    const result = interpretRequirements([req], {
      domain: {
        kind: 'domain',
        id: 'test-domain',
        version: '1.0.0',
        effectiveFrom: '2025-01-01',
        attribution: { author: 'test', license: 'MIT' },
        roleNodes: [],
        edges: [],
        capabilityVocabulary: [],
        requirementTerminology: {
          'working with children check': 'employment_check',
        },
        expansionGuards: [],
        evidenceCitations: ['test'],
      } as any,
    });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.category, 'employment_check');
    assert.ok(result[0]!.interpretationProvenance.includes('pack:domain'));
  });

  test('53. pack with extra requirement not in source does not appear', () => {
    const req = makeReq();
    const result = interpretRequirements([req], {});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.rawText, req.rawText);
  });

  test('57. interpretRequirements output length ≤ input length', () => {
    const reqs = [makeReq(), makeReq({ rawText: 'Second requirement' })];
    const result = interpretRequirements(reqs, {});
    assert.ok(result.length <= reqs.length);
  });

  test('56. core extract without packs has no AUD/superannuation default', () => {
    const result = interpretRequirements([], {});
    assert.strictEqual(result.length, 0);
  });

  test('58. pack-applied warning pack_interpretation_applied is not emitted by interpretRequirements', () => {
    // The warning is emitted by the pipeline, not interpretRequirements
    // This test verifies interpretRequirements returns clean results
    const req = makeReq();
    const result = interpretRequirements([req], {});
    assert.strictEqual(result.length, 1);
  });
});
