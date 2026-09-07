import type { Evidence } from '../domain/evidence.js';
import { deterministicEnrichmentId } from './ids.js';
import type { EnrichmentWarning, ExtractedFieldSnapshot } from './contracts.js';

export interface AttachmentEnrichmentResult {
  readonly derivedEvidence: Evidence[];
  readonly warnings: EnrichmentWarning[];
}

export function interpretAttachments(
  snapshot: ExtractedFieldSnapshot,
  clock: { producedAt: string },
): AttachmentEnrichmentResult {
  const derivedEvidence: Evidence[] = [];
  const warnings: EnrichmentWarning[] = [];

  const attachmentEvidence = snapshot.evidence.filter((e) => e.kind === 'attachment');

  const fingerprints = new Set<string>();
  for (const ev of attachmentEvidence) {
    const fp = ev.documentFingerprint;
    if (!fp) {
      warnings.push({ code: 'ATTACHMENT_SPAN_MISSING', fieldPath: ev.fieldPath });
      continue;
    }
    if (fingerprints.has(fp)) continue;
    fingerprints.add(fp);

    if (ev.boundedExcerpt) {
      // Bind framework/classification tokens as exact substring match (future: pack Schemes).
      // For now, just emit evidence that the attachment was interpreted.
      const evidenceId = deterministicEnrichmentId('evidence', [
        'attachment',
        'posting',
        ev.subjectId,
        fp,
      ]);
      derivedEvidence.push({
        evidenceId: evidenceId as never,
        subjectType: 'posting',
        subjectId: ev.subjectId,
        fieldPath: ev.fieldPath,
        kind: 'attachment',
        documentFingerprint: fp,
        capturedAt: clock.producedAt,
        confidence: ev.confidence,
        retentionClass: 'enrichment_ephemeral',
      });
    } else {
      warnings.push({ code: 'ATTACHMENT_SPAN_MISSING', fieldPath: ev.fieldPath });
    }
  }

  return { derivedEvidence, warnings };
}
