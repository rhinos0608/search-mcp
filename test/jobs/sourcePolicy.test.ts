import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SourcePolicyRegistry,
  runIfPermitted,
  type SourcePolicy,
} from '../../src/jobs/acquisition/policy/index.js';

const policy = (): SourcePolicy => ({
  sourceId: 'source-a',
  revision: 'rev-7',
  modes: {
    automatedSearch: 'blocked',
    automatedFetch: 'requires_review',
    userSuppliedContent: 'permitted',
    manualImport: 'requires_configuration',
    employerApi: 'not_supported',
  },
  evidenceRefs: ['evidence-1'],
  reviewedAt: '2026-01-01',
  notes: 'review notes',
});

test('clones and freezes policy ingress and egress', () => {
  const input = policy();
  const registry = new SourcePolicyRegistry([input]);
  input.evidenceRefs.push('injected');
  input.modes.automatedSearch = 'permitted';

  const stored = registry.get('source-a');
  assert.deepEqual(stored?.evidenceRefs, ['evidence-1']);
  assert.equal(stored?.modes.automatedSearch, 'blocked');

  assert.throws(() => stored?.evidenceRefs.push('egress')); // frozen snapshot
  assert.deepEqual(registry.get('source-a')?.evidenceRefs, ['evidence-1']);
});

test('decision evidence is immutable and preserves policy metadata', () => {
  const registry = new SourcePolicyRegistry([policy()]);
  const decision = registry.decide('source-a', 'automatedFetch');

  assert.equal(decision.state, 'requires_review');
  assert.equal(decision.revision, 'rev-7');
  assert.equal(decision.reviewedAt, '2026-01-01');
  assert.equal(decision.notes, 'review notes');
  assert.deepEqual(decision.evidenceRefs, ['evidence-1']);
  assert.throws(() => (decision.evidenceRefs as string[]).push('mutated'));
  assert.deepEqual(registry.get('source-a')?.evidenceRefs, ['evidence-1']);
});

test('unknown source and mode fail closed', () => {
  const registry = new SourcePolicyRegistry([policy()]);
  assert.equal(registry.decide('missing', 'automatedSearch').state, 'not_supported');
  assert.equal(registry.decide('source-a', 'unknown-mode' as never).state, 'not_supported');
});

test('blocked decision performs zero operation calls', async () => {
  const registry = new SourcePolicyRegistry([policy()]);
  const decision = registry.decide('source-a', 'automatedSearch');
  let calls = 0;
  const result = await runIfPermitted(decision, async () => {
    calls += 1;
    return 'called';
  });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});
