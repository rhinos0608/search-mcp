/**
 * TreeStrategy — breadth×depth recursive exploration for deep research.
 *
 * Today the tree-specific discovery flow lives inside PipelineStrategy's tree
 * branch. This strategy delegates there so callers can select `tree` explicitly
 * through the shared registry and still receive a full ResearchResult.
 */

import { logger } from '../../logger.js';
import type { ResearchStrategy, StrategyContext } from './types.js';
import type { ResearchResult } from '../types.js';
import { PipelineStrategy } from './pipelineStrategy.js';

export class TreeStrategy implements ResearchStrategy {
  readonly name = 'tree';
  readonly description =
    'Breadth×depth recursive exploration (tree research). Best for broad topics requiring hierarchical decomposition.';
  readonly requiresLlm = false;

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    logger.info({ query: query.slice(0, 80) }, 'Tree research strategy starting');
    const pipeline = new PipelineStrategy();
    return pipeline.analyze(query, { ...ctx, depth: 'tree' });
  }
}
