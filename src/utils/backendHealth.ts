/**
 * Sliding-window per-backend health tracker.
 *
 * Tracks per-backend outcomes (success, timeout, error, bot_challenge)
 * over a configurable sliding window and exposes health status with
 * hysteresis-based degradation/recovery thresholds.
 *
 * Degraded threshold: error rate > 20% over the window.
 * Recovery threshold:  error rate < 10% over the window (after degradation).
 */

export type HealthOutcome = 'success' | 'timeout' | 'error' | 'bot_challenge';

export type HealthStatus = 'healthy' | 'degraded' | 'unknown';

export interface BackendHealth {
  windowSize: number;
  errorCount: number;
  errorRate: number;
  status: HealthStatus;
}

interface BackendState {
  outcomes: { outcome: HealthOutcome; timestamp: number }[];
  degraded: boolean;
}

const DEFAULT_WINDOW_SIZE = 50;
/** Maximum age of an outcome entry before it's pruned (5 minutes). */
const WINDOW_AGE_MS = 300_000;

const states = new Map<string, BackendState>();

const ERROR_OUTCOMES: ReadonlySet<HealthOutcome> = new Set(['timeout', 'error', 'bot_challenge']);

function isErrorOutcome(outcome: HealthOutcome): boolean {
  return ERROR_OUTCOMES.has(outcome);
}

function getState(backend: string): BackendState {
  let state = states.get(backend);
  if (state === undefined) {
    state = { outcomes: [], degraded: false };
    states.set(backend, state);
  }
  return state;
}

function pruneWindow(state: BackendState, windowSize: number): void {
  const now = Date.now();

  // Time-based pruning: remove entries older than WINDOW_AGE_MS
  const cutoff = now - WINDOW_AGE_MS;
  const firstRecent = state.outcomes.findIndex((e) => e.timestamp >= cutoff);
  if (firstRecent > 0) {
    state.outcomes.splice(0, firstRecent);
  }

  // Count-based cap as safety net: keep at most `windowSize` entries
  if (state.outcomes.length <= windowSize) return;
  const excess = state.outcomes.length - windowSize;
  state.outcomes.splice(0, excess);
}

function computeHealth(state: BackendState, windowSize: number): BackendHealth {
  if (state.outcomes.length === 0) {
    return { windowSize, errorCount: 0, errorRate: 0, status: 'unknown' };
  }

  const errorCount = state.outcomes.filter((e) => isErrorOutcome(e.outcome)).length;
  const errorRate = errorCount / state.outcomes.length;

  if (state.degraded) {
    // Recovery hysteresis: only return to healthy when error rate drops below 10%
    if (errorRate < 0.1) {
      state.degraded = false;
      return { windowSize, errorCount, errorRate, status: 'healthy' };
    }
    return { windowSize, errorCount, errorRate, status: 'degraded' };
  }

  // Degradation threshold: error rate > 20%
  if (errorRate > 0.2) {
    state.degraded = true;
    return { windowSize, errorCount, errorRate, status: 'degraded' };
  }

  return { windowSize, errorCount, errorRate, status: 'healthy' };
}

/**
 * Record an outcome for a backend.
 */
export function recordOutcome(backend: string, outcome: HealthOutcome): void {
  const state = getState(backend);
  state.outcomes.push({ outcome, timestamp: Date.now() });
  pruneWindow(state, DEFAULT_WINDOW_SIZE);
}

/**
 * Returns true if the backend is healthy (error rate ≤ 20% and not degraded).
 * Returns true for backends with no recorded outcomes (unknown).
 */
export function isHealthy(backend: string): boolean {
  const state = states.get(backend);
  if (state === undefined || state.outcomes.length === 0) return true;
  const health = computeHealth(state, DEFAULT_WINDOW_SIZE);
  return health.status === 'healthy';
}

/**
 * Returns true if the backend is degraded (error rate > 20% and hysteresis has not recovered).
 * Returns false for backends with no recorded outcomes.
 */
export function isDegraded(backend: string): boolean {
  const state = states.get(backend);
  if (state === undefined || state.outcomes.length === 0) return false;
  const health = computeHealth(state, DEFAULT_WINDOW_SIZE);
  return health.status === 'degraded';
}

/**
 * Get full health details for a backend.
 */
export function getHealth(backend: string): BackendHealth {
  const state = states.get(backend);
  if (state === undefined) {
    return { windowSize: DEFAULT_WINDOW_SIZE, errorCount: 0, errorRate: 0, status: 'unknown' };
  }
  return computeHealth(state, DEFAULT_WINDOW_SIZE);
}

/**
 * Reset health data for one backend or all backends.
 */
export function reset(backend?: string): void {
  if (backend === undefined) {
    states.clear();
  } else {
    states.delete(backend);
  }
}
