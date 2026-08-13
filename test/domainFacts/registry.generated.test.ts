import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CISA_ROWS,
  ROR_ROWS,
  PROVENANCE,
  REGISTRY_VERSION,
  INSTITUTIONAL_DOMAINS,
} from '../../src/domainFacts/registry.generated.js';
import { registryFromRows, renderRegistry, validateRegistry } from '../../src/domainFacts/build.js';

function readCommitted(name: string): string {
  return readFileSync(join(process.cwd(), 'src/domainFacts', name), 'utf8');
}

test('committed registry is non-empty and contains real source-derived entries', () => {
  assert.ok(CISA_ROWS.length > 1000, 'CISA federal list populated');
  assert.ok(ROR_ROWS.length > 10000, 'ROR facts populated');
  assert.ok(INSTITUTIONAL_DOMAINS.length > 5000, 'institutional set populated');

  // Real CISA federal domain.
  assert.ok(
    CISA_ROWS.some((r) => r[0] === 'whitehouse.gov' && r[1] === 'Federal - Executive'),
    'whitehouse.gov present as CISA ownership fact',
  );
  // CISA ∩ ROR overlap keeps both facts.
  assert.ok(
    CISA_ROWS.some((r) => r[0] === 'anl.gov'),
    'anl.gov CISA fact',
  );
  assert.ok(
    ROR_ROWS.some((r) => r[0] === 'anl.gov'),
    'anl.gov ROR fact',
  );
  // Education org promoted; nonprofit org is a fact but not promoted.
  assert.ok(INSTITUTIONAL_DOMAINS.includes('mit.edu'), 'mit.edu (education) promoted');
  assert.ok(
    ROR_ROWS.some((r) => r[0] === 'eosc.eu'),
    'eosc.eu (nonprofit) is a fact',
  );
  assert.ok(!INSTITUTIONAL_DOMAINS.includes('eosc.eu'), 'eosc.eu not promoted');
});

test('committed snapshot passes all structural invariants', () => {
  const reg = registryFromRows({
    registryVersion: REGISTRY_VERSION,
    provenance: PROVENANCE,
    cisaRows: CISA_ROWS,
    rorRows: ROR_ROWS,
    institutionalDomains: INSTITUTIONAL_DOMAINS,
  });
  assert.doesNotThrow(() => validateRegistry(reg));
});

test('committed file is byte-identical to deterministic render (no hand-edits)', () => {
  const reg = registryFromRows({
    registryVersion: REGISTRY_VERSION,
    provenance: PROVENANCE,
    cisaRows: CISA_ROWS,
    rorRows: ROR_ROWS,
    institutionalDomains: INSTITUTIONAL_DOMAINS,
  });
  const rendered = renderRegistry(reg);
  assert.equal(rendered, readCommitted('registry.generated.ts'));
});

test('provenance pins both sources with licenses and SHA-256', () => {
  const ids = PROVENANCE.sources.map((s) => s.id);
  assert.ok(ids.includes('cisa-full'));
  assert.ok(ids.includes('ror'));
  for (const s of PROVENANCE.sources) {
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.ok(s.url.startsWith('https://'), `https only: ${s.id}`);
    assert.ok(s.license.length > 0);
    assert.ok(s.version.length > 0);
  }
  assert.equal(PROVENANCE.generatedBy, 'scripts/generate-domain-facts.ts');
});
