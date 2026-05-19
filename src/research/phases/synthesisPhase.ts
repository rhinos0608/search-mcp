/**
 * SynthesisPhase — Phase 7 of the research pipeline.
 *
 * Synthesizes the final research report with URL validation.
 * Extracted from PipelineStrategy.analyze() lines 637-668, 1092-1149.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { ResearchSynthesizer } from '../synthesizer.js';

export class SynthesisPhase extends BasePhase {
  readonly name = 'synthesis';
  readonly requiresLlm = false;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    await this.reportProgress(ctx, 95, 'Synthesizing research report', 'synthesis');

    ctx.state.transitionTo('complete');

    ctx.state.appendDiary('Synthesis phase: report generation deferred to PipelineStrategy');
  }

  // Expose the result for the orchestrator to retrieve
  async getResult(ctx: StrategyContext): Promise<import('../types.js').ResearchResult> {
    const state = ctx.state.getState();
    const report = new ResearchSynthesizer(state).synthesize();
    return { report, timeline: [{ phase: 'complete' }], canonicalFindings: [...state.findings] };
  }
}
