/**
 * W4 deterministic source-class IDs.
 *
 * Evidence: source-evidence:sha256(...)
 * Policy revision: source-policy:sha256(...)
 * ATS source ID: ats-tenant:<platform>:<normalized stable tenant key>
 *
 * Existing IDs remain unchanged: board:seek, search-provider:*, bare JobSpy board IDs.
 */
import { createHash } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic evidence ID.
 * source-evidence:sha256(["source-evidence","1.0.0",sourceId,kind,capturedAt,citationRef|null,contentHash|null])
 */
export function sourceEvidenceId(
  sourceId: string,
  kind: string,
  capturedAt: string,
  citationRef: string | undefined,
  contentHash: string | undefined,
): `source-evidence:${string}` {
  const payload = JSON.stringify([
    'source-evidence',
    '1.0.0',
    sourceId,
    kind,
    capturedAt,
    citationRef ?? null,
    contentHash ?? null,
  ]);
  return `source-evidence:${sha256Hex(payload)}`;
}

/**
 * Deterministic policy revision.
 * source-policy:sha256(["source-policy","1.0.0",canonicalEntry,sortedMaterializedEdgeStates])
 */
export function sourcePolicyRevision(
  entryCanon: string,
  edgeStates: readonly string[],
): `source-policy:${string}` {
  const payload = JSON.stringify(['source-policy', '1.0.0', entryCanon, [...edgeStates].sort()]);
  return `source-policy:${sha256Hex(payload)}`;
}

/**
 * Deterministic ATS source ID.
 * ats-tenant:<platform>:<normalized stable tenant key>
 */
export function atsTenantSourceId(platform: string, normalizedKey: string): string {
  return `ats-tenant:${platform}:${normalizedKey}`;
}
