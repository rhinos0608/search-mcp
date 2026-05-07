import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepTreeResearchEngine } from '../../src/research/treeEngine.js';
import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from '../../src/research/state.js';

function setupState() {
   const profile = resolveBudgetProfile('tree');
   const budget = new BudgetTracker(profile);
   const state = new ResearchStateEngine(budget);
   state.initialize('Test Query', budget);
   return { state, budget };
}

test('DeepTreeResearchEngine initialization', () => {
   const { state, budget } = setupState();
   const engine = new DeepTreeResearchEngine({ state, budget });
   assert.ok(engine);
});

test('DeepTreeResearchEngine run (no LLM)', async () => {
   const { state, budget } = setupState();
   const engine = new DeepTreeResearchEngine({ state, budget });

   // Without LLM, it should do a single-level pass using the query itself
   const result = await engine.run('Test Query', 1, 1);

   assert.ok(result.learnings);
   assert.ok(result.visitedUrls);
});
