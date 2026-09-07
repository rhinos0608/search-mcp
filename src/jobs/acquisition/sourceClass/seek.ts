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
import type { SourceRegistryEntry } from './contracts.js';

export const SEEK_SOURCE_ID = 'board:seek' as const;

/**
 * Build the frozen SEEK source-class entry.
 * Idempotent: always produces the same entry given the same inputs.
 */
export function buildSeekEntry(): SourceRegistryEntry {
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
    evidenceRefs: [],
    reviewedAt: new Date().toISOString(),
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
    reviewedAt: new Date().toISOString(),
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
