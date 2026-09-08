import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LocalePackSchema, DomainPackSchema } from '../../src/jobs/packs/types.js';
import { AU_NSW_SYDNEY_LOCALE_PACK } from '../../src/jobs/packs/auNswSydney.locale.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../src/jobs/packs/nswPublicAdmin.domain.js';

describe('checkpoint B packs: RED first', () => {
  test('RED: Sydney/NSW locale pack parses and carries Sydney hierarchy', () => {
    const parsed = LocalePackSchema.parse(AU_NSW_SYDNEY_LOCALE_PACK);
    assert.equal(parsed.id, 'au-nsw-sydney');
    const ids = new Set(parsed.geography.map((g) => g.id));
    for (const need of ['au', 'nsw', 'sydney', 'sydney-cbd', 'parramatta']) {
      assert.ok(ids.has(need), `geography needs ${need}`);
    }
  });

  test('RED: NSW domain pack parses with 12 families and adjacency', () => {
    const parsed = DomainPackSchema.parse(NSW_PUBLIC_ADMIN_DOMAIN_PACK);
    assert.ok(parsed.roleNodes.length >= 12);
    assert.ok(parsed.edges.length >= 4);
    assert.ok(parsed.evidenceCitations.length >= 1);
  });
});
