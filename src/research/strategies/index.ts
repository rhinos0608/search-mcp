/**
 * Strategy registration.
 *
 * Strategies register once at module load so callers can rely on the registry
 * without constructor side effects.
 */

import { strategyRegistry } from './registry.js';
import { PipelineStrategy } from './pipelineStrategy.js';
import { AgentStrategy } from './agentStrategy.js';
import { TreeStrategy } from './treeStrategy.js';
import type {
  ResearchStrategy,
  StrategyContext,
  StrategyFactory,
  ProgressCallback,
} from './types.js';

if (!strategyRegistry.has('pipeline')) {
  strategyRegistry.register('pipeline', () => new PipelineStrategy());
}

if (!strategyRegistry.has('agent')) {
  strategyRegistry.register('agent', (ctx) => new AgentStrategy(ctx));
}

if (!strategyRegistry.has('tree')) {
  strategyRegistry.register('tree', () => new TreeStrategy());
}

export { strategyRegistry, PipelineStrategy, AgentStrategy, TreeStrategy };
export type { ResearchStrategy, StrategyContext, StrategyFactory, ProgressCallback };
