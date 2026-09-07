import { z } from 'zod/v4';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionActorSchema,
  AcquisitionCaveatSchema,
  AcquisitionOperationSchema,
  AcquisitionPolicyEdgeSchema,
  AcquisitionRouteSchema,
  PolicyTargetSchema,
  type AcquisitionCaveat,
  type AcquisitionPolicyEdge,
} from '../contracts.js';
import { AcquisitionEdgeIdSchema } from '../ids.js';
import { InstantSchema } from '../../domain/ids.js';
import type { SourcePolicyRegistry } from './registry.js';

export const PolicyEdgeRequestSchema = z
  .object({
    edgeId: AcquisitionEdgeIdSchema,
    actor: AcquisitionActorSchema,
    operation: AcquisitionOperationSchema,
    route: AcquisitionRouteSchema,
    target: PolicyTargetSchema,
  })
  .strict();
export type PolicyEdgeRequest = z.infer<typeof PolicyEdgeRequestSchema>;

export const ResolvePolicyEdgeOptionsSchema = z.object({ decidedAt: InstantSchema }).strict();
export type ResolvePolicyEdgeOptions = z.infer<typeof ResolvePolicyEdgeOptionsSchema>;

export type PolicyExecutionResult<T> =
  | Readonly<{ status: 'executed'; edge: AcquisitionPolicyEdge; value: T }>
  | Readonly<{
      status: 'not_executed';
      edge: AcquisitionPolicyEdge;
      reason: 'informational_only' | 'policy_not_permitted';
    }>;

const FIXED_NOTE = 'policy missing; fail closed';

const CAVEAT_ORDER: readonly AcquisitionCaveat[] = [
  'provider_index_only',
  'publisher_not_fetched',
  'direct_search_blocked',
  'destination_fetch_blocked',
  'direct_access_not_permitted',
  'publisher_policy_unknown',
  'provider_generated_summary',
  'stale_index_possible',
  'content_required',
  'unverified_manual_content',
];
const CAVEAT_ORDER_INDEX = new Map<string, number>(CAVEAT_ORDER.map((v, i) => [v, i]));

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child as T, seen);
    Object.freeze(value);
  }
  return value;
}

function isExactSentinel(decision: {
  state: string;
  revision: string;
  reviewedAt: string;
  evidenceRefs: readonly string[];
}): boolean {
  return (
    decision.state === 'not_supported' &&
    decision.revision === 'none' &&
    decision.reviewedAt === 'unknown' &&
    decision.evidenceRefs.length === 0
  );
}

function buildEdge(
  registry: SourcePolicyRegistry,
  request: PolicyEdgeRequest,
  options: ResolvePolicyEdgeOptions,
  effect: AcquisitionPolicyEdge['effect'],
): AcquisitionPolicyEdge {
  const req = PolicyEdgeRequestSchema.parse(request);
  const opts = ResolvePolicyEdgeOptionsSchema.parse(options);
  // Validate decidedAt already via schema; keep for sentinel check strictness
  InstantSchema.parse(opts.decidedAt);

  const decision = registry.decideEdge(
    req.target.sourceId,
    req.actor,
    req.operation,
    req.route,
    req.target.kind,
  );

  const revision: string = decision.revision;
  const evidenceRefs: readonly string[] = [...decision.evidenceRefs];
  let reviewedAt: string = decision.reviewedAt;
  let notes: string | undefined = decision.notes;

  // reviewedAt records fail-closed decision time only for exact missing-policy sentinel
  // (state not_supported, revision none, reviewedAt unknown, empty evidenceRefs); registry remains metadata authority.
  if (isExactSentinel(decision)) {
    reviewedAt = opts.decidedAt;
    notes = FIXED_NOTE;
  }

  const raw: Record<string, unknown> = {
    edgeId: req.edgeId,
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    actor: req.actor,
    operation: req.operation,
    route: req.route,
    target: req.target,
    state: decision.state,
    effect,
    revision,
    evidenceRefs: [...evidenceRefs],
    reviewedAt,
    ...(notes !== undefined ? { notes } : {}),
  };

  const parsed = AcquisitionPolicyEdgeSchema.parse(raw);
  return deepFreeze(parsed);
}

export function resolveExecutionPolicyEdge(
  registry: SourcePolicyRegistry,
  request: PolicyEdgeRequest,
  options: ResolvePolicyEdgeOptions,
): AcquisitionPolicyEdge {
  return buildEdge(registry, request, options, 'authorized_operation');
}

export function resolveInformationalPolicyEdge(
  registry: SourcePolicyRegistry,
  request: PolicyEdgeRequest,
  options: ResolvePolicyEdgeOptions,
): AcquisitionPolicyEdge {
  return buildEdge(registry, request, options, 'informational_capability');
}

export async function executeIfPolicyPermitted<T>(
  edge: AcquisitionPolicyEdge,
  operation: () => Promise<T>,
): Promise<PolicyExecutionResult<T>> {
  const parsed = AcquisitionPolicyEdgeSchema.parse(edge);
  deepFreeze(parsed);
  if (parsed.effect === 'authorized_operation' && parsed.state === 'permitted') {
    const value = await operation();
    return deepFreeze({ status: 'executed', edge: parsed, value } as const);
  }
  if (parsed.effect === 'informational_capability') {
    return deepFreeze({
      status: 'not_executed',
      edge: parsed,
      reason: 'informational_only',
    } as const);
  }
  return deepFreeze({
    status: 'not_executed',
    edge: parsed,
    reason: 'policy_not_permitted',
  } as const);
}

export function caveatsForInformationalEdges(
  edges: readonly AcquisitionPolicyEdge[],
): readonly AcquisitionCaveat[] {
  const set = new Set<AcquisitionCaveat>();
  for (const raw of edges) {
    const edge = AcquisitionPolicyEdgeSchema.parse(raw);
    if (edge.effect !== 'informational_capability') continue;
    if (edge.route !== 'direct') continue;
    if (
      edge.target.kind !== 'publisher' &&
      edge.target.kind !== 'board' &&
      edge.target.kind !== 'ats_tenant'
    )
      continue;

    let caveat: AcquisitionCaveat | undefined;
    if (edge.state === 'blocked' && edge.operation === 'automatedSearch')
      caveat = 'direct_search_blocked';
    else if (edge.state === 'blocked' && edge.operation === 'automatedFetch')
      caveat = 'destination_fetch_blocked';
    else if (
      edge.state === 'requires_configuration' ||
      edge.state === 'requires_review' ||
      edge.state === 'not_supported'
    )
      caveat = 'publisher_policy_unknown';
    else continue;

    const parsed = AcquisitionCaveatSchema.parse(caveat);
    set.add(parsed);
  }
  const ordered = [...set].sort(
    (a, b) => (CAVEAT_ORDER_INDEX.get(a) ?? 999) - (CAVEAT_ORDER_INDEX.get(b) ?? 999),
  );
  return deepFreeze(ordered);
}
