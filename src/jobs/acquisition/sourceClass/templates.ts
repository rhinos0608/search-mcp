/**
 * W4 per-class default templates.
 *
 * Fail-closed, then overlay enabled rungs, then modeOverrides.
 * Templates map a ladder rung + external access status to a default mode state.
 * No template ever produces 'permitted'; that requires materialization context.
 */
import type { SourcePolicyState } from '../policy/sourcePolicy.js';
import type { ExternalAccessStatus, LadderRung } from './contracts.js';

type ModeTemplateState = Exclude<SourcePolicyState, 'permitted'>;

/**
 * Default state for a rung when external status does not restrict further.
 * Returns undefined when the rung has no fixed default (caller derives).
 */
export function rungTemplateDefault(
  rung: LadderRung,
  externalStatus: ExternalAccessStatus,
): ModeTemplateState | undefined {
  // Technically blocked → always not_supported regardless of rung
  if (externalStatus === 'technically_blocked') return 'not_supported';

  // Indexed-only → direct work not_supported, indexed may be allowed by binding
  if (externalStatus === 'indexed_only' && rung !== 'indexed_discovery') return 'not_supported';

  // Unknown or contractually_restricted → at most requires_review for direct
  if (
    (externalStatus === 'unknown' || externalStatus === 'contractually_restricted') &&
    (rung === 'public_direct_retrieval' || rung === 'registered_adapter')
  )
    return 'requires_review';

  // No default for other combinations; materializer derives from bindings
  return undefined;
}

/**
 * Apply modeOverrides: restrictive overrides replace derived state.
 * Overrides can never express 'permitted'.
 */
export function applyModeOverrides(
  derived: SourcePolicyState,
  overrides: Partial<Record<string, ModeTemplateState>> | undefined,
  mode: string,
): SourcePolicyState {
  if (!overrides) return derived;
  const override = overrides[mode];
  if (override === undefined) return derived;
  // Overrides cannot lift to permitted; if derived is already more restrictive, keep it
  if (derived === 'not_supported') return derived;
  return override;
}
