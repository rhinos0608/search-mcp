/**
 * SynthesisPhase — Phase 7 of the research pipeline.
 *
 * Synthesizes the final research report with URL validation.
 * Extracted from PipelineStrategy.analyze() lines 637-668, 1092-1149.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import type { ResearchResult } from '../types.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import { LlmSynthesizer } from '../llm/synthesis.js';
import { validateUrls } from '../urlHealth.js';
import { logger } from '../../logger.js';

export class SynthesisPhase extends BasePhase {
  readonly name = 'synthesis';
  readonly requiresLlm = false;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    await this.reportProgress(ctx, 95, 'Synthesizing research report', 'synthesis');

    const state = ctx.state.getState();
    const report = await this.synthesize(ctx);

    // URL validation after synthesis
    try {
      const allUrls = state.sources.map((s) => s.url);
      if (allUrls.length > 0) {
        const urlResults = await validateUrls(allUrls);
        const hallucinated = urlResults.filter((r) => r.status === 'LIKELY_HALLUCINATED');
        const dead = urlResults.filter((r) => r.status === 'DEAD');
        if (hallucinated.length > 0) {
          report.openQuestions.push(
            `${String(hallucinated.length)} cited URL(s) may be hallucinated.`,
          );
        }
        if (dead.length > 0) {
          report.sourceNotes.push(`${String(dead.length)} cited URL(s) appear to be dead.`);
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'Citation URL validation failed');
    }

    ctx.state.transitionTo('complete');

    // Store the report in state for the orchestrator to retrieve
    // (PipelineStrategy stored it in this.report field)
    ctx.state.appendDiary(
      `Synthesis complete: ${String(report.findingCount)} findings, ${String(report.sourceCount)} sources`,
    );
  }

  private async synthesize(ctx: StrategyContext): Promise<import('../types.js').ResearchReport> {
    const state = ctx.state.getState();

    if (ctx.llm && !ctx.deterministic) {
      const llmSynth = new LlmSynthesizer(ctx.llm);
      return await llmSynth.synthesize(state);
    } else {
      return new ResearchSynthesizer(state).synthesize();
    }
  }

  // Expose the result for the orchestrator to retrieve
  async getResult(ctx: StrategyContext): Promise<ResearchResult> {
    const state = ctx.state.getState();
    const report = await this.synthesize(ctx);
    return { report, timeline: [{ phase: 'complete' }], canonicalFindings: [...state.findings] };
  }
}
