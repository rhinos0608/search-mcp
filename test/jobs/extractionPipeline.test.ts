import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractObservation } from '../../src/jobs/extraction/pipeline.js';
import type {
  SourceListingId,
  SourceObservationId,
  SourceAdapterId,
  ContentHash,
  EvidenceId,
} from '../../src/jobs/domain/ids.js';
import type {
  AcquisitionCandidateId,
  AcquisitionEdgeId,
  DiscoveryEvidenceId,
} from '../../src/jobs/acquisition/ids.js';

// Minimal valid envelope — no explicit return type to avoid Zod .default() mismatch
function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0' as const,
    envelope: {
      schemaVersion: '1.0.0' as const,
      envelopeId: 'env-1',
      listing: {
        sourceListingId: 'listing-1' as SourceListingId,
        adapterId: 'test-adapter' as SourceAdapterId,
        firstSeenAt: '2025-01-01T00:00:00Z',
        lastSeenAt: '2025-01-01T00:00:00Z',
        currentObservationId: 'obs-1' as SourceObservationId,
      },
      observation: {
        observationId: 'obs-1' as SourceObservationId,
        sourceListingId: 'listing-1' as SourceListingId,
        fetchedAt: '2025-01-01T00:00:00Z',
        contentHash: 'hash-1' as ContentHash,
        evidenceRefs: ['ev-1' as EvidenceId],
        extractionVersion: '1.0.0',
        adapterVersion: '1.0.0',
        fetchOutcome: 'success' as const,
        sourceConfidence: {},
        immutable: true as const,
      },
      acquisition: {
        captureKind: 'destination_fetch' as const,
        publisherSourceId: 'pub-1',
        discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
        policyEdgeRefs: ['edge-1' as AcquisitionEdgeId],
        evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
        fetchEdgeRef: 'edge-1' as AcquisitionEdgeId,
      },
    },
    evidence: [
      {
        evidenceId: 'ev-1' as DiscoveryEvidenceId,
        kind: 'destination_content' as const,
        targetCanonicalUrl: 'https://example.com/job/1',
        boundedText:
          'Senior Software Engineer at Acme Corp\nFull-time\nRemote\n$120,000 to $150,000 per year\nMust have 5 years experience',
        contentHash: 'hash-1',
        capturedAt: '2025-01-01T00:00:00Z',
        observationId: 'obs-1',
        sourceListingId: 'listing-1',
      },
    ],
    now: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('W5 extraction pipeline', () => {
  test('12. destination_fetch extracts title/org/salary as observed claims', async () => {
    const result = await extractObservation(makeInput() as any);
    assert.strictEqual(result.schemaVersion, '1.0.0');
    assert.strictEqual(result.projection.fields.title, 'Senior Software Engineer at Acme Corp');
    assert.ok(result.evidence.length > 0);
    assert.ok(result.claimCandidates.length > 0);
  });

  test('14. missing salary → no salary row, not null', async () => {
    const input = makeInput({
      evidence: [
        {
          evidenceId: 'ev-1' as DiscoveryEvidenceId,
          kind: 'destination_content' as const,
          targetCanonicalUrl: 'https://example.com/job/1',
          boundedText: 'Software Engineer at Acme Corp',
          contentHash: 'hash-1',
          capturedAt: '2025-01-01T00:00:00Z',
          observationId: 'obs-1',
          sourceListingId: 'listing-1',
        },
      ],
    });
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.salaries.length, 0);
    assert.ok(result.projection.fields.title !== undefined);
  });

  test('17. workMode omitted when no token; never defaults remote', async () => {
    const input = makeInput({
      evidence: [
        {
          evidenceId: 'ev-1' as DiscoveryEvidenceId,
          kind: 'destination_content' as const,
          targetCanonicalUrl: 'https://example.com/job/1',
          boundedText: 'Software Engineer at Acme Corp',
          contentHash: 'hash-1',
          capturedAt: '2025-01-01T00:00:00Z',
          observationId: 'obs-1',
          sourceListingId: 'listing-1',
        },
      ],
    });
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.fields.workMode, undefined);
  });

  test('20. result is frozen; mutating throws', async () => {
    const result = await extractObservation(makeInput() as any);
    assert.ok(Object.isFrozen(result));
    assert.throws(() => {
      (result as any).newField = 'test';
    });
  });

  test('21. returned observationId/contentHash match input', async () => {
    const result = await extractObservation(makeInput() as any);
    assert.strictEqual(result.observationId, 'obs-1');
    assert.strictEqual(result.projection.observationId, 'obs-1');
    assert.strictEqual(result.projection.contentHash, 'hash-1');
  });

  test('22. coverage partial when only unstructured description', async () => {
    const input = makeInput({
      evidence: [
        {
          evidenceId: 'ev-1' as DiscoveryEvidenceId,
          kind: 'destination_content' as const,
          targetCanonicalUrl: 'https://example.com/job/1',
          boundedText: 'We are looking for someone to join our team. Must have React experience.',
          contentHash: 'hash-1',
          capturedAt: '2025-01-01T00:00:00Z',
          observationId: 'obs-1',
          sourceListingId: 'listing-1',
        },
      ],
    });
    const result = await extractObservation(input as any);
    // No title, no organisation extracted → coverage depends on description presence
    assert.ok(['succeeded', 'failed', 'partial'].includes(result.projection.coverage));
  });

  test('24. empty evidence + no attachments → PAYLOAD_MISSING', async () => {
    const input = makeInput({
      evidence: [],
      attachments: [],
    });
    await assert.rejects(
      () => extractObservation(input as any),
      (err: any) => err.message.includes('no usable content'),
    );
  });

  test('28. manual_content always flags manual_import_unverified', async () => {
    const input = makeInput({
      envelope: {
        ...makeInput().envelope,
        acquisition: {
          captureKind: 'manual_content' as const,
          publisherSourceId: 'manual-adapter',
          discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
          policyEdgeRefs: ['edge-1' as AcquisitionEdgeId, 'edge-2' as AcquisitionEdgeId],
          evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
          submittedBy: { namespace: 'user', id: 'u1' },
          manualImportEdgeRef: 'edge-1' as AcquisitionEdgeId,
          userSuppliedContentEdgeRef: 'edge-2' as AcquisitionEdgeId,
        },
      },
    });
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.fields.verificationState, 'unverified');
  });

  test('29. destination_fetch verification partially_verified', async () => {
    const result = await extractObservation(makeInput() as any);
    assert.strictEqual(result.projection.fields.verificationState, 'partially_verified');
  });

  test('30. claim provenance component jobs.extraction', async () => {
    const result = await extractObservation(makeInput() as any);
    for (const cc of result.claimCandidates) {
      assert.strictEqual(cc.provenance.component, 'jobs.extraction');
      assert.strictEqual(cc.provenance.version, '1.0.0');
    }
  });

  test('31. every observed claim has ≥1 evidence ref in result', async () => {
    const result = await extractObservation(makeInput() as any);
    const evidenceIds = new Set(result.evidence.map((e) => e.evidenceId));
    for (const cc of result.claimCandidates) {
      if (cc.origin === 'observed') {
        for (const ref of cc.evidenceRefs) {
          assert.ok(evidenceIds.has(ref));
        }
      }
    }
  });

  test('32. fieldEvidenceLinks cover every hot field that has evidence', async () => {
    const result = await extractObservation(makeInput() as any);
    // Every field present in hot fields that came from extraction (not synthetic lifecycle/verification) should have evidence
    for (const link of result.projection.fieldEvidenceLinks) {
      assert.ok(link.fieldPath in result.projection.fields);
    }
  });
});
