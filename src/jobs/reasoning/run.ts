import type { ReasoningPacket, ReasoningRunResult } from './contracts.js';
import type { IdempotencyStore } from './submit.js';
import { acceptReasoningSubmission } from './submit.js';
import type { ReasoningProvider } from './provider.js';
import { fallbackSkipped } from './fallback.js';
import { REASONING_BOUNDS } from './contracts.js';
import type { Instant } from '../domain/ids.js';

interface RunInput {
  packet: ReasoningPacket;
  provider: ReasoningProvider | undefined;
  reasoningBudget: number;
  store: IdempotencyStore;
  signal: AbortSignal | undefined;
  now: Instant;
}

/**
 * Run optional reasoning: budget/provider check → invoke → parse → accept or fallback.
 * Never throws for provider I/O. Packet construction errors may throw at caller boundary.
 */
export async function runOptionalReasoning(input: RunInput): Promise<ReasoningRunResult> {
  const { packet, provider, reasoningBudget, store, signal, now } = input;

  // No provider or budget zero → skip, not an error
  if (reasoningBudget <= 0 || !provider) {
    const reason = !provider ? 'no_provider' : 'budget_zero';
    return fallbackSkipped(packet, reason, now);
  }

  const maxInvocations = Math.min(reasoningBudget, REASONING_BOUNDS.maxProviderInvocationsPerRun);

  for (let i = 0; i < maxInvocations; i++) {
    try {
      const { text } = await provider.complete({
        packet,
        ...(signal !== undefined ? { signal } : {}),
      });

      // Parse provider response as proposal body
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return fallbackSkipped(packet, 'provider_invalid', now);
      }

      // Wrap as submission with model origin
      const submission = {
        schemaVersion: '1.0.0' as const,
        submissionId: `reasoning-submission:${crypto.randomUUID()}`,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        expectedPacketRevision: packet.packetRevision,
        idempotencyKey: `provider:${String(packet.packetId)}:${now}:${String(i)}`,
        proposal: parsed,
        provenance: {
          component: 'jobs.reasoning' as const,
          version: '1.0.0' as const,
          origin: 'model_derived' as const,
          model: provider.model,
          promptVersion: 'jobs.reasoning.prompt.v1',
          producedAt: now,
          degradation: 'none' as const,
        },
      };

      const result = acceptReasoningSubmission(packet, submission, store);

      if ('ok' in result && result.ok) {
        return { status: 'accepted', acceptance: result };
      }

      // Provider returned invalid output → fallback, run continues
      return fallbackSkipped(packet, 'provider_invalid', now);
    } catch {
      // Provider throw/timeout/abort → fallback, run continues
      return fallbackSkipped(packet, 'provider_failed', now);
    }
  }

  // Should not reach here with valid budget, but safety fallback
  return fallbackSkipped(packet, 'budget_zero', now);
}
