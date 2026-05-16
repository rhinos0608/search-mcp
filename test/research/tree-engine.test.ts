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

// NOTE: The full run() test is skipped because it triggers the entire
// discovery pipeline (multiple search backends, HTTP calls). To run it
// properly, each backend would need individual mocking.
