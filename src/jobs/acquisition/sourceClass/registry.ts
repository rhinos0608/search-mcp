/**
 * W4 SourceClassRegistry.
 *
 * Stores source entries, authorization evidence, and produces materialized
 * SourceEdgePolicy[] for SourcePolicyRegistry. All outputs deeply frozen.
 * Lists sorted by Unicode code point. Duplicate source/evidence IDs reject.
 *
 * Import boundary: never imports coordinator, provider internals, adapters,
 * MCP, profile, or persistence modules.
 */
import {
  AuthorizationEvidenceSchema,
  SourceRegistryEntrySchema,
  type AuthorizationEvidence,
  type SourceMaterializationContext,
  type SourceRegistryEntry,
  type SourceEdgePolicy,
} from './contracts.js';
import { sourcePolicyRevision } from './ids.js';
import { applyModeOverrides, rungTemplateDefault } from './templates.js';

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, seen);
    }
    Object.freeze(value);
  }
  return value;
}

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

export class SourceClassRegistry {
  private readonly entries = new Map<string, SourceRegistryEntry>();
  private readonly evidenceById = new Map<string, AuthorizationEvidence>();

  constructor(entries?: readonly unknown[], evidence?: readonly unknown[]) {
    if (entries) {
      for (const raw of entries) {
        this.register(raw);
      }
    }
    if (evidence) {
      for (const raw of evidence) {
        this.registerEvidence(raw);
      }
    }
  }

  registerEvidence(input: unknown): AuthorizationEvidence {
    const parsed = AuthorizationEvidenceSchema.parse(input);
    if (this.evidenceById.has(parsed.evidenceId)) {
      throw new Error(`duplicate source evidence: ${parsed.evidenceId}`);
    }
    const frozen = deepFreeze(structuredClone(parsed));
    this.evidenceById.set(frozen.evidenceId, frozen);
    return frozen;
  }

  register(input: unknown): SourceRegistryEntry {
    const parsed = SourceRegistryEntrySchema.parse(input);
    if (this.entries.has(parsed.sourceId)) {
      throw new Error(`duplicate source registry entry: ${parsed.sourceId}`);
    }
    // Validate evidence refs exist
    for (const ref of parsed.evidenceRefs) {
      if (!this.evidenceById.has(ref)) {
        throw new Error(`unknown evidence ref: ${ref}`);
      }
      const ev = this.evidenceById.get(ref);
      if (!ev) {
        throw new Error(`unknown evidence ref: ${ref}`);
      }
      if (ev.sourceId !== parsed.sourceId) {
        throw new Error(
          `evidence ${ref} sourceId mismatch: expected ${parsed.sourceId}, got ${ev.sourceId}`,
        );
      }
    }
    const frozen = deepFreeze(structuredClone(parsed));
    this.entries.set(frozen.sourceId, frozen);
    return frozen;
  }

  get(sourceId: string): SourceRegistryEntry | undefined {
    const entry = this.entries.get(sourceId);
    return entry === undefined ? undefined : deepFreeze(structuredClone(entry));
  }

  list(): readonly SourceRegistryEntry[] {
    const sorted = [...this.entries.values()].sort((a, b) =>
      compareCodePoints(a.sourceId, b.sourceId),
    );
    return deepFreeze(sorted.map((e) => deepFreeze(structuredClone(e))));
  }

  evidence(evidenceId: string): AuthorizationEvidence | undefined {
    const ev = this.evidenceById.get(evidenceId);
    return ev === undefined ? undefined : deepFreeze(structuredClone(ev));
  }

  /**
   * Materialize SourceEdgePolicy[] from entries + bindings + context.
   *
   * Order:
   * 1. Start not_supported.
   * 2. Exact blocked/not_supported binding or mode override wins immediately.
   * 3. Missing adapter capability → not_supported.
   * 4. Adapter not operator-enabled → requires_configuration.
   * 5. Required credential unavailable → requires_configuration.
   * 6. Apply rung template.
   * 7. External status may prevent automatic permission.
   * 8. Remaining restrictive override replaces derived state.
   * 9. Evidence never changes state.
   * 10. Only exact state:'permitted' plus effect:'authorized_operation' executes.
   */
  materializeEdgePolicies(context: SourceMaterializationContext): readonly SourceEdgePolicy[] {
    const policies: SourceEdgePolicy[] = [];
    const entryList = this.list();

    for (const entry of entryList) {
      const edgePolicies = this.materializeEntry(entry, context);
      for (const ep of edgePolicies) {
        policies.push(ep);
      }
    }

    policies.sort((a, b) => {
      const srcCmp = compareCodePoints(a.sourceId, b.sourceId);
      if (srcCmp !== 0) return srcCmp;
      const opCmp = compareCodePoints(a.operation, b.operation);
      if (opCmp !== 0) return opCmp;
      return compareCodePoints(a.route, b.route);
    });

    return deepFreeze(policies);
  }

  private materializeEntry(
    entry: SourceRegistryEntry,
    context: SourceMaterializationContext,
  ): SourceEdgePolicy[] {
    const policies: SourceEdgePolicy[] = [];
    const evidenceRefs = [...entry.evidenceRefs];

    for (const binding of entry.bindings) {
      let state: SourceEdgePolicy['state'] = 'not_supported';

      // A binding may execute only on a rung explicitly declared by source.
      if (!entry.rungs.includes(binding.rung)) {
        policies.push(
          deepFreeze({
            sourceId: entry.sourceId,
            targetKind: entry.targetKind,
            actor: { ...binding.actor },
            operation: binding.operation,
            route: binding.route,
            state,
            revision: sourcePolicyRevision(JSON.stringify(entry), [state]),
            evidenceRefs,
            reviewedAt: entry.reviewedAt,
          }),
        );
        continue;
      }

      // Destination fetch requires both global and per-source declarations.
      if (
        binding.operation === 'automatedFetch' &&
        (!context.destinationFetchEnabled || !entry.localAuthorization.destinationFetchEnabled)
      ) {
        state = 'requires_configuration';
      }

      // Step 2: exact blocked/not_supported binding or mode override wins immediately
      if (binding.stateOverride === 'blocked' || binding.stateOverride === 'not_supported') {
        state = binding.stateOverride;
      } else if (state === 'requires_configuration') {
        // A disabled destination-fetch flag is fail-closed and cannot be lifted.
      } else {
        // Step 3: missing adapter capability → not_supported
        if (
          !context.capabilityRegistry.supports(binding.adapterId, {
            operation: binding.operation,
            route: binding.route,
            targetKind: entry.targetKind,
          })
        ) {
          state = 'not_supported';
        } else {
          // Step 4: adapter not operator-enabled → requires_configuration
          if (!entry.localAuthorization.enabledAdapterIds.includes(binding.adapterId)) {
            state = 'requires_configuration';
          } else {
            // Step 5: required credential unavailable → requires_configuration
            const needsCredential = binding.rung === 'authenticated_access';
            if (needsCredential) {
              const hasCredential =
                binding.actor.kind === 'system' ||
                entry.localAuthorization.credentialRefs.some((ref) =>
                  context.availableCredentialRefs.has(ref),
                );
              if (!hasCredential) {
                state = 'requires_configuration';
              } else {
                // Step 6: apply rung template
                const templateDefault = rungTemplateDefault(
                  binding.rung,
                  entry.externalAccessStatus,
                );
                if (templateDefault !== undefined) {
                  state = templateDefault;
                } else {
                  // For indexed_discovery with public/known external status: permitted only for exact enabled/capable binding
                  state = 'permitted';
                }
              }
            } else {
              // Step 6: apply rung template
              const templateDefault = rungTemplateDefault(binding.rung, entry.externalAccessStatus);
              if (templateDefault !== undefined) {
                state = templateDefault;
              } else {
                // public or authenticated external status: template may permit
                if (
                  entry.externalAccessStatus === 'public' ||
                  entry.externalAccessStatus === 'authenticated'
                ) {
                  state = 'permitted';
                } else {
                  state = 'not_supported';
                }
              }
            }
          }
        }
      }

      // Step 7: external status may prevent automatic permission
      if (state === 'permitted') {
        if (
          entry.externalAccessStatus === 'unknown' ||
          entry.externalAccessStatus === 'contractually_restricted'
        ) {
          state = 'requires_review';
        } else if (entry.externalAccessStatus === 'indexed_only' && binding.route === 'direct') {
          state = 'not_supported';
        } else if (entry.externalAccessStatus === 'technically_blocked') {
          state = 'not_supported';
        }
      }

      // Step 8: remaining restrictive override replaces derived state
      state = applyModeOverrides(state, entry.modeOverrides, binding.operation);

      // Step 9: evidence never changes state (already handled - evidence is metadata only)

      const revision = sourcePolicyRevision(JSON.stringify(entry), [state]);

      policies.push(
        deepFreeze({
          sourceId: entry.sourceId,
          targetKind: entry.targetKind,
          actor: { ...binding.actor },
          operation: binding.operation,
          route: binding.route,
          state,
          revision,
          evidenceRefs,
          reviewedAt: entry.reviewedAt,
        }),
      );
    }

    return policies;
  }
}
