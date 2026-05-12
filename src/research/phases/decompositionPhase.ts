/**
 * DecompositionPhase — Phase 1 of the research pipeline.
 *
 * Decomposes the query into sub-questions with freshness intent.
 * Extracted from PipelineStrategy.analyze() lines 141-172.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { QueryDecomposer } from '../decomposer.js';

export class DecompositionPhase extends BasePhase {
  readonly name = 'decomposition';
  readonly requiresLlm = false;

  async execute(query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    const decomposer = new QueryDecomposer();
    const { classification, subQuestions, disambiguationNote: _disambiguationNote, extractedEntities: _extractedEntities } =
      decomposer.decompose(query);

    for (const sq of subQuestions) {
      if (classification === 'current-events' || classification === 'market-ecosystem') {
        sq.freshnessIntent = 'recent';
      } else if (classification === 'historical-timeline') {
        sq.freshnessIntent = 'historical';
      } else {
        sq.freshnessIntent = 'any';
      }
      ctx.state.addSubQuestion(sq);
    }

    await this.reportProgress(
      ctx,
      10,
      `Query decomposed: ${String(subQuestions.length)} sub-questions`,
      'decomposition',
      { classification },
    );

    if (ctx.budget.isExhausted()) {
      // Budget exhausted — caller will handle partial synthesis
      return;
    }
  }
}
