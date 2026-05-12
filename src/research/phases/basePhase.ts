/**
 * Base phase infrastructure for the research pipeline.
 *
 * Provides the ResearchPhase interface and BasePhase abstract class
 * with shared behaviour (abort checking, progress reporting).
 */

import type { StrategyContext } from '../strategies/types.js';

export interface ResearchPhase {
  readonly name: string;
  readonly requiresLlm: boolean;
  execute(query: string, ctx: StrategyContext): Promise<void>;
}

export abstract class BasePhase implements ResearchPhase {
  abstract readonly name: string;
  abstract readonly requiresLlm: boolean;
  abstract execute(query: string, ctx: StrategyContext): Promise<void>;

  protected checkAborted(ctx: StrategyContext): void {
    if (ctx.abortSignal?.aborted) {
      throw new DOMException('Research cancelled', 'AbortError');
    }
  }

  protected async reportProgress(
    ctx: StrategyContext,
    progress: number,
    message?: string,
    phaseName?: string,
    partials?: Record<string, unknown>,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, progress));
    try {
      await ctx.onProgress?.(clamped, message, phaseName, {
        sourceCount: ctx.state.sourceCount(),
        findingCount: ctx.state.findingCount(),
        subQuestionCount: ctx.state.getSubQuestions().length,
        ...partials,
      });
    } catch {
      // non-fatal — progress callbacks are best-effort
    }
  }
}
