import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimClusterSchema } from '../../src/research/llm/schemas.js';

test('ClaimClusterSchema accepts null contradiction and rejects omission', () => {
  const valid = ClaimClusterSchema.safeParse({
    representativeClaim: 'Model performs well',
    claimIds: ['c1'],
    confidence: 'high',
    sourceCount: 2,
    consensus: 'mixed',
    contradiction: null,
  });

  assert.equal(valid.success, true);

  const invalid = ClaimClusterSchema.safeParse({
    representativeClaim: 'Model performs well',
    claimIds: ['c1'],
    confidence: 'high',
    sourceCount: 2,
    consensus: 'mixed',
  });

  assert.equal(invalid.success, false);
});
