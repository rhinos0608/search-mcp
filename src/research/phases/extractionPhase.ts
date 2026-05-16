/**
 * ExtractionPhase — Phase 3 of the research pipeline.
 *
 * V5: Runs hybrid retrieval + cross-encoder rerank + LLM extraction when LLM
 * is available; falls back to rule-based extraction when not.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { ExtractionEngine } from '../extraction.js';
import { PruningEngine } from '../pruning.js';
import { logger } from '../../logger.js';

export class ExtractionPhase extends BasePhase {
  readonly name = 'extraction';
  readonly requiresLlm = false;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    logger.info('Phase 3: Deep extraction');

    const extractionTargets = ctx.state.getTopSources(ctx.budget.profile.maxExtractions);
    if (extractionTargets.length > 0) {
      const extraction = new ExtractionEngine(ctx.state, ctx.budget, undefined, ctx.llm);
      const findingIds = await extraction.extract(extractionTargets);
      const findings = findingIds
        .map((id) => ctx.state.getFinding(id))
        .filter((f): f is import('../types.js').Finding => f !== undefined);

      logger.info(
        { findings: findings.length, extracted: extractionTargets.length },
        'Extraction complete',
      );
      await this.reportProgress(
        ctx,
        50,
        `Extraction complete: ${String(findings.length)} findings`,
        'extraction',
      );

      try {
        const pruning = new PruningEngine();
        pruning.enforceStateGuard(ctx.state, ctx.budget);
      } catch (e) {
        logger.warn({ err: e }, 'Pruning after extraction failed');
      }

      if (ctx.budget.isExhausted()) {
        // Budget exhausted — caller will handle partial synthesis
        return;
      }

      const postResults = ctx.state.postProcessFindings();
      logger.info(
        { merged: postResults.merged, contradictions: postResults.contradictions },
        'Post-extraction processing complete',
      );
    }
  }
}
