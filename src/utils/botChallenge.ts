/**
 * Bot-challenge detection, exponential backoff, and circuit-breaker state machine.
 *
 * Detects bot challenges from provider HTTP responses (403/429, CAPTCHA HTML,
 * challenge scripts, redirect patterns, latency spikes) and manages per-backend
 * circuit-breaker state with automatic recovery.
 */

// ── Types ───────────────────────────────────────────────────────────────────

import { logger } from '../logger.js';

export interface ChallengeResult {
  isChallenge: boolean;
  type?: 'status' | 'captcha' | 'script' | 'redirect' | 'latency';
  detail?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerState {
  state: CircuitState;
  consecutiveChallenges: number;
  lastChallengeTime: number;
  /** When in open state, the time after which the circuit may transition to half-open. */
  openUntil: number;
  /** Current backoff delay before this entry (calculated, not raw counter). */
  currentDelay: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

const INITIAL_DELAY_MS = 10_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_DELAY_MS = 300_000;
const JITTER_RANGE = 0.2; // +/- 20%
const TRIP_THRESHOLD = 3; // consecutive challenges within 5 min window to trip
const TRIP_WINDOW_MS = 300_000; // 5 minutes

// ── State ───────────────────────────────────────────────────────────────────

const circuits = new Map<string, CircuitBreakerState>();

function getCircuit(backend: string): CircuitBreakerState {
  let state = circuits.get(backend);
  if (state === undefined) {
    state = {
      state: 'closed',
      consecutiveChallenges: 0,
      lastChallengeTime: 0,
      openUntil: 0,
      currentDelay: INITIAL_DELAY_MS,
    };
    circuits.set(backend, state);
  }
  return state;
}

// ── Challenge Detection ─────────────────────────────────────────────────────

const CHALLENGE_DOMAINS = /challenge|verify|recaptcha|human\.com/i;
const CAPTCHA_IFRAME = /<iframe[^>]*captcha/i;
const CHALLENGE_SCRIPT = /<script[^>]*(?:challenge|verify|recaptcha|turnstile)/i;

/**
 * Analyze an HTTP response for bot-challenge indicators.
 */
export function detectChallenge(
  statusCode: number,
  _headers: Record<string, string>,
  body?: string,
  latencyMs?: number,
  latencyThreshold = 5000,
): ChallengeResult {
  let score = 0;
  let type: ChallengeResult['type'];
  let detail: string | undefined;

  // Status-code-based detection (Strong signal)
  if (statusCode === 403) {
    score += 10;
    type = 'status';
    detail = 'HTTP 403 Forbidden';
  } else if (statusCode === 429) {
    score += 10;
    type = 'status';
    detail = 'HTTP 429 Too Many Requests';
  }

  // Latency-based detection (Weak signal)
  // Unusually slow response can be an indicator when paired with other signals.
  if (latencyMs !== undefined && latencyMs > latencyThreshold) {
    score += 2;
    if (!type) {
      type = 'latency';
      detail = `Response latency ${String(latencyMs)}ms exceeds ${String(latencyThreshold)}ms threshold`;
    }
  }

  // HTML-fingerprint-based detection
  if (body !== undefined) {
    // 1. Empty or very short body (Suspicious/Strong signal depending on context)
    if (body.length < 200) {
      score += 5; // Weak signal on its own
    }

    // 2. CAPTCHA iframe — most specific (Strong signal)
    if (CAPTCHA_IFRAME.test(body)) {
      score += 10;
      type = 'captcha';
      detail = 'CAPTCHA iframe detected in HTML';
    }

    // 3. Challenge script tags (Strong signal)
    if (CHALLENGE_SCRIPT.test(body)) {
      score += 10;
      type ??= 'script';
      detail ??= 'Challenge script tag detected in HTML';
    }

    // 4. Generic challenge domain (Strong signal if body is short/suspicious)
    if (CHALLENGE_DOMAINS.test(body)) {
      score += body.length < 5000 ? 10 : 5;
      type ??= 'redirect';
      detail ??= 'Challenge domain detected in response';
    }
  }

  return {
    isChallenge: score >= 10,
    ...(score >= 10 ? { type, detail } : {}),
  } as ChallengeResult;
}

// ── Backoff ─────────────────────────────────────────────────────────────────

function applyJitter(delayMs: number): number {
  const jitter = delayMs * JITTER_RANGE;
  return Math.round(delayMs + (Math.random() * 2 - 1) * jitter);
}

/**
 * Get the current backoff delay for a backend (in milliseconds).
 * Returns the accumulated delay based on consecutive challenge count.
 * Returns 0 only when there have been no challenges.
 */
export function getBackoffDelay(backend: string): number {
  const circuit = getCircuit(backend);
  if (circuit.consecutiveChallenges === 0) return 0;
  return circuit.currentDelay;
}

// ── Circuit Breaker ─────────────────────────────────────────────────────────

/**
 * Record a challenge for a backend. May trip the circuit breaker.
 */
export function recordChallenge(backend: string): void {
  const circuit = getCircuit(backend);
  const now = Date.now();

  // Reset consecutive count if outside the trip window
  if (now - circuit.lastChallengeTime > TRIP_WINDOW_MS) {
    circuit.consecutiveChallenges = 0;
    circuit.currentDelay = INITIAL_DELAY_MS;
  }

  circuit.consecutiveChallenges++;
  circuit.lastChallengeTime = now;

  // Apply exponential backoff
  if (circuit.consecutiveChallenges > 1) {
    circuit.currentDelay = Math.min(circuit.currentDelay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
  }

  // Trip circuit if threshold reached
  if (circuit.consecutiveChallenges >= TRIP_THRESHOLD) {
    circuit.state = 'open';
    // Apply jitter, but never exceed the configured max delay
    circuit.currentDelay = Math.min(applyJitter(circuit.currentDelay), MAX_DELAY_MS);
    circuit.openUntil = now + circuit.currentDelay;
  }
}

/**
 * Record a successful response. Resets the backoff and may close the circuit.
 */
export function recordSuccess(backend: string): void {
  const circuit = getCircuit(backend);

  if (circuit.state === 'half-open') {
    // Success in half-open → close circuit
    circuit.state = 'closed';
    circuit.consecutiveChallenges = 0;
    circuit.currentDelay = INITIAL_DELAY_MS;
    circuit.openUntil = 0;
  } else if (circuit.state === 'closed') {
    // Success in closed → just reset challenge count
    circuit.consecutiveChallenges = 0;
    circuit.currentDelay = INITIAL_DELAY_MS;
  }
  // If open, recordSuccess does nothing — caller must handle via isCircuitTripped
}

/**
 * Returns true if the circuit is tripped (open) and has not yet auto-recovered.
 * Automatically transitions to half-open when backoff period elapses.
 */
export function isCircuitTripped(backend: string): boolean {
  const circuit = circuits.get(backend);
  if (circuit === undefined) return false;

  if (circuit.state === 'closed') return false;
  if (circuit.state === 'half-open') return false;

  // Check auto-recovery: if backoff period has elapsed, transition to half-open
  if (Date.now() >= circuit.openUntil) {
    circuit.state = 'half-open';
    logger.info(
      { backend, circuitState: 'half-open' },
      'Circuit breaker auto-recovered to half-open',
    );
    return false;
  }

  return true;
}

/**
 * Reset circuit breaker state for one backend or all backends.
 */
export function resetCircuit(backend?: string): void {
  if (backend === undefined) {
    circuits.clear();
  } else {
    circuits.delete(backend);
  }
}
