import { createHash } from 'node:crypto';

import { ENRICHMENT_CONTRACT_VERSION } from './contracts.js';

export const ENRICHMENT_ID_MAX_PARTS = 32 as const;
export const ENRICHMENT_ID_MAX_PREIMAGE_BYTES = 32_768 as const;

export type EnrichmentArtifactKind =
  | 'record'
  | 'evidence'
  | 'employer'
  | 'framework'
  | 'salary'
  | 'classification'
  | 'quality'
  | 'attachment'
  | 'claim';

const ARTIFACT_KINDS = new Set<string>([
  'record',
  'evidence',
  'employer',
  'framework',
  'salary',
  'classification',
  'quality',
  'attachment',
  'claim',
]);

export function deterministicEnrichmentId(
  kind: EnrichmentArtifactKind,
  parts: readonly string[],
): string {
  if (typeof kind !== 'string') {
    throw new TypeError('enrichment artifact kind must be a string');
  }
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new RangeError('invalid enrichment artifact kind');
  }
  if (!Array.isArray(parts)) {
    throw new TypeError('enrichment ID parts must be an array');
  }
  if (parts.length > ENRICHMENT_ID_MAX_PARTS) {
    throw new RangeError('enrichment ID parts exceed limit');
  }
  for (const p of parts) {
    if (typeof p !== 'string') {
      throw new TypeError('enrichment ID parts must contain only strings');
    }
  }
  const strParts: string[] = [...(parts as string[])];
  const payload = JSON.stringify([ENRICHMENT_CONTRACT_VERSION, kind, ...strParts]);
  if (Buffer.byteLength(payload, 'utf8') > ENRICHMENT_ID_MAX_PREIMAGE_BYTES) {
    throw new RangeError('enrichment ID preimage exceeds limit');
  }
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase();
  return `${kind}:${hex}`;
}
