import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRorFacts } from '../../src/domainFacts/ror.js';

const fixture = readFileSync(join(process.cwd(), 'test/domainFacts/fixtures/ror.json'), 'utf8');

test('emits only active records', () => {
  const { facts } = parseRorFacts(fixture);
  const domains = facts.map((f) => f.domain);
  assert.ok(!domains.includes('olduniv.edu'), 'inactive record dropped');
  assert.ok(!domains.includes('gone.edu'), 'withdrawn record dropped');
});

test('normalizes domains and punycodes IDNs', () => {
  const { facts } = parseRorFacts(fixture);
  const domains = facts.map((f) => f.domain);
  assert.ok(domains.includes('exampleedu.edu'), 'lowercased');
  assert.ok(domains.includes('exampleuni.org'), 'www stripped');
  assert.ok(domains.includes('xn--tst-qla.de'), 'IDN punycoded');
});

test('drops invalid / PSL-like domains but keeps valid siblings', () => {
  const { facts } = parseRorFacts(fixture);
  const edu2 = facts.filter((f) => f.rorId === 'https://ror.org/edu2');
  const domains = edu2.map((f) => f.domain);
  assert.ok(domains.includes('another.edu'));
  assert.ok(!domains.includes('bad..domain'));
  assert.ok(!domains.includes('co.uk'));
});

test('gates institutional domains to education-relevant types', () => {
  const { facts, institutionalDomains } = parseRorFacts(fixture);
  const inst = new Set(institutionalDomains);
  // education organizations promote
  assert.ok(inst.has('exampleedu.edu'));
  assert.ok(inst.has('another.edu'));
  // non-qualifying organizations remain facts but do not promote
  assert.ok(
    facts.some((f) => f.domain === 'eosc.org'),
    'nonprofit is a fact',
  );
  assert.ok(!inst.has('eosc.org'), 'nonprofit not promoted');
  assert.ok(
    facts.some((f) => f.domain === 'corp.example.com'),
    'company is a fact',
  );
  assert.ok(!inst.has('corp.example.com'), 'company not promoted');
});

test('picks the ror_display name over other name types', () => {
  const { facts } = parseRorFacts(fixture);
  const uni = facts.find((f) => f.domain === 'exampleedu.edu');
  assert.equal(uni?.name, 'Example University');
  assert.equal(uni?.rorId, 'https://ror.org/activeedu');
});

test('falls back to a label name when no ror_display name is present', () => {
  const { facts } = parseRorFacts(fixture);
  const labeled = facts.find((f) => f.domain === 'labeled.edu');
  assert.equal(labeled?.name, 'Labeled University');
});

test('throws on structurally invalid active records', () => {
  const noId = JSON.stringify([
    {
      status: 'active',
      domains: ['x.edu'],
      types: ['education'],
      names: [{ value: 'X', types: ['ror_display'], lang: 'en' }],
    },
  ]);
  assert.throws(() => parseRorFacts(noId), /missing id/);

  const noTypes = JSON.stringify([
    {
      id: 'https://ror.org/z',
      status: 'active',
      domains: ['x.edu'],
      types: [],
      names: [{ value: 'X', types: ['ror_display'], lang: 'en' }],
    },
  ]);
  assert.throws(() => parseRorFacts(noTypes), /no types/);

  const noName = JSON.stringify([
    {
      id: 'https://ror.org/z',
      status: 'active',
      domains: ['x.edu'],
      types: ['education'],
      names: [],
    },
  ]);
  assert.throws(() => parseRorFacts(noName), /no resolvable name/);

  const noDomains = JSON.stringify([
    {
      id: 'https://ror.org/z',
      status: 'active',
      types: ['education'],
      names: [{ value: 'X', types: ['ror_display'], lang: 'en' }],
    },
  ]);
  assert.throws(() => parseRorFacts(noDomains), /missing domains array/);
});

test('does not throw on an active record with an empty domains array', () => {
  const empty = JSON.stringify([
    {
      id: 'https://ror.org/z',
      status: 'active',
      domains: [],
      types: ['education'],
      names: [{ value: 'X', types: ['ror_display'], lang: 'en' }],
    },
  ]);
  assert.doesNotThrow(() => parseRorFacts(empty));
});
