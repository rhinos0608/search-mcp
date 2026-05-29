/**
 * Per-tool call statistics tracking.
 *
 * Tracks call counts, error counts, and latency for each tool action.
 * Used to surface operational metrics in health_check.
 */

export interface ToolStatEntry {
  name: string;
  calls: number;
  errors: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
}

interface ToolStatAccumulator {
  calls: number;
  errors: number;
  successfulCalls: number;
  totalLatencyMs: number;
}

export class ToolStats {
  private stats = new Map<string, ToolStatAccumulator>();

  recordSuccess(name: string, latencyMs: number): void {
    const s = this.getOrCreate(name);
    s.calls++;
    s.successfulCalls++;
    s.totalLatencyMs += latencyMs;
  }

  recordError(name: string): void {
    const s = this.getOrCreate(name);
    s.calls++;
    s.errors++;
  }

  get(name: string): ToolStatEntry | undefined {
    const s = this.stats.get(name);
    if (!s) return undefined;
    return this.toEntry(name, s);
  }

  getAll(): ToolStatEntry[] {
    const entries = Array.from(this.stats.entries()).map(([name, s]) => this.toEntry(name, s));
    entries.sort((a, b) => b.calls - a.calls);
    return entries;
  }

  reset(): void {
    this.stats.clear();
  }

  private getOrCreate(name: string): ToolStatAccumulator {
    let s = this.stats.get(name);
    if (!s) {
      s = { calls: 0, errors: 0, successfulCalls: 0, totalLatencyMs: 0 };
      this.stats.set(name, s);
    }
    return s;
  }

  private toEntry(name: string, s: ToolStatAccumulator): ToolStatEntry {
    return {
      name,
      calls: s.calls,
      errors: s.errors,
      totalLatencyMs: s.totalLatencyMs,
      avgLatencyMs: s.successfulCalls > 0 ? Math.round(s.totalLatencyMs / s.successfulCalls) : 0,
    };
  }
}

/** Module-level singleton — imported wherever tool stats are needed. */
export const toolStats = new ToolStats();