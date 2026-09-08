import type {
  PolicyDecision,
  SourceEdgePolicy,
  SourcePolicy,
  SourcePolicyMode,
} from './sourcePolicy.js';
import { decideSourcePolicy } from './sourcePolicy.js';

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function clonePolicy(policy: SourcePolicy): SourcePolicy {
  return structuredClone(policy);
}

export class SourcePolicyRegistry {
  private readonly policies = new Map<string, SourcePolicy>();
  private readonly edgePolicies: readonly SourceEdgePolicy[];

  constructor(policies: SourcePolicy[] = [], edgePolicies: readonly SourceEdgePolicy[] = []) {
    for (const policy of policies) {
      const copy = clonePolicy(policy);
      this.policies.set(copy.sourceId, deepFreeze(copy));
    }
    this.edgePolicies = deepFreeze(edgePolicies.map((edge) => deepFreeze(structuredClone(edge))));
  }

  get(sourceId: string): SourcePolicy | undefined {
    const policy = this.policies.get(sourceId);
    return policy === undefined ? undefined : deepFreeze(clonePolicy(policy));
  }

  decide(sourceId: string, mode: SourcePolicyMode): PolicyDecision {
    const policy = this.policies.get(sourceId);
    if (policy === undefined) {
      return deepFreeze({
        sourceId,
        mode,
        state: 'not_supported',
        revision: 'none',
        evidenceRefs: [],
        reviewedAt: 'unknown',
      });
    }
    return decideSourcePolicy(policy, mode);
  }

  /**
   * W4 edge-scoped decision keyed by full 7-tuple:
   * sourceId + actor kind/namespace/id + operation + route + target kind.
   *
   * Exact match first. When any exact policy exists for sourceId + operation,
   * mismatched actor/route/target returns fail-closed sentinel; no legacy fallback.
   * Legacy fallback occurs only when no exact rules exist for that source/operation.
   */
  decideEdge(
    sourceId: string,
    actor: { kind: string; namespace: string; id: string },
    operation: SourcePolicyMode,
    route: string,
    targetKind: string,
  ): PolicyDecision {
    // Find exact matches for sourceId + operation
    const exactMatches = this.edgePolicies.filter(
      (ep) => ep.sourceId === sourceId && ep.operation === operation,
    );

    if (exactMatches.length > 0) {
      // Exact match exists: find matching actor/route/target
      const exact = exactMatches.find(
        (ep) =>
          ep.actor.kind === actor.kind &&
          ep.actor.namespace === actor.namespace &&
          ep.actor.id === actor.id &&
          ep.route === route &&
          ep.targetKind === targetKind,
      );
      if (exact) {
        return deepFreeze({
          sourceId: exact.sourceId,
          mode: exact.operation,
          state: exact.state,
          revision: exact.revision,
          evidenceRefs: [...exact.evidenceRefs],
          reviewedAt: exact.reviewedAt,
          ...(exact.notes !== undefined ? { notes: exact.notes } : {}),
        });
      }
      // Mismatched: fail-closed sentinel
      return deepFreeze({
        sourceId,
        mode: operation,
        state: 'not_supported',
        revision: 'none',
        evidenceRefs: [],
        reviewedAt: 'unknown',
        notes: 'exact rule exists but no match for this edge tuple',
      });
    }

    // No exact rules for this source/operation: legacy fallback
    return this.decide(sourceId, operation);
  }
}
