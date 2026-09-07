import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainPackRegistry,
  LocalePackRegistry,
  PackRegistry,
  expandDomainTerms,
} from '../../src/jobs/packs/index.js';

const attribution = { author: 'test', license: 'CC-BY-4.0' };
const locale = (version: string) => ({
  kind: 'locale' as const,
  id: 'generic',
  version,
  effectiveFrom: '2026-01-01',
  attribution,
  geography: [],
  salaryConventions: [],
  classificationSchemes: [],
  eligibilityTerminology: {},
  normalizationRules: [],
});
const domain = (aliases: string[] = []) => ({
  kind: 'domain' as const,
  id: 'admin',
  version: '1.0.0',
  effectiveFrom: '2026-01-01',
  attribution,
  roleNodes: [{ id: 'registry', label: 'Registry Officer', aliases, capabilities: ['records'] }],
  edges: [],
  capabilityVocabulary: ['records'],
  requirementTerminology: {},
  expansionGuards: [],
  evidenceCitations: ['fixture:domain'],
});

test('invalid locale and domain packs are rejected', () => {
  assert.throws(() =>
    new LocalePackRegistry().register({ ...locale('1.0.0'), effectiveFrom: 'not-a-date' }),
  );
  assert.throws(() =>
    new DomainPackRegistry().register({
      ...domain(),
      edges: [
        {
          from: 'missing',
          to: 'registry',
          type: 'adjacent',
          evidence: ['fixture:edge'],
          rule: { ruleId: 'r', version: '1', deterministic: true, description: 'test' },
        },
      ],
    }),
  );
});

test('registry rejects exact duplicates but resolves highest active version deterministically', () => {
  const registry = new PackRegistry();
  registry.register(locale('1.0.0'));
  registry.register({ ...locale('10.0.0'), effectiveFrom: '2027-01-01' });
  assert.throws(() => registry.register(locale('1.0.0')), /duplicate pack/);
  assert.equal(registry.resolve('locale', 'generic', '2027-06-01')?.version, '10.0.0');
});

test('generic registry has no AU defaults', () => {
  assert.deepEqual(new PackRegistry().list(), []);
});

test('pack snapshots are immutable and resolution validates semver/date', () => {
  const input = locale('1.0.0');
  const registry = new PackRegistry([input]);
  input.attribution.author = 'changed';
  assert.equal(registry.get('locale', 'generic', '1.0.0')?.attribution.author, 'test');
  assert.throws(() => registry.resolve('locale', 'generic', 'not-a-date'));
  assert.throws(() => registry.register({ ...locale('1'), id: 'bad' }));
  assert.throws(() => registry.register({ ...locale('1.0.1'), extra: true }));
  assert.throws(
    () =>
      new LocalePackRegistry().register({
        ...locale('2.0.0'),
        geography: [
          { id: 'x', name: 'X', kind: 'city', aliases: [] },
          { id: 'x', name: 'Y', kind: 'city', aliases: [] },
        ],
      }),
    /duplicate geography/,
  );
});

test('duplicate role IDs and embedded generic tokens are rejected without guards', () => {
  assert.throws(
    () =>
      new DomainPackRegistry().register({
        ...domain(),
        roleNodes: [
          { id: 'same', label: 'Safe', aliases: [], capabilities: [] },
          { id: 'same', label: 'Other', aliases: [], capabilities: [] },
        ],
      }),
    /duplicate role node/,
  );
  assert.throws(
    () =>
      new DomainPackRegistry().register({
        ...domain(['Administrative Assistant']),
      }),
    /generic token requires expansion guard/,
  );
});

test('generic-token expansion requires contextual guard', () => {
  const unguarded = domain(['officer']);
  assert.throws(() => new DomainPackRegistry().register(unguarded), /expansion guard/);

  const guarded = {
    ...unguarded,
    expansionGuards: [{ token: 'officer', requiresContext: ['registry'] }],
  };
  const pack = new DomainPackRegistry().register(guarded);
  assert.deepEqual(expandDomainTerms(pack, ['officer']), ['officer']);
  assert.deepEqual(expandDomainTerms(pack, ['officer'], ['registry']), [
    'officer',
    'Registry Officer',
  ]);
});

test('equivalent title targets honor their own generic-token guards', () => {
  const pack = new DomainPackRegistry().register({
    ...domain(),
    roleNodes: [
      { id: 'registry', label: 'Registry Officer', aliases: [], capabilities: [] },
      { id: 'admin', label: 'Administrative Assistant', aliases: [], capabilities: [] },
    ],
    edges: [
      {
        from: 'registry',
        to: 'admin',
        type: 'equivalent_title',
        evidence: ['fixture:edge'],
        rule: { ruleId: 'r', version: '1.0.0', deterministic: true, description: 'test' },
      },
    ],
    expansionGuards: [
      { token: 'officer', requiresContext: ['registry'] },
      { token: 'assistant', requiresContext: ['clerical'] },
    ],
  });

  assert.deepEqual(expandDomainTerms(pack, ['Registry Officer'], ['registry']), [
    'Registry Officer',
  ]);
  assert.deepEqual(expandDomainTerms(pack, ['Registry Officer'], ['registry', 'clerical']), [
    'Administrative Assistant',
    'Registry Officer',
  ]);
});
