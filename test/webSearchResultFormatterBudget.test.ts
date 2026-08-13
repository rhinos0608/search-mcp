import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankDocumentBudget,
  DEFAULT_TOTAL_BUDGET_BYTES,
  DEFAULT_DOCUMENT_BUDGET_BYTES,
  DOCUMENT_BUDGET_CEILING_BYTES,
} from '../src/tools/webSearchResultFormatter.js';

test('rankDocumentBudget gives rank-1 a larger byte budget than rank-N', () => {
  const total = DEFAULT_TOTAL_BUDGET_BYTES;
  const n = 10;
  const first = rankDocumentBudget(0, n, total);
  const last = rankDocumentBudget(n - 1, n, total);
  assert.ok(first > last, `rank-1 (${first}) should exceed rank-N (${last})`);
});

test('rankDocumentBudget tapers monotonically across ranks', () => {
  const total = DEFAULT_TOTAL_BUDGET_BYTES;
  const n = 10;
  for (let i = 1; i < n; i++) {
    const prev = rankDocumentBudget(i - 1, n, total);
    const cur = rankDocumentBudget(i, n, total);
    assert.ok(prev >= cur, `rank ${i - 1} budget ${prev} >= rank ${i} budget ${cur}`);
  }
});

test('rankDocumentBudget stays within floor and ceiling', () => {
  const total = DEFAULT_TOTAL_BUDGET_BYTES;
  for (const n of [1, 2, 5, 10, 15, 30]) {
    for (let i = 0; i < n; i++) {
      const b = rankDocumentBudget(i, n, total);
      assert.ok(b >= DEFAULT_DOCUMENT_BUDGET_BYTES, `budget ${b} >= floor`);
      assert.ok(b <= DOCUMENT_BUDGET_CEILING_BYTES, `budget ${b} <= ceiling`);
    }
  }
});

test('rankDocumentBudget raw sum is a pre-clamp target; may exceed 90% utilization for high result counts', () => {
  const total = DEFAULT_TOTAL_BUDGET_BYTES;
  const target = Math.floor(total * 0.9);
  for (const n of [10, 20, 30]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rankDocumentBudget(i, n, total);
    // Pre-clamp sum may exceed the 90% target when many results are clamped
    // to the floor — callers apply clamp-aware normalization. The raw sum
    // must still stay within the total budget for reasonable result counts.
    // For very high counts (30+) the floor * count may exceed the total
    // budget; normalization in formatInternal handles this.
    if (n <= 20) {
      assert.ok(sum <= total, `n=${n}: sum ${sum} <= total budget ${total}`);
    }
    // For low result counts the pre-clamp sum should be within the target.
    if (n <= 10) {
      assert.ok(sum <= target, `n=${n}: sum ${sum} <= 90% target ${target}`);
    }
  }
});
