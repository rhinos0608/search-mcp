/**
 * Output budget tracking for search-mcp.
 *
 * Tracks per-tool response byte counts and session-level aggregates.
 * Side-effect only — does not modify response content.
 *
 * Inspired by mksglu/context-mode's sessionStats pattern.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolBudgetStats {
  calls: number;
  bytesReturned: number;
  avgBytesPerCall: number;
}

export interface OutputBudgetStats {
  totalCalls: number;
  totalBytesReturned: number;
  totalBytesSandboxed: number;
  cacheHits: number;
  cacheBytesSaved: number;
  sessionStart: number;
  savingsRatio: number;
  byTool: Record<string, ToolBudgetStats>;
}

// ── Tracker implementation ───────────────────────────────────────────────────

export class OutputBudgetTracker {
  private calls: Record<string, number> = {};
  private bytesReturned: Record<string, number> = {};
  private bytesSandboxedTotal = 0;
  private cacheHitsTotal = 0;
  private cacheBytesSavedTotal = 0;
  private sessionStart = Date.now();

  /**
   * Record a tool response's byte count.
   * Side-effect only — call after building the response content.
   */
  recordResponse(toolName: string, bytes: number): void {
    this.calls[toolName] = (this.calls[toolName] ?? 0) + 1;
    this.bytesReturned[toolName] = (this.bytesReturned[toolName] ?? 0) + bytes;
  }

  /**
   * Record bytes that were sandboxed (processed externally rather than
   * returned to the LLM context).
   */
  recordSandboxed(_toolName: string, bytes: number): void {
    this.bytesSandboxedTotal += bytes;
  }

  /**
   * Record a cache hit that saved bytes from being re-returned.
   */
  recordCacheHit(bytesSaved: number): void {
    this.cacheHitsTotal++;
    this.cacheBytesSavedTotal += bytesSaved;
  }

  /**
   * Return a snapshot of all accumulated stats.
   */
  getStats(): OutputBudgetStats {
    const totalCalls = Object.values(this.calls).reduce((sum, c) => sum + c, 0);
    const totalBytesReturned = Object.values(this.bytesReturned).reduce((sum, b) => sum + b, 0);
    const byTool: Record<string, ToolBudgetStats> = {};

    for (const [tool, calls] of Object.entries(this.calls)) {
      const bytes = this.bytesReturned[tool] ?? 0;
      byTool[tool] = {
        calls,
        bytesReturned: bytes,
        avgBytesPerCall: calls > 0 ? Math.round(bytes / calls) : 0,
      };
    }

    const totalBytes = totalBytesReturned + this.bytesSandboxedTotal;
    const savingsRatio = totalBytes > 0 ? this.bytesSandboxedTotal / totalBytes : 0;

    return {
      totalCalls,
      totalBytesReturned,
      totalBytesSandboxed: this.bytesSandboxedTotal,
      cacheHits: this.cacheHitsTotal,
      cacheBytesSaved: this.cacheBytesSavedTotal,
      sessionStart: this.sessionStart,
      savingsRatio: Math.round(savingsRatio * 10_000) / 10_000,
      byTool,
    };
  }

  /**
   * Reset all counters (used for testing).
   */
  reset(): void {
    this.calls = {};
    this.bytesReturned = {};
    this.bytesSandboxedTotal = 0;
    this.cacheHitsTotal = 0;
    this.cacheBytesSavedTotal = 0;
    this.sessionStart = Date.now();
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const outputBudget = new OutputBudgetTracker();
