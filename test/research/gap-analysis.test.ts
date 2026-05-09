import test from 'node:test';
import assert from 'node:assert/strict';
import { GapAnalyzer, GapFiller } from '../../src/research/gapAnalysis.js';
import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from '../../src/research/state.js';
import type { SubQuestionCoverage } from '../../src/research/types.js';

function setupState() {
   const profile = resolveBudgetProfile('standard');
   const budget = new BudgetTracker(profile);
   const state = new ResearchStateEngine(budget);
   state.initialize('Test Query', budget);
   return { state, budget };
}

test('GapAnalyzer detects unanswered sub-questions', () => {
   const { state } = setupState();
   const analyzer = new GapAnalyzer(state);

   state.addSubQuestion({
      id: 'sq1',
      text: 'Pending sub-question',
      status: 'pending',
      classification: 'explainer',
      evidenceType: 'definitional',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 1
   });

   state.addSubQuestion({
      id: 'sq2',
      text: 'InProgress sub-question',
      status: 'in_progress',
      classification: 'explainer',
      evidenceType: 'definitional',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 2
   });

   const gaps = analyzer.analyze();
   const unansweredGaps = gaps.filter(g => g.category === 'unanswered_sub_question');

   assert.strictEqual(unansweredGaps.length, 1);
   assert.strictEqual(unansweredGaps[0]!.subQuestionId, 'sq1');
});

test('GapAnalyzer detects missing source types', () => {
   const { state } = setupState();
   const analyzer = new GapAnalyzer(state);

   // Add only one source type
   state.addSource({
      id: 's1',
      url: 'https://example.com/1',
      sourceType: 'web',
      title: 'Title 1',
      domain: 'example.com',
      isPrimary: false,
      relevantSubQuestions: [],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      subQuestionId: 'sq1'
   });

   const gaps = analyzer.analyze();
   const missingTypeGaps = gaps.filter(g => g.category === 'missing_source_type');

   assert.strictEqual(missingTypeGaps.length, 1);
   assert.ok(missingTypeGaps[0]!.description.includes('Only 1 source type(s) represented'));
});

test('GapAnalyzer detects missing recency', () => {
   const { state } = setupState();
   const analyzer = new GapAnalyzer(state);

   state.addSource({
      id: 's1',
      url: 'https://example.com/old',
      sourceType: 'web',
      title: 'Old Title',
      domain: 'example.com',
      publishedDate: '2020-01-01',
      isPrimary: false,
      relevantSubQuestions: [],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      subQuestionId: 'sq1'
   });

   state.addFinding({
      claim: 'Stale claim',
      normalizedClaim: 'stale claim',
      sourceIds: ['s1'],
      subQuestionIds: ['sq1'],
      freshnessSensitive: true,
      evidenceSummary: '...',
      evidenceDirectness: 'direct',
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   const gaps = analyzer.analyze();
   const recencyGaps = gaps.filter(g => g.category === 'missing_recency');

   assert.strictEqual(recencyGaps.length, 1);
   assert.ok(recencyGaps[0]!.description.includes('sources >1 year old'));
});

test('GapAnalyzer detects overrepresented viewpoints', () => {
   const { state } = setupState();
   const analyzer = new GapAnalyzer(state);

   // Add many sources of the same type
   for (let i = 0; i < 10; i++) {
      state.addSource({
         id: `s${i}`,
         url: `https://example.com/${i}`,
         sourceType: 'web',
         title: `Title ${i}`,
         domain: `example${i}.com`,
         isPrimary: false,
         relevantSubQuestions: [],
         extractionStatus: 'extracted',
         accessDate: new Date().toISOString(),
         subQuestionId: 'sq1'
      });
   }

   const gaps = analyzer.analyze();
   const biasGaps = gaps.filter(g => g.category === 'overrepresented_viewpoint');

   assert.strictEqual(biasGaps.length, 1);
   assert.ok(biasGaps[0]!.description.includes('type "web" dominates'));
});

test('GapAnalyzer detects thin coverage', () => {
   const { state } = setupState();
   const analyzer = new GapAnalyzer(state);

   const coverage: SubQuestionCoverage[] = [{
      subQuestionId: 'sq1',
      subQuestionText: 'Thin question',
      sourceCount: 1,
      uniqueDomainCount: 1,
      findingCount: 1,
      averageContentDepth: 0.8,
      hasPromotionalSources: false,
      sourceTypes: ['web'],
      status: 'thin'
   }];

   const gaps = analyzer.analyze(coverage);
   const thinGaps = gaps.filter(g => g.category === 'single_source_dependency' || g.category === 'thin_coverage');

   assert.strictEqual(thinGaps.length, 1);
   assert.strictEqual(thinGaps[0]!.category, 'single_source_dependency');
});

test('GapFiller does not stop before the standard minimum gap-loop sanity pass', async () => {
   const { state, budget } = setupState();
   const filler = new GapFiller(state, budget);

   state.addSubQuestion({
      id: 'sq1',
      text: 'Well covered question',
      status: 'sufficient',
      classification: 'explainer',
      evidenceType: 'overview',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 1
   });

   await filler.fillGaps([{
      id: 'gap1',
      category: 'missing_recency',
      description: 'Low priority but still needs a sanity pass',
      status: 'open',
      priority: 4,
      suggestedActions: ['Check recency'],
   }]);

   assert.equal(budget.snapshot().gapLoopsUsed, 1);
   assert.equal(filler.shouldContinueLoop(), true);
});
