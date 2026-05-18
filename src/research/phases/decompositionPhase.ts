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

    let result: import('../decomposer.js').DecomposeResult;

    if (ctx.llm && ctx.entities && ctx.entities.names.length > 0) {
      result = await decomposer.llmDecomposeWithEntities(
        query,
        ctx.llm,
        ctx.state,
        ctx.entities.names.map((name) => ({ name, domain: ctx.route?.category ?? 'unknown' })),
      );
    } else {
      result = decomposer.decompose(query);
    }

    const { classification, subQuestions } = result;

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
      return;
    }
  }
}
