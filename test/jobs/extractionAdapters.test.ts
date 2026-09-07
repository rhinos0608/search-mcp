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

function makeInput(
  captureKind: 'destination_fetch' | 'adapter_listing' | 'manual_content',
  overrides: Record<string, unknown> = {},
) {
  const listing = {
    sourceListingId: 'listing-1' as SourceListingId,
    adapterId: 'jobspy' as SourceAdapterId,
    firstSeenAt: '2025-01-01T00:00:00Z',
    lastSeenAt: '2025-01-01T00:00:00Z',
    currentObservationId: 'obs-1' as SourceObservationId,
  };

  const observation = {
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
  };

  const policyEdgeRefs =
    captureKind === 'manual_content'
      ? ['edge-1' as AcquisitionEdgeId, 'edge-2' as AcquisitionEdgeId]
      : ['edge-1' as AcquisitionEdgeId];

  let acquisition: Record<string, unknown>;
  if (captureKind === 'destination_fetch') {
    acquisition = {
      captureKind,
      publisherSourceId: 'pub-1',
      discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
      policyEdgeRefs,
      evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
      fetchEdgeRef: 'edge-1' as AcquisitionEdgeId,
    };
  } else if (captureKind === 'adapter_listing') {
    acquisition = {
      captureKind,
      publisherSourceId: 'pub-1',
      discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
      policyEdgeRefs,
      evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
      adapterId: 'jobspy',
      acquisitionEdgeRef: 'edge-1' as AcquisitionEdgeId,
    };
  } else {
    acquisition = {
      captureKind,
      publisherSourceId: 'pub-1',
      discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
      policyEdgeRefs,
      evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
      submittedBy: { namespace: 'user', id: 'u1' },
      manualImportEdgeRef: 'edge-1' as AcquisitionEdgeId,
      userSuppliedContentEdgeRef: 'edge-2' as AcquisitionEdgeId,
    };
  }

  const evidenceKind =
    captureKind === 'destination_fetch'
      ? ('destination_content' as const)
      : captureKind === 'adapter_listing'
        ? ('adapter_listing' as const)
        : ('user_supplied_content' as const);

  const evidenceBase: Record<string, unknown> = {
    evidenceId: 'ev-1' as DiscoveryEvidenceId,
    kind: evidenceKind,
    targetCanonicalUrl: 'https://example.com/job/1',
    boundedText: 'Software Engineer at Acme Corp. Full-time.',
    contentHash: 'hash-1',
    capturedAt: '2025-01-01T00:00:00Z',
    observationId: 'obs-1',
    sourceListingId: 'listing-1',
  };

  if (captureKind === 'adapter_listing') {
    Object.assign(evidenceBase, { adapterId: 'jobspy', publisherSourceId: 'pub-1' });
  } else if (captureKind === 'manual_content') {
    Object.assign(evidenceBase, { submittedBy: { namespace: 'user', id: 'u1' } });
  }

  return {
    schemaVersion: '1.0.0' as const,
    envelope: {
      schemaVersion: '1.0.0' as const,
      envelopeId: 'env-1',
      listing,
      observation,
      acquisition,
    },
    evidence: [evidenceBase],
    now: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('W5 extraction adapters', () => {
  test('33. jobspy adapter_listing dispatches job_board', async () => {
    const result = await extractObservation(makeInput('adapter_listing') as any);
    assert.strictEqual(result.projection.adapterKind, 'job_board');
  });

  test('34. ats_tenant destination_fetch dispatches ats', async () => {
    const input = makeInput('destination_fetch');
    input.envelope.acquisition = {
      captureKind: 'destination_fetch',
      publisherSourceId: 'ats-pub',
      discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
      policyEdgeRefs: ['edge-1' as AcquisitionEdgeId],
      evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
      fetchEdgeRef: 'edge-1' as AcquisitionEdgeId,
      publisher: { kind: 'ats_tenant', sourceId: 'ats-pub' },
    } as any;
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.adapterKind, 'ats');
  });

  test('35. gov: sourceId dispatches government', async () => {
    const input = makeInput('destination_fetch');
    input.envelope.acquisition = {
      captureKind: 'destination_fetch',
      publisherSourceId: 'gov:aps-jobs',
      discoveryCandidateIds: ['cand-1' as AcquisitionCandidateId],
      policyEdgeRefs: ['edge-1' as AcquisitionEdgeId],
      evidenceRefs: ['ev-1' as DiscoveryEvidenceId],
      fetchEdgeRef: 'edge-1' as AcquisitionEdgeId,
    } as any;
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.adapterKind, 'government');
  });

  test('36. manual structured_fields maps without fetch', async () => {
    const input = makeInput('manual_content');
    const result = await extractObservation(input as any);
    assert.strictEqual(result.projection.adapterKind, 'manual');
    assert.strictEqual(result.projection.captureKind, 'manual_content');
  });

  test('38. four kinds share requirement span rules; none invents extra', async () => {
    for (const kind of ['destination_fetch', 'adapter_listing', 'manual_content'] as const) {
      const result = await extractObservation(makeInput(kind) as any);
      // No invented requirements without source span
      assert.strictEqual(result.projection.requirements.length, 0);
    }
  });
});
