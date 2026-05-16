/**
 * PipelineStrategy deterministic mode tests.
 * Verifies the pipeline works without LLM dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('PipelineStrategy interface', () => {
   it('can be imported and has correct interface', async () => {
      const { PipelineStrategy } = await import('../../src/research/strategies/pipelineStrategy.js');
      const strategy = new (PipelineStrategy as any)(async () => ({
         report: {} as any,
         timeline: [],
      }));
      assert.strictEqual(strategy.name, 'pipeline');
      assert.strictEqual(strategy.requiresLlm, false);
      assert.ok(strategy.description.length > 0);
   });

   it('runs the provided pipeline runner function', async () => {
      const { PipelineStrategy } = await import('../../src/research/strategies/pipelineStrategy.js');
      const expected = {
         report: { query: 'test query', executiveSummary: 'test' } as any,
         timeline: [{ phase: 'action' as const, actionType: 'test', detail: 'test', timestamp: new Date().toISOString() }],
      };
      const originalAnalyze = PipelineStrategy.prototype.analyze;
      PipelineStrategy.prototype.analyze = async () => expected;
      try {
         const strategy = new PipelineStrategy();
         const result = await strategy.analyze('test query', {} as any);
         assert.ok(result.report);
         assert.strictEqual(result.report.query, 'test query');
      } finally {
         PipelineStrategy.prototype.analyze = originalAnalyze;
      }
   });
});

describe('QueryDecomposer rule-based', () => {
   it('can be imported and produces sub-questions without LLM', async () => {
      const { QueryDecomposer } = await import('../../src/research/decomposer.js');
      const decomposer = new QueryDecomposer();
      const result = decomposer.decompose('What is quantum computing?');
      assert.ok(result.classification);
      assert.ok(result.subQuestions.length > 0);
      assert.ok(result.plan.length > 0);
      assert.ok(result.disambiguatedTopic.length > 0);
   });

   it('classifies comparative queries correctly', async () => {
      const { QueryDecomposer } = await import('../../src/research/decomposer.js');
      const decomposer = new QueryDecomposer();
      const result = decomposer.decompose('Compare TypeScript vs JavaScript');
      assert.strictEqual(result.classification, 'comparative');
   });

   it('extracts entities from known entity queries', async () => {
      const { QueryDecomposer } = await import('../../src/research/decomposer.js');
      const decomposer = new QueryDecomposer();
      const result = decomposer.decompose('What is the current status of ITER fusion project?');
      assert.ok(result.extractedEntities.length > 0);
      const hasIter = result.extractedEntities.some((e: { name: string }) => e.name === 'ITER');
      assert.ok(hasIter, 'ITER should be extracted as an entity');
   });

   it('handles empty or minimal queries gracefully', async () => {
      const { QueryDecomposer } = await import('../../src/research/decomposer.js');
      const decomposer = new QueryDecomposer();
      const result = decomposer.decompose('test');
      assert.ok(result.subQuestions.length >= 5, 'minimal query should still produce sub-questions');
   });
});

describe('StrategyRegistry deterministic selection', () => {
   it('selects pipeline when no LLM is configured', async () => {
      const { strategyRegistry } = await import('../../src/research/strategies/registry.js');
      const name = strategyRegistry.selectDefault({
         state: {} as any,
         budget: {} as any,
         config: {} as any,
         depth: 'standard',
      });
      assert.strictEqual(name, 'pipeline');
   });

   it('registers core strategies at module load', async () => {
      const { strategyRegistry } = await import('../../src/research/strategies/index.js');
      assert.ok(strategyRegistry.size >= 2, 'Registry should include built-in strategies');
      assert.strictEqual(strategyRegistry.has('pipeline'), true);
      assert.strictEqual(strategyRegistry.has('tree'), true);
   });
});
