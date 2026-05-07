import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from '../../src/research/state.js';
import type { SubQuestion, SourceEntry } from '../../src/research/types.js';

function setupState() {
   const profile = resolveBudgetProfile('standard');
   const budget = new BudgetTracker(profile);
   const state = new ResearchStateEngine(budget);
   state.initialize('Test Query', budget);
   return { state, budget };
}

test('ResearchStateEngine initialization', () => {
   const { state } = setupState();
   const s = state.getState();

   assert.strictEqual(s.query, 'Test Query');
   assert.strictEqual(s.currentPhase, 'idle');
   assert.strictEqual(s.subQuestions.length, 0);
   assert.strictEqual(s.sources.length, 0);
   assert.strictEqual(s.findings.length, 0);
});

test('ResearchStateEngine adds sub-questions', () => {
   const { state } = setupState();
   const sq: SubQuestion = {
      id: 'sq1',
      text: 'What is X?',
      classification: 'explainer',
      evidenceType: 'definitional',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 1,
      status: 'pending'
   };

   state.addSubQuestion(sq);
   assert.strictEqual(state.getSubQuestions().length, 1);
   assert.strictEqual(state.getSubQuestions()[0]!.id, 'sq1');
});

test('ResearchStateEngine adds sources', () => {
   const { state } = setupState();
   const source: SourceEntry = {
      id: 's1',
      title: 'Source 1',
      url: 'https://example.com',
      sourceType: 'web',
      domain: 'example.com',
      isPrimary: false,
      relevantSubQuestions: ['sq1'],
      extractionStatus: 'pending',
      accessDate: new Date().toISOString(),
      subQuestionId: 'sq1'
   };

   state.addSource(source);
   assert.strictEqual(state.sourceCount(), 1);
   assert.strictEqual(state.getSources('sq1').length, 1);
});

test('ResearchStateEngine adds and merges findings', () => {
   const { state } = setupState();

   const fid1 = state.addFinding({
      claim: 'Finding 1',
      normalizedClaim: 'finding 1',
      subQuestionIds: ['sq1'],
      sourceIds: ['s1'],
      evidenceSummary: 'Evidence 1',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   const fid2 = state.addFinding({
      claim: 'Finding 1', // Same claim
      normalizedClaim: 'finding 1',
      subQuestionIds: ['sq2'],
      sourceIds: ['s2'],
      evidenceSummary: 'Evidence 2',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   assert.strictEqual(state.findingCount(), 2);

   state.mergeFindings(fid1, fid2);
   assert.strictEqual(state.findingCount(), 1);

   const merged = state.getFinding(fid1)!;
   assert.ok(merged.subQuestionIds.includes('sq1'));
   assert.ok(merged.subQuestionIds.includes('sq2'));
   assert.ok(merged.sourceIds.includes('s1'));
   assert.ok(merged.sourceIds.includes('s2'));
});

test('ResearchStateEngine computes coverage', () => {
   const { state } = setupState();

   state.addSubQuestion({
      id: 'sq1',
      text: 'Sub-question 1',
      status: 'pending',
      classification: 'explainer',
      evidenceType: 'definitional',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 1
   });

   state.addSource({
      id: 's1',
      url: 'https://example.com/1',
      sourceType: 'web',
      title: 'Title 1',
      domain: 'example.com',
      isPrimary: false,
      relevantSubQuestions: ['sq1'],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      subQuestionId: 'sq1'
   });

   const coverage = state.computeSubQuestionCoverage();
   assert.strictEqual(coverage.length, 1);
   assert.strictEqual(coverage[0]!.subQuestionId, 'sq1');
   assert.strictEqual(coverage[0]!.sourceCount, 1);
   assert.strictEqual(coverage[0]!.status, 'thin'); // 1 source is thin
});
