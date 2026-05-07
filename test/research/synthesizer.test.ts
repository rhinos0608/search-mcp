import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchSynthesizer } from '../../src/research/synthesizer.js';
import type { ResearchState } from '../../src/research/types.js';

function makeEmptyState(query: string): ResearchState {
   return {
      query,
      taxonomy: { originalQuery: query, subQuestions: [], revised: false, revisionHistory: [] },
      subQuestions: [],
      sources: [],
      findings: [],
      contradictions: [],
      openQuestions: [],
      gaps: [],
      claimGraph: [],
      currentPhase: 'complete',
      budget: {
         toolCallsUsed: 0,
         tokensUsed: 0,
         extractionsUsed: 0,
         gapLoopsUsed: 0,
         startTime: Date.now(),
         maxToolCalls: 100,
         maxTokens: 100000,
         maxExtractions: 50,
         maxGapLoops: 3,
         stateEntriesUsed: 0,
         maxStateEntries: 500,
         stepCosts: {},
         maxTimeMs: 300000,
         findingsAddedPerLoop: []
      },
      flags: { taxonomyRevised: false, audited: true, loopCount: 1 },
      gapTargets: [],
      allQuestions: [],
      resolvedGaps: [],
      searchClusters: [],
      diary: [],
      searchAttempts: [],
      workerReports: {},
      contentQuality: {},
      subQuestionCoverage: []
   };
}

test('ResearchSynthesizer handles empty state', () => {
   const state = makeEmptyState('Test Query');
   const synthesizer = new ResearchSynthesizer(state);
   const report = synthesizer.synthesize();

   assert.strictEqual(report.query, 'Test Query');
   assert.ok(report.executiveSummary.includes('No findings were extracted'));
   assert.strictEqual(report.findingCount, 0);
});

test('ResearchSynthesizer builds themes and narrative', () => {
   const state = makeEmptyState('Test Query');
   state.subQuestions.push({
      id: 'sq1',
      text: 'What is X?',
      classification: 'explainer',
      evidenceType: 'definitional',
      preferredSources: [],
      freshnessRequirement: 'any',
      failureModes: [],
      budgetPriority: 1,
      status: 'sufficient'
   });
   state.sources.push({
      id: 's1',
      title: 'Source 1',
      url: 'https://example.com/1',
      sourceType: 'web',
      domain: 'example.com',
      isPrimary: false,
      relevantSubQuestions: ['sq1'],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      subQuestionId: 'sq1'
   });
   state.findings.push({
      id: 'f1',
      claim: 'X is a test concept',
      normalizedClaim: 'x is a test concept',
      subQuestionIds: ['sq1'],
      sourceIds: ['s1'],
      evidenceSummary: 'Evidence for X',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary',
      createdAt: new Date().toISOString()
   });

   const synthesizer = new ResearchSynthesizer(state);
   const report = synthesizer.synthesize();

   assert.strictEqual(report.findingCount, 1);
   assert.strictEqual(report.themes.length, 1);
   assert.strictEqual(report.themes[0]!.title, 'What is X?');
   assert.ok(report.narrativeMarkdown.includes('X is a test concept'));
   assert.ok(report.narrativeMarkdown.includes('[Source 1]'));
});

test('ResearchSynthesizer handles contradictions', () => {
   const state = makeEmptyState('Test Query');
   state.contradictions.push({
      id: 'c1',
      claimA: 'X is fast',
      claimB: 'X is slow',
      sourceIdsA: ['s1'],
      sourceIdsB: ['s2'],
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved'
   });

   const synthesizer = new ResearchSynthesizer(state);
   const report = synthesizer.synthesize();

   assert.strictEqual(report.contradictions.length, 1);
   assert.ok(report.uncertainties.length > 0);
   assert.ok(report.narrativeMarkdown.includes('Contradictions & Debates'));
});
