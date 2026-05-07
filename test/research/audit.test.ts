import test from 'node:test';
import assert from 'node:assert/strict';
import { StateAuditor } from '../../src/research/audit.js';
import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from '../../src/research/state.js';

function setupState() {
   const profile = resolveBudgetProfile('standard');
   const budget = new BudgetTracker(profile);
   const state = new ResearchStateEngine(budget);
   state.initialize('Test Query', budget);
   return { state, budget };
}

test('StateAuditor detects unsourced claims', () => {
   const { state } = setupState();
   const auditor = new StateAuditor(state);

   state.addFinding({
      claim: 'Unsourced claim',
      normalizedClaim: 'unsourced claim',
      sourceIds: [],
      subQuestionIds: ['sq1'],
      evidenceSummary: '...',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   const report = auditor.audit();
   const unsourcedIssues = report.issues.filter(i => i.type === 'unsourced_claim');

   assert.strictEqual(unsourcedIssues.length, 1);
   assert.strictEqual(unsourcedIssues[0]!.severity, 'error');
   assert.strictEqual(report.passed, false);
});

test('StateAuditor detects duplicate claims', () => {
   const { state } = setupState();
   const auditor = new StateAuditor(state);

   state.addFinding({
      claim: 'This is a test claim.',
      normalizedClaim: 'this is a test claim',
      sourceIds: ['s1'],
      subQuestionIds: ['sq1'],
      evidenceSummary: '...',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   state.addFinding({
      claim: 'This is a test claim!',
      normalizedClaim: 'this is a test claim',
      sourceIds: ['s2'],
      subQuestionIds: ['sq1'],
      evidenceSummary: '...',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   const report = auditor.audit();
   const duplicateIssues = report.issues.filter(i => i.type === 'duplicate_claim');

   assert.strictEqual(duplicateIssues.length, 1);
   assert.strictEqual(duplicateIssues[0]!.severity, 'warning');
});

test('StateAuditor detects low source diversity', () => {
   const { state } = setupState();
   const auditor = new StateAuditor(state);

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

   const report = auditor.audit();
   const diversityIssues = report.issues.filter(i => i.type === 'low_source_diversity');

   assert.strictEqual(diversityIssues.length, 1);
   assert.strictEqual(diversityIssues[0]!.severity, 'warning');
});

test('StateAuditor detects taxonomy drift', () => {
   const { state } = setupState();
   const auditor = new StateAuditor(state);

   state.addFinding({
      claim: 'Drifting claim',
      normalizedClaim: 'drifting claim',
      sourceIds: ['s1'],
      subQuestionIds: ['non-existent-sq'],
      evidenceSummary: '...',
      evidenceDirectness: 'direct',
      freshnessSensitive: false,
      lastUpdated: new Date().toISOString(),
      claimType: 'primary'
   });

   const report = auditor.audit();
   const driftIssues = report.issues.filter(i => i.type === 'taxonomy_drift');

   assert.strictEqual(driftIssues.length, 1);
   assert.strictEqual(driftIssues[0]!.severity, 'warning');
});
