import { createHash } from 'node:crypto';
import type {
  ExtractionRunId,
  ExtractionProjectionId,
  JobsEvidenceId,
  ExtractionClaimCandidateId,
  RequirementId,
} from './contracts.js';

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function normalizedRawText(rawText: string): string {
  return rawText.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function extractionRunId(
  observationId: string,
  contentHash: string,
  adapterKind: string,
  captureKind: string,
): ExtractionRunId {
  return `extraction-run:${sha256hex(
    JSON.stringify([
      'extraction-run',
      '1.0.0',
      observationId,
      contentHash,
      '1.0.0',
      adapterKind,
      captureKind,
    ]),
  )}`;
}

export function extractionProjectionId(
  observationId: string,
  contentHash: string,
): ExtractionProjectionId {
  return `extraction-projection:${sha256hex(
    JSON.stringify(['extraction-projection', '1.0.0', observationId, contentHash, '1.0.0']),
  )}`;
}

export function jobsEvidenceId(
  observationId: string,
  kind: string,
  fieldPath: string | null,
  jsonPointer: string | null,
  excerptHash: string | null,
  documentFingerprint: string | null,
): JobsEvidenceId {
  return `jobs-evidence:${sha256hex(
    JSON.stringify([
      'jobs-evidence',
      '1.0.0',
      observationId,
      kind,
      fieldPath,
      jsonPointer,
      excerptHash,
      documentFingerprint,
    ]),
  )}`;
}

export function extractionClaimCandidateId(
  observationId: string,
  fieldPath: string,
  origin: string,
  method: string,
  value: unknown,
): ExtractionClaimCandidateId {
  return `claim-candidate:${sha256hex(
    JSON.stringify([
      'claim-candidate',
      '1.0.0',
      observationId,
      fieldPath,
      origin,
      method,
      canonicalJson(value),
    ]),
  )}`;
}

export function extractionRequirementId(
  observationId: string,
  rawText: string,
  category: string,
  force: string,
): RequirementId {
  return `requirement:${sha256hex(
    JSON.stringify([
      'requirement',
      '1.0.0',
      observationId,
      normalizedRawText(rawText),
      category,
      force,
    ]),
  )}`;
}
