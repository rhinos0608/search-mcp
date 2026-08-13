import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCisaFacts } from '../../src/domainFacts/cisa.js';

const fixture = readFileSync(join(process.cwd(), 'test/domainFacts/fixtures/cisa.csv'), 'utf8');

test('parses CISA facts and normalizes domains', () => {
  const facts = parseCisaFacts(fixture);
  const domains = facts.map((f) => f.domain);
  assert.ok(domains.includes('access-board.gov'));
  assert.ok(domains.includes('nist.gov'));
  assert.ok(domains.includes('whitehouse.gov'));
  assert.ok(domains.includes('anl.gov'));
});

test('preserves quoted suborganization and org names with commas', () => {
  const nist = parseCisaFacts(fixture).find((f) => f.domain === 'nist.gov');
  assert.equal(nist?.org, 'Department of Commerce, Technology Administration');
  assert.equal(nist?.suborg, 'National Institute of Standards and Technology');
  assert.equal(nist?.type, 'Federal - Executive');
});

test('drops invalid / IP / wildcard / PSL-like rows', () => {
  const domains = parseCisaFacts(fixture).map((f) => f.domain);
  assert.ok(!domains.includes('192.168.0.1'));
  assert.ok(!domains.includes('*.bad.gov'));
  assert.ok(!domains.includes('co.uk'));
});

test('keeps all government domain types, not just federal', () => {
  const facts = parseCisaFacts(fixture);
  const byDomain = new Map(facts.map((f) => [f.domain, f]));
  assert.equal(byDomain.get('springfield.gov')?.type, 'City');
  assert.equal(byDomain.get('cookcounty.gov')?.type, 'County');
  assert.equal(byDomain.get('navajo-nsn.gov')?.type, 'Tribal');
});

test('throws when a required header column is missing (no positional fallback)', () => {
  const csv = 'Domain name,Domain type,Organization name\nfoo.gov,Federal,Foo Org\n';
  assert.throws(() => parseCisaFacts(csv), /header missing required column/);
});

test('resolves columns by header name even when reordered', () => {
  const csv =
    'Suborganization name,Organization name,Domain type,Domain name\n' +
    'Sub,Org,Federal,reordered.gov\n';
  const facts = parseCisaFacts(csv);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.domain, 'reordered.gov');
  assert.equal(facts[0]?.org, 'Org');
  assert.equal(facts[0]?.suborg, 'Sub');
  assert.equal(facts[0]?.type, 'Federal');
});
