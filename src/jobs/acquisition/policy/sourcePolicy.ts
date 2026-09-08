import { z } from 'zod/v4';

export const SOURCE_POLICY_VERSION = '0.1.0';

export const SourcePolicyModeSchema = z.enum([
  'automatedSearch',
  'automatedFetch',
  'userSuppliedContent',
  'manualImport',
  'employerApi',
]);
export type SourcePolicyMode = z.infer<typeof SourcePolicyModeSchema>;

export const SourcePolicyStateSchema = z.enum([
  'permitted',
  'blocked',
  'requires_configuration',
  'requires_review',
  'not_supported',
]);
export type SourcePolicyState = z.infer<typeof SourcePolicyStateSchema>;

export const SourcePolicySchema = z.object({
  sourceId: z.string().min(1),
  revision: z.string().min(1),
  modes: z.record(SourcePolicyModeSchema, SourcePolicyStateSchema),
  evidenceRefs: z.array(z.string()),
  reviewedAt: z.string().min(1),
  notes: z.string().optional(),
});

export type SourcePolicy = z.infer<typeof SourcePolicySchema>;

export interface PolicyDecision {
  sourceId: string;
  mode: SourcePolicyMode;
  state: SourcePolicyState;
  revision: string;
  evidenceRefs: readonly string[];
  reviewedAt: string;
  notes?: string;
}

/** W4 edge-scoped policy decision keyed by full 7-tuple. */
export interface SourceEdgePolicy {
  sourceId: string;
  targetKind: string;
  actor: { kind: string; namespace: string; id: string };
  operation: SourcePolicyMode;
  route: string;
  state: SourcePolicyState;
  revision: string;
  evidenceRefs: readonly string[];
  reviewedAt: string;
  notes?: string;
}

const POLICY_MODES: readonly SourcePolicyMode[] = [
  'automatedSearch',
  'automatedFetch',
  'userSuppliedContent',
  'manualImport',
  'employerApi',
];

const POLICY_STATES: readonly SourcePolicyState[] = [
  'permitted',
  'blocked',
  'requires_configuration',
  'requires_review',
  'not_supported',
];

function isPolicyMode(value: string): value is SourcePolicyMode {
  return POLICY_MODES.includes(value as SourcePolicyMode);
}

function isPolicyState(value: unknown): value is SourcePolicyState {
  return POLICY_STATES.includes(value as SourcePolicyState);
}

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

export function decideSourcePolicy(policy: SourcePolicy, mode: SourcePolicyMode): PolicyDecision {
  const state =
    isPolicyMode(mode) && isPolicyState(policy.modes[mode]) ? policy.modes[mode] : 'not_supported';
  return deepFreeze({
    sourceId: policy.sourceId,
    mode,
    state,
    revision: policy.revision,
    evidenceRefs: [...policy.evidenceRefs],
    reviewedAt: policy.reviewedAt,
    ...(policy.notes !== undefined ? { notes: policy.notes } : {}),
  });
}

export function isPolicyPermitted(decision: PolicyDecision): boolean {
  return decision.state === 'permitted';
}

/** Gate adapter work; blocked decisions never invoke supplied network operation. */
export async function runIfPermitted<T>(
  decision: PolicyDecision,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  return isPolicyPermitted(decision) ? operation() : undefined;
}
