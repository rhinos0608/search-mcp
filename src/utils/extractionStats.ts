import { logger } from '../logger.js';

interface ExtractionOutcome {
  url: string;
  domain: string;
  success: boolean;
  strategy: string;
  timestamp: number;
  chars: number;
}

const outcomes: ExtractionOutcome[] = [];
const MAX_ENTRIES = 10_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SKIP_THRESHOLD_TOTAL = 5;
const SKIP_THRESHOLD_RATE = 0.05; // 5%
let lastPruneTimestamp = 0;

export function recordOutcome(outcome: ExtractionOutcome): void {
  outcomes.push(outcome);

  // Trim oldest entries if over max
  while (outcomes.length > MAX_ENTRIES) {
    outcomes.shift();
  }

  pruneIfNeeded();
}

function pruneIfNeeded(): void {
  const now = Date.now();
  if (now - lastPruneTimestamp < PRUNE_INTERVAL_MS) return;

  // Remove entries older than 7 days
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  let removals = 0;
  while (outcomes.length > 0) {
    const oldest = outcomes[0];
    if (oldest && oldest.timestamp < cutoff) {
      outcomes.shift();
      removals++;
    } else {
      break;
    }
  }

  if (removals > 0) {
    logger.debug({ removals }, 'extractionStats: pruned old outcomes');
  }

  lastPruneTimestamp = now;
}

export function getDomainStats(
  days?: number,
): Map<string, { total: number; successRate: number }> {
  const cutoff = days !== undefined ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  const byDomain = new Map<string, { total: number; successes: number }>();

  for (const outcome of outcomes) {
    if (outcome.timestamp < cutoff) continue;
    const current = byDomain.get(outcome.domain) ?? { total: 0, successes: 0 };
    current.total++;
    if (outcome.success) current.successes++;
    byDomain.set(outcome.domain, current);
  }

  const stats = new Map<string, { total: number; successRate: number }>();
  for (const [domain, counts] of byDomain) {
    stats.set(domain, {
      total: counts.total,
      successRate: counts.total > 0 ? Math.round((counts.successes / counts.total) * 100) / 100 : 0,
    });
  }

  return stats;
}

export function shouldSkipDomain(domain: string): boolean {
  const stats = getDomainStats();
  const current = stats.get(domain);
  if (current === undefined) return false;

  return current.total > SKIP_THRESHOLD_TOTAL && current.successRate < SKIP_THRESHOLD_RATE;
}

/** Prune old entries and clear all stats (for testing). */
export function resetStats(): void {
  outcomes.length = 0;
  lastPruneTimestamp = 0;
}
