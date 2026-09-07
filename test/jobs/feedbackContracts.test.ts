import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEEDBACK_CONTRACT_VERSION,
  LEARNING_RATE,
  LEARNING_RATE_MAX,
  LEARNING_WEIGHT,
  InteractionTypeSchema,
  ResidualFeatureKeySchema,
  GroupedScoreBreakdownSchema,
  RecordedInteractionSchema,
  FeedbackError,
  FeedbackErrorCodeSchema,
} from '../../src/jobs/feedback/contracts.js';
import type { ResidualFeatureKey } from '../../src/jobs/feedback/contracts.js';
import { interactionId, residualSnapshotId } from '../../src/jobs/feedback/ids.js';

// ---------------------------------------------------------------------------
// 1. contract version is 1.0.0 and learning rate equals max 0.05
// ---------------------------------------------------------------------------
test('contract version is 1.0.0 and learning rate equals max 0.05', () => {
  assert.equal(FEEDBACK_CONTRACT_VERSION, '1.0.0');
  assert.equal(LEARNING_RATE, 0.05);
  assert.equal(LEARNING_RATE_MAX, 0.05);
  assert.equal(LEARNING_RATE, LEARNING_RATE_MAX);
});

// ---------------------------------------------------------------------------
// 2. interaction type enum is view click save apply dismiss rating only
// ---------------------------------------------------------------------------
test('interaction type enum is view click save apply dismiss rating only', () => {
  const types = InteractionTypeSchema.options;
  assert.deepStrictEqual(types, ['view', 'click', 'save', 'apply', 'dismiss', 'rating']);
});

// ---------------------------------------------------------------------------
// 3. rating interaction requires rating 1-5
// ---------------------------------------------------------------------------
test('rating interaction requires rating 1-5', () => {
  const result = RecordedInteractionSchema.safeParse({
    interactionId: 'feedback-interaction:' + 'a'.repeat(64),
    contractVersion: '1.0.0',
    profileId: 'profile:default',
    type: 'rating',
    postingId: 'posting-1',
    occurredAt: '2026-01-01T00:00:00+00:00',
    idempotencyKey: 'key-1',
    rating: 4,
    featureKeys: [],
  });
  assert.ok(result.success, `Expected success but got: ${JSON.stringify(result.error)}`);
});

// ---------------------------------------------------------------------------
// 4. non-rating interaction rejects rating field
// ---------------------------------------------------------------------------
test('non-rating interaction rejects rating field', () => {
  const result = RecordedInteractionSchema.safeParse({
    interactionId: 'feedback-interaction:' + 'b'.repeat(64),
    contractVersion: '1.0.0',
    profileId: 'profile:default',
    type: 'click',
    postingId: 'posting-1',
    occurredAt: '2026-01-01T00:00:00+00:00',
    idempotencyKey: 'key-2',
    rating: 3,
    featureKeys: [],
  });
  assert.ok(!result.success, 'Expected failure for click with rating');
});

// ---------------------------------------------------------------------------
// 5. residual feature key rejects organisation-like free text and unknown work_mode
// ---------------------------------------------------------------------------
test('residual feature key rejects organisation-like free text and unknown work_mode', () => {
  const bad1 = ResidualFeatureKeySchema.safeParse({
    dimension: 'role',
    value: 'Acme Corp Engineering',
  });
  assert.ok(!bad1.success, 'Should reject organisation-like free text');

  const bad2 = ResidualFeatureKeySchema.safeParse({ dimension: 'work_mode', value: 'unknown' });
  assert.ok(!bad2.success, 'Should reject unknown work_mode');

  const good = ResidualFeatureKeySchema.safeParse({ dimension: 'work_mode', value: 'remote' });
  assert.ok(good.success, 'Should accept valid work_mode=remote');
});

// ---------------------------------------------------------------------------
// 6. interactionId is deterministic for same idempotency key
// ---------------------------------------------------------------------------
test('interactionId is deterministic for same idempotency key', () => {
  const id1 = interactionId({ profileId: 'profile:default' as const, idempotencyKey: 'k1' });
  const id2 = interactionId({ profileId: 'profile:default' as const, idempotencyKey: 'k1' });
  assert.equal(id1, id2);
  assert.match(id1, /^feedback-interaction:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 7. interactionId differs when idempotency key differs
// ---------------------------------------------------------------------------
test('interactionId differs when idempotency key differs', () => {
  const id1 = interactionId({ profileId: 'profile:default' as const, idempotencyKey: 'k1' });
  const id2 = interactionId({ profileId: 'profile:default' as const, idempotencyKey: 'k2' });
  assert.notEqual(id1, id2);
});

// ---------------------------------------------------------------------------
// 8. residualSnapshotId is deterministic for sorted equivalent feature maps
// ---------------------------------------------------------------------------
test('residualSnapshotId is deterministic for sorted equivalent feature maps', () => {
  const features: readonly { key: ResidualFeatureKey; value: number }[] = [
    { key: { dimension: 'work_mode', value: 'remote' }, value: 0.05 },
    { key: { dimension: 'role', value: 'eng' }, value: 0.03 },
  ];
  const id1 = residualSnapshotId({ profileId: 'profile:default' as const, features });
  const id2 = residualSnapshotId({
    profileId: 'profile:default' as const,
    features: [...features],
  });
  assert.equal(id1, id2);
  assert.match(id1, /^feedback-residual:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 9. residualSnapshotId ignores feature insertion order
// ---------------------------------------------------------------------------
test('residualSnapshotId ignores feature insertion order', () => {
  const f1: readonly { key: ResidualFeatureKey; value: number }[] = [
    { key: { dimension: 'work_mode', value: 'remote' }, value: 0.05 },
    { key: { dimension: 'role', value: 'eng' }, value: 0.03 },
  ];
  const f2: readonly { key: ResidualFeatureKey; value: number }[] = [
    { key: { dimension: 'role', value: 'eng' }, value: 0.03 },
    { key: { dimension: 'work_mode', value: 'remote' }, value: 0.05 },
  ];
  const id1 = residualSnapshotId({ profileId: 'profile:default' as const, features: f1 });
  const id2 = residualSnapshotId({ profileId: 'profile:default' as const, features: f2 });
  assert.equal(id1, id2);
});

// ---------------------------------------------------------------------------
// 10. FeedbackError codes are the closed set
// ---------------------------------------------------------------------------
test('FeedbackError codes are the closed set', () => {
  const codes = FeedbackErrorCodeSchema.options;
  assert.deepStrictEqual(codes, [
    'VALIDATION_ERROR',
    'FORBIDDEN_FORWARD',
    'NOT_FOUND',
    'STORE_INCONSISTENT',
    'LEARNING_RATE_FORBIDDEN',
  ]);

  const err = new FeedbackError('VALIDATION_ERROR', 'test');
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.equal(err.name, 'FeedbackError');
  assert.ok(err instanceof Error);
});

// ---------------------------------------------------------------------------
// 11. GroupedScoreBreakdown is strict and rejects extra keys
// ---------------------------------------------------------------------------
test('GroupedScoreBreakdown is strict and rejects extra keys', () => {
  const valid = GroupedScoreBreakdownSchema.safeParse({
    relevance: 0.5,
    candidateFit: 0.3,
    preferenceFit: 0.7,
    marketState: 0.2,
    evidenceQuality: 0.8,
    personalAdaptation: 0.1,
  });
  assert.ok(valid.success);

  const extra = GroupedScoreBreakdownSchema.safeParse({
    relevance: 0.5,
    candidateFit: 0.3,
    preferenceFit: 0.7,
    marketState: 0.2,
    evidenceQuality: 0.8,
    personalAdaptation: 0.1,
    extraKey: 'bad',
  });
  assert.ok(!extra.success, 'Should reject extra keys');
});

// ---------------------------------------------------------------------------
// 12. LEARNING_WEIGHT.view is 0
// ---------------------------------------------------------------------------
test('LEARNING_WEIGHT.view is 0', () => {
  assert.equal(LEARNING_WEIGHT.view, 0);
});
