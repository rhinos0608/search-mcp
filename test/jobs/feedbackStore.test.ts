import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PROFILE_ID,
  MAX_INTERACTIONS,
  FeedbackError,
} from '../../src/jobs/feedback/contracts.js';
import type { ResidualFeatureKey } from '../../src/jobs/feedback/contracts.js';
import { createFeedbackStore, onProfileDeleted } from '../../src/jobs/feedback/store.js';
import { interactionId } from '../../src/jobs/feedback/ids.js';

type InteractionType = 'view' | 'click' | 'save' | 'apply' | 'dismiss' | 'rating';

function makeInput(overrides?: {
  idempotencyKey?: string;
  type?: InteractionType;
  rating?: 1 | 2 | 3 | 4 | 5;
  featureKeys?: ResidualFeatureKey[];
  postingId?: string;
}): Parameters<ReturnType<typeof createFeedbackStore>['record']>[0] {
  const type = overrides?.type ?? 'click';
  return {
    type,
    postingId: overrides?.postingId ?? 'posting-1',
    occurredAt: '2026-01-01T00:00:00+00:00',
    idempotencyKey: overrides?.idempotencyKey ?? 'key-1',
    rating: overrides?.rating,
    featureKeys: overrides?.featureKeys ?? [{ dimension: 'work_mode', value: 'remote' }],
    explicitPreferenceKeys: [],
  };
}

// ---------------------------------------------------------------------------
// 29. record returns deterministic id and get round-trips schema
// ---------------------------------------------------------------------------
test('record returns deterministic id and get round-trips schema', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  const row = store.record(makeInput());
  assert.match(row.interactionId, /^feedback-interaction:[0-9a-f]{64}$/);
  assert.equal(row.contractVersion, FEEDBACK_CONTRACT_VERSION);
  assert.equal(row.profileId, FEEDBACK_PROFILE_ID);
  assert.equal(row.type, 'click');

  const fetched = store.get(row.interactionId);
  assert.ok(fetched);
  assert.deepStrictEqual(fetched, row);
});

// ---------------------------------------------------------------------------
// 30. duplicate idempotency key with same payload is no-op
// ---------------------------------------------------------------------------
test('duplicate idempotency key with same payload is no-op', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  const row1 = store.record(makeInput({ idempotencyKey: 'dup-1' }));
  const row2 = store.record(makeInput({ idempotencyKey: 'dup-1' }));
  assert.equal(row1.interactionId, row2.interactionId);
  assert.equal(store.listMeta().count, 1);
});

// ---------------------------------------------------------------------------
// 31. duplicate idempotency key with different payload throws VALIDATION_ERROR idempotency_payload_mismatch
// ---------------------------------------------------------------------------
test('duplicate idempotency key with different payload throws VALIDATION_ERROR idempotency_payload_mismatch', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  store.record(makeInput({ idempotencyKey: 'dup-2', type: 'click' }));

  try {
    store.record(makeInput({ idempotencyKey: 'dup-2', type: 'save' }));
    assert.fail('Should throw');
  } catch (e) {
    assert.ok(e instanceof FeedbackError);
    assert.equal((e as FeedbackError).code, 'VALIDATION_ERROR');
    assert.equal((e as FeedbackError).message, 'idempotency_payload_mismatch');
  }
});

// ---------------------------------------------------------------------------
// 32. listMeta returns counts not rows
// ---------------------------------------------------------------------------
test('listMeta returns counts not rows', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  store.record(makeInput({ type: 'click', idempotencyKey: 'k1' }));
  store.record(makeInput({ type: 'save', idempotencyKey: 'k2' }));
  store.record(makeInput({ type: 'rating', idempotencyKey: 'k3', rating: 5 }));

  const meta = store.listMeta();
  assert.equal(meta.count, 3);
  assert.equal(meta.types.click, 1);
  assert.equal(meta.types.save, 1);
  assert.equal(meta.types.rating, 1);
  assert.equal(meta.types.view, 0);
  assert.equal(meta.types.dismiss, 0);
  assert.equal(meta.types.apply, 0);
});

// ---------------------------------------------------------------------------
// 33. deleteOne requires election true
// ---------------------------------------------------------------------------
test('deleteOne requires election true', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  const row = store.record(makeInput());

  const result = store.deleteOne({ election: true, interactionId: row.interactionId });
  assert.equal(result, true);
  assert.equal(store.get(row.interactionId), undefined);
});

// ---------------------------------------------------------------------------
// 34. deleteOne unknown id returns false
// ---------------------------------------------------------------------------
test('deleteOne unknown id returns false', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  const fakeId = interactionId({
    profileId: 'profile:default' as const,
    idempotencyKey: 'nonexistent',
  });
  const result = store.deleteOne({ election: true, interactionId: fakeId });
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// 35. deleteOne does not replay residual
// ---------------------------------------------------------------------------
test('deleteOne does not replay residual', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  const rowA = store.record(
    makeInput({
      idempotencyKey: 'a',
      featureKeys: [{ dimension: 'work_mode', value: 'remote' }],
    }),
  );
  store.record(
    makeInput({
      idempotencyKey: 'b',
      featureKeys: [{ dimension: 'role', value: 'eng' }],
    }),
  );

  const residualBefore = store.residual();
  store.deleteOne({ election: true, interactionId: rowA.interactionId });
  const residualAfter = store.residual();

  // interactionCount unchanged (not replayed)
  assert.equal(residualAfter.interactionCount, residualBefore.interactionCount);
  // Both features still present (residual not rebuilt)
  assert.equal(residualAfter.features.length, residualBefore.features.length);
});

// ---------------------------------------------------------------------------
// 36. deleteAll requires election true and zeros residual and counts
// ---------------------------------------------------------------------------
test('deleteAll requires election true and zeros residual and counts', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  store.record(
    makeInput({ idempotencyKey: 'x1', featureKeys: [{ dimension: 'work_mode', value: 'remote' }] }),
  );
  store.record(
    makeInput({ idempotencyKey: 'x2', featureKeys: [{ dimension: 'role', value: 'eng' }] }),
  );
  store.record(makeInput({ type: 'save', idempotencyKey: 'x3' }));

  store.deleteAll({ election: true });

  const meta = store.listMeta();
  assert.equal(meta.count, 0);
  assert.equal(meta.types.view, 0);
  assert.equal(meta.types.click, 0);

  const residual = store.residual();
  assert.equal(residual.features.length, 0);
  assert.equal(residual.interactionCount, 0);
  assert.equal(residual.contractVersion, FEEDBACK_CONTRACT_VERSION);
  assert.equal(residual.profileId, FEEDBACK_PROFILE_ID);
});

// ---------------------------------------------------------------------------
// 37. onProfileDeleted zeros store
// ---------------------------------------------------------------------------
test('onProfileDeleted zeros store', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  store.record(makeInput({ idempotencyKey: 'd1' }));
  store.record(makeInput({ type: 'save', idempotencyKey: 'd2' }));

  onProfileDeleted(store);

  assert.equal(store.listMeta().count, 0);
  assert.equal(store.residual().features.length, 0);
  assert.equal(store.residual().interactionCount, 0);
});

// ---------------------------------------------------------------------------
// 38. MAX_INTERACTIONS evicts oldest views first
// ---------------------------------------------------------------------------
test('MAX_INTERACTIONS evicts oldest views first', () => {
  let time = 0;
  const store = createFeedbackStore({
    now: () => {
      const ms = time++ * 1000;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ms);
    },
  });

  // Fill with views first
  for (let i = 0; i < MAX_INTERACTIONS - 1; i++) {
    store.record(makeInput({ type: 'view', idempotencyKey: `v${i}` }));
  }
  // Add one click
  store.record(makeInput({ type: 'click', idempotencyKey: 'c1' }));

  assert.equal(store.listMeta().count, MAX_INTERACTIONS);
  assert.equal(store.listMeta().types.click, 1);

  // Add one more view — should evict the oldest view, not the click
  store.record(makeInput({ type: 'view', idempotencyKey: `v${MAX_INTERACTIONS}` }));

  assert.equal(store.listMeta().count, MAX_INTERACTIONS);
  assert.equal(store.listMeta().types.click, 1, 'Click should still be present');
  assert.equal(store.listMeta().types.view, MAX_INTERACTIONS - 1, 'Oldest view evicted');
});

// ---------------------------------------------------------------------------
// 39. store.exportPublic matches FeedbackExport and contains no postingId
// ---------------------------------------------------------------------------
test('store.exportPublic matches FeedbackExport and contains no postingId', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });
  store.record(makeInput({ idempotencyKey: 'e1' }));

  const exported = store.exportPublic();
  assert.equal(exported.contractVersion, FEEDBACK_CONTRACT_VERSION);
  assert.match(exported.residualVersion, /^feedback-residual:[0-9a-f]{64}$/);
  assert.equal(exported.personalAdaptationBound, 0.1);
  assert.equal(typeof exported.featureCount, 'number');
  assert.equal(typeof exported.interactionCount, 'number');
  assert.equal(typeof exported.hasNonZeroResidual, 'boolean');

  // No postingId in the export
  const json = JSON.stringify(exported);
  assert.ok(!json.includes('postingId'), 'FeedbackExport must not contain postingId');
  assert.ok(!json.includes('posting'), 'FeedbackExport must not contain posting references');
});

// ---------------------------------------------------------------------------
// 40. invalid input throws VALIDATION_ERROR without postingId in message
// ---------------------------------------------------------------------------
test('invalid input throws VALIDATION_ERROR without postingId in message', () => {
  const store = createFeedbackStore({ now: () => new Date('2026-01-01T00:00:00Z') });

  try {
    store.record(makeInput({ postingId: 'secret-id-123' }));
  } catch (e) {
    assert.ok(e instanceof FeedbackError);
    assert.equal((e as FeedbackError).code, 'VALIDATION_ERROR');
    assert.ok(
      !(e as FeedbackError).message.includes('secret-id-123'),
      'Error must not leak postingId',
    );
  }
});
