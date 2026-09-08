import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// RED: enrichment inline pack schemas must BE the canonical schemas.
describe('pack consolidation: RED first', () => {
  test('RED: enrichment LocalePackSchema is canonical packs LocalePackSchema', async () => {
    const contracts = await import('../../src/jobs/enrichment/contracts.js');
    const canonical = await import('../../src/jobs/packs/types.js');
    assert.equal(contracts.LocalePackSchema, canonical.LocalePackSchema as never);
    assert.equal(contracts.DomainPackSchema, canonical.DomainPackSchema as never);
  });
});
