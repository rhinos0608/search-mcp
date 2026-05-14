/**
 * DiscoveryPhase — Phase 2 of the research pipeline.
 *
 * Runs broad source discovery with taxonomy revision.
 * Extracted from PipelineStrategy.analyze() lines 415-471.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { DiscoveryEngine } from '../discovery.js';
import { TaxonomyRevision } from '../taxonomy.js';
import { PruningEngine } from '../pruning.js';
import { logger } from '../../logger.js';

export class DiscoveryPhase extends BasePhase {
  readonly name = 'discovery';
  readonly requiresLlm = false;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    logger.info('Phase 2: Broad discovery');

    const discovery = new DiscoveryEngine(
      ctx.state,
      ctx.budget,
      undefined,
      ctx.llm,
      ctx.abortSignal,
    );
    const candidates = await discovery.discover(ctx.state.getSubQuestions());

    // sqSourceCounts removed — progress tracking lives in the phase

    logger.info(
      { sources: ctx.state.sourceCount(), candidates: candidates.length },
      'Discovery complete',
    );
    await this.reportProgress(
      ctx,
      25,
      `Discovery complete: ${String(ctx.state.sourceCount())} sources`,
      'discovery',
    );

    // Pruning
    const pruning = new PruningEngine();
    try {
      pruning.evictSources(ctx.state, ctx.budget);
      pruning.enforceStateGuard(ctx.state, ctx.budget);
    } catch (e) {
      logger.warn({ err: e }, 'Pruning after discovery failed');
    }

    if (ctx.budget.isExhausted()) {
      // Budget exhausted — caller will handle partial synthesis
      return;
    }

    // Taxonomy revision (Phase 1.5)
    if (!ctx.state.isTaxonomyRevised() && candidates.length > 0) {
      const taxonomy = new TaxonomyRevision();
      const { taxonomy: revisedTaxonomy } = taxonomy.revise(ctx.state.getTaxonomy(), candidates);
      if (revisedTaxonomy.revised) {
        ctx.state.reviseTaxonomy(revisedTaxonomy);
        logger.info('Taxonomy revised after early discovery');
        await this.reportProgress(ctx, 30, 'Taxonomy revised', 'taxonomy_revision');
      }
    }
  }
}
