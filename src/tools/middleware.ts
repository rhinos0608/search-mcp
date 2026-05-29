/**
 * Composable middleware for tool registration.
 *
 * Extracts cross-cutting concerns (fuzzy correction, KG capture) from the
 * inline handler in registerFamily() into reusable composable functions.
 */

import type { SearchConfig } from '../config.js';
import type { KnowledgeGraphHook } from '../knowledge/hook.js';
import { logger } from '../logger.js';
import { correctQuery } from '../utils/fuzzyCorrection.js';

/**
 * Shared context for tool middleware functions.
 * Reserved for future middleware that may need cfg, kgHook, or toolLabel.
 * Currently unused by applyFuzzyCorrection and captureToKnowledgeGraph
 * (they accept narrower interfaces), but kept for consistency across
 * the middleware pipeline so new composable functions share a single ctx type.
 */
export interface MiddlewareContext {
  toolLabel: string;
  cfg: SearchConfig;
  kgHook?: KnowledgeGraphHook;
}

export interface MiddlewareResult {
  data: unknown;
  correction?: {
    original: string;
    corrected: string;
    changes: { original: string; corrected: string; distance: number }[];
  };
}

/**
 * Apply fuzzy correction and capture the correction metadata.
 * Returns the modified args object (query may be corrected in place).
 */
export function applyFuzzyCorrection(
  rawArgs: Record<string, unknown>,
): {
  correctedArgs: Record<string, unknown>;
  correction: MiddlewareResult['correction'];
} {
  const fuzzyOpt = rawArgs.fuzzyCorrect !== false;
  const rawQuery = typeof rawArgs.query === 'string' ? rawArgs.query : undefined;
  const correction = fuzzyOpt && rawQuery
    ? (() => {
        const cr = correctQuery(rawQuery);
        return cr.changes.length > 0
          ? { original: rawQuery, corrected: cr.corrected, changes: cr.changes }
          : undefined;
      })()
    : undefined;

  const correctedArgs = { ...rawArgs };
  if (correction) {
    correctedArgs.query = correction.corrected;
  }

  return { correctedArgs, correction };
}

/**
 * Fire-and-forget KG passive capture. Never fails the tool call.
 */
export function captureToKnowledgeGraph(
  toolLabel: string,
  data: unknown,
  kgHook?: KnowledgeGraphHook,
  kgEnabled?: boolean,
): void {
  if (kgHook && kgEnabled) {
    void kgHook.onToolCall(toolLabel, data).catch((err: unknown) => {
      logger.warn({ err, tool: toolLabel }, 'KG passive capture failed (non-fatal)');
    });
  }
}