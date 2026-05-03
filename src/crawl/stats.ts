/**
 * StatsCollector — Unified metrics collection inspired by Scrapy's StatsCollector.
 *
 * Provides counters, gauges, and histograms that can be wired into
 * crawl middleware, chunk pipeline stages, and spider operations.
 *
 * Singleton pattern so it can be accessed from any module.
 *
 * Integrates with existing metrics infrastructure (extractionStats, metrics)
 * while providing a unified frontend.
 */

import type { StatsSnapshot } from './types.js';

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
}

class DefaultStatsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, HistogramState>();

  /** Increment a counter by `value` (default 1). */
  incCounter(name: string, value = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + value);
  }

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record a histogram observation. */
  recordHistogram(name: string, value: number): void {
    const current = this.histograms.get(name);
    if (!current) {
      this.histograms.set(name, {
        count: 1,
        sum: value,
        min: value,
        max: value,
      });
    } else {
      current.count++;
      current.sum += value;
      current.min = Math.min(current.min, value);
      current.max = Math.max(current.max, value);
    }
  }

  /** Return a snapshot of all collected stats. */
  snapshot(): StatsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }

    const gauges: Record<string, number> = {};
    for (const [key, value] of this.gauges) {
      gauges[key] = value;
    }

    const histograms: Record<
      string,
      { count: number; sum: number; min: number; max: number; avg: number }
    > = {};
    for (const [key, h] of this.histograms) {
      histograms[key] = {
        count: h.count,
        sum: h.sum,
        min: h.min,
        max: h.max,
        avg: h.count > 0 ? h.sum / h.count : 0,
      };
    }

    return { counters, gauges, histograms };
  }

  /** Reset all stats. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Get a specific counter value. */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Get a specific gauge value. */
  getGauge(name: string): number | undefined {
    return this.gauges.get(name);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

/** Global stats collector instance. */
export const statsCollector = new DefaultStatsCollector();

// ── Convenience Wrappers ──────────────────────────────────────────────────

/** Shorthand for statsCollector.incCounter. */
export function incCounter(name: string, value?: number): void {
  statsCollector.incCounter(name, value);
}

/** Shorthand for statsCollector.setGauge. */
export function setGauge(name: string, value: number): void {
  statsCollector.setGauge(name, value);
}

/** Shorthand for statsCollector.recordHistogram. */
export function recordHistogram(name: string, value: number): void {
  statsCollector.recordHistogram(name, value);
}

/** Shorthand for statsCollector.snapshot. */
export function getStatsSnapshot(): StatsSnapshot {
  return statsCollector.snapshot();
}

/** Shorthand for statsCollector.reset. */
export function resetStats(): void {
  statsCollector.reset();
}
