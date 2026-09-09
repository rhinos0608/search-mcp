/**
 * W4 SEEK source-class factory.
 *
 * Factory receives reviewed evidence metadata and exact authorized manual actors.
 * SEEK direct search/fetch are blocked; indexed discovery is visible through
 * independently permitted providers. Manual import and user-supplied content
 * are permitted for authorized user bindings.
 *
 * SEEK never added to JOBSPY_BOARDS. Global destination flag cannot lift blocks.
 */
import type { AcquisitionPolicyEdge } from '../contracts.js';
import type { AuthorizationEvidence, SourceRegistryEntry } from './contracts.js';

export const SEEK_SOURCE_ID = 'board:seek' as const;

/** Test-path fallback only. Live MCP composition must supply reviewed evidence. */
const SEEK_REVIEWED_AT = '2025-01-01T00:00:00.000Z';

/**
 * Build the frozen SEEK source-class entry.
 * Tests may omit evidence (empty refs). Live jobsDeps must pass reviewed records.
 * reviewedAt is the max evidence timestamp; falls back to the test-path date.
 */
export function buildSeekEntry(
  evidence: readonly AuthorizationEvidence[] = [],
): SourceRegistryEntry {
  const reviewedAt =
    evidence.reduce<string | undefined>((max, e) => {
      const t = e.reviewedAt ?? e.capturedAt;
      return max === undefined || t > max ? t : max;
    }, undefined) ?? SEEK_REVIEWED_AT;
  return {
    schemaVersion: '1.0.0',
    sourceId: SEEK_SOURCE_ID,
    targetKind: 'board',
    rungs: ['indexed_discovery'],
    bindings: [
      // JobSpy direct search: blocked (ADR-012)
      {
        rung: 'indexed_discovery',
        actor: { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
        adapterId: 'jobspy',
        operation: 'automatedSearch',
        route: 'direct',
        stateOverride: 'blocked',
      },
      // Destination fetch: blocked
      {
        rung: 'indexed_discovery',
        actor: { kind: 'adapter', namespace: 'adapter', id: 'destination-fetch' },
        adapterId: 'destination-fetch',
        operation: 'automatedFetch',
        route: 'direct',
        stateOverride: 'blocked',
      },
    ],
    externalAccessStatus: 'contractually_restricted',
    localAuthorization: {
      enabledAdapterIds: [],
      credentialRefs: [],
      destinationFetchEnabled: false,
      riskyModesEnabled: [],
    },
    evidenceRefs: evidence.map((e) => e.evidenceId),
    reviewedAt,
    modeOverrides: {
      automatedSearch: 'blocked',
      automatedFetch: 'blocked',
      employerApi: 'not_supported',
      userSuppliedContent: 'not_supported',
      manualImport: 'not_supported',
    },
  };
}

/**
 * Synthesize informational SEEK edges from modeOverrides without decideEdge
 * provider-actor match. Never authorizes. State stays blocked.
 */
export function informationalSeekEdgesFromEntry(
  seekEntry: SourceRegistryEntry,
  actor: { kind: 'provider'; namespace: 'search-provider'; id: string },
): AcquisitionPolicyEdge[] {
  const ops = ['automatedSearch', 'automatedFetch'] as const;
  const edges: AcquisitionPolicyEdge[] = [];
  for (const operation of ops) {
    const mode = seekEntry.modeOverrides?.[operation];
    if (mode !== 'blocked') continue;
    edges.push({
      edgeId: `info:${actor.id}:${SEEK_SOURCE_ID}:${operation}` as AcquisitionPolicyEdge['edgeId'],
      schemaVersion: '1.0.0',
      actor,
      operation,
      route: 'direct',
      target: { kind: 'board', sourceId: SEEK_SOURCE_ID },
      state: 'blocked',
      effect: 'informational_capability',
      revision: 'seek-source-class/1.0.0',
      evidenceRefs: [...seekEntry.evidenceRefs],
      reviewedAt: seekEntry.reviewedAt,
    });
  }
  return edges;
}

/**
 * Authorized manual user bindings for SEEK.
 * Returns exact SourceRegistryEntry with permitted manualImport and userSuppliedContent.
 * The caller must provide the exact user actor (namespace + id) for authorization.
 */
export function buildSeekManualEntry(
  userActor: { kind: 'user'; namespace: string; id: string },
  adapterId: string,
): SourceRegistryEntry {
  return {
    schemaVersion: '1.0.0',
    sourceId: SEEK_SOURCE_ID,
    targetKind: 'board',
    rungs: ['registered_adapter'],
    bindings: [
      {
        rung: 'registered_adapter',
        actor: userActor,
        adapterId,
        operation: 'manualImport',
        route: 'user_supplied',
      },
      {
        rung: 'registered_adapter',
        actor: userActor,
        adapterId,
        operation: 'userSuppliedContent',
        route: 'user_supplied',
      },
    ],
    externalAccessStatus: 'contractually_restricted',
    localAuthorization: {
      enabledAdapterIds: [adapterId],
      credentialRefs: [],
      destinationFetchEnabled: false,
      riskyModesEnabled: [],
    },
    evidenceRefs: [],
    reviewedAt: SEEK_REVIEWED_AT,
  };
}

/**
 * Authorized user bindings that permit manual operations on SEEK.
 * These are separate entries for the authorized user actor.
 */
export function buildSeekAuthorizedUserBindings(
  userActor: { kind: 'user'; namespace: string; id: string },
  adapterId: string,
): SourceRegistryEntry {
  return buildSeekManualEntry(userActor, adapterId);
}
