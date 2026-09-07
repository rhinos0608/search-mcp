import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterCapabilitySchema } from '../../src/jobs/acquisition/adapterCapability.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';

function cap(
  adapterId: string,
  version = '1.0.0',
  edges: unknown = [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
) {
  return {
    schemaVersion: '1.0.0' as const,
    adapterId,
    adapterVersion: version,
    edges,
  };
}

const allOperations = [
  'automatedSearch',
  'automatedFetch',
  'userSuppliedContent',
  'manualImport',
  'employerApi',
] as const;
const allRoutes = ['direct', 'indexed', 'user_supplied'] as const;
const allTargetKinds = [
  'discovery_provider',
  'publisher',
  'board',
  'adapter',
  'ats_tenant',
] as const;

function allValidTriples(): Array<{
  operation: (typeof allOperations)[number];
  route: (typeof allRoutes)[number];
  targetKind: (typeof allTargetKinds)[number];
}> {
  const out: Array<{
    operation: (typeof allOperations)[number];
    route: (typeof allRoutes)[number];
    targetKind: (typeof allTargetKinds)[number];
  }> = [];
  for (const op of allOperations)
    for (const route of allRoutes)
      for (const kind of allTargetKinds) out.push({ operation: op, route, targetKind: kind });
  return out;
}

test('ADAPTER_CAPABILITY_CONTRACT_VERSION is 1.0.0', async () => {
  const mod = await import('../../src/jobs/acquisition/adapterCapability.js');
  assert.equal(mod.ADAPTER_CAPABILITY_CONTRACT_VERSION, '1.0.0');
});

test('valid capability parses and frozen', () => {
  const parsed = AdapterCapabilitySchema.parse(cap('seek'));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.edges), true);
  assert.equal(Object.isFrozen(parsed.edges[0]), true);
  assert.throws(() => {
    (parsed as unknown as { adapterId: string }).adapterId = 'x';
  });
});

test('rejects whitespace-trim semantics preserved', () => {
  assert.equal(AdapterCapabilitySchema.safeParse(cap('  seek  ')).success, true);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('   ')).success, true);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('')).success, false);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('a'.repeat(257))).success, false);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('a'.repeat(256))).success, true);
});

test('strict SemVer max 64', () => {
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0-alpha+001')).success, true);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '01.0.0')).success, false);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', 'a'.repeat(65))).success, false);
});

test('edges 1-32 unique exact triples', () => {
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0', [])).success, false);
  const dup = [
    { operation: 'automatedSearch', route: 'direct', targetKind: 'board' },
    { operation: 'automatedSearch', route: 'direct', targetKind: 'board' },
  ];
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0', dup)).success, false);
  const triples = allValidTriples();
  const thirtyTwo = triples.slice(0, 32);
  const thirtyThree = triples.slice(0, 33);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0', thirtyTwo)).success, true);
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0', thirtyThree)).success, false);
  // valid distinct triples
  const two = [
    { operation: 'automatedSearch', route: 'direct', targetKind: 'board' },
    { operation: 'automatedSearch', route: 'direct', targetKind: 'publisher' },
  ];
  assert.equal(AdapterCapabilitySchema.safeParse(cap('seek', '1.0.0', two)).success, true);
});

test('AdapterEdgeCapability exact enums', () => {
  assert.equal(
    AdapterCapabilitySchema.safeParse(
      cap('seek', '1.0.0', [{ operation: 'invalid', route: 'direct', targetKind: 'board' }]),
    ).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse(
      cap('seek', '1.0.0', [
        { operation: 'automatedSearch', route: 'invalid', targetKind: 'board' },
      ]),
    ).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse(
      cap('seek', '1.0.0', [
        { operation: 'automatedSearch', route: 'direct', targetKind: 'invalid' },
      ]),
    ).success,
    false,
  );
});

test('rejects extra fields', () => {
  assert.equal(
    AdapterCapabilitySchema.safeParse({ ...cap('seek'), policy: {} } as unknown as object).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse({ ...cap('seek'), tenant: 'x' } as unknown as object).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse({ ...cap('seek'), source: 'x' } as unknown as object).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse({ ...cap('seek'), callback: () => {} } as unknown as object)
      .success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse({
      ...cap('seek'),
      supportedBoardIds: [],
    } as unknown as object).success,
    false,
  );
  assert.equal(
    AdapterCapabilitySchema.safeParse({
      ...cap('seek', '1.0.0', [
        {
          operation: 'automatedSearch',
          route: 'direct',
          targetKind: 'board',
          policy: 'x',
        } as unknown as object,
      ]),
    }).success,
    false,
  );
});

test('registry duplicate throws, unknown get undefined/supports false, sorted frozen', () => {
  const registry = new AdapterCapabilityRegistry();
  registry.register(cap('b-adapter'));
  assert.throws(() => registry.register(cap('b-adapter')), /duplicate/);
  registry.register(cap('a-adapter'));
  assert.equal(registry.get('missing'), undefined);
  assert.equal(
    registry.supports('missing', {
      operation: 'automatedSearch',
      route: 'direct',
      targetKind: 'board',
    }),
    false,
  );
  assert.equal(
    registry.supports('a-adapter', {
      operation: 'automatedSearch',
      route: 'direct',
      targetKind: 'board',
    }),
    true,
  );
  assert.equal(
    registry.supports('a-adapter', {
      operation: 'automatedFetch',
      route: 'direct',
      targetKind: 'board',
    }),
    false,
  );
  assert.equal(
    registry.supports('a-adapter', {
      operation: 'automatedSearch',
      route: 'indexed',
      targetKind: 'board',
    }),
    false,
  );
  assert.equal(
    registry.supports('a-adapter', {
      operation: 'automatedSearch',
      route: 'direct',
      targetKind: 'publisher',
    }),
    false,
  );

  const list = registry.list();
  assert.deepEqual(
    list.map((c) => c.adapterId),
    ['a-adapter', 'b-adapter'],
  );
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list[0] as unknown as object), true);
  assert.throws(() => (list as unknown as string[]).push('x'));

  const supporting = registry.listSupporting({
    operation: 'automatedSearch',
    route: 'direct',
    targetKind: 'board',
  });
  assert.equal(Object.isFrozen(supporting), true);
  assert.deepEqual(
    supporting.map((c) => c.adapterId),
    ['a-adapter', 'b-adapter'],
  );

  const fetched = registry.get('a-adapter');
  assert.ok(fetched);
  assert.equal(Object.isFrozen(fetched!), true);
  assert.equal(Object.isFrozen(fetched!.edges), true);
  assert.throws(() => (fetched!.edges as unknown as string[]).push('x' as unknown as never));
  assert.throws(() => {
    (fetched!.edges[0] as unknown as { operation: string }).operation = 'manualImport';
  });
  assert.throws(() => {
    (fetched!.edges[0] as unknown as { route: string }).route = 'indexed';
  });
});

test('registry constructor initial and deterministic code-point ordering', () => {
  const registry = new AdapterCapabilityRegistry([cap('Z'), cap('a'), cap('A')]);
  assert.deepEqual(
    registry.list().map((c) => c.adapterId),
    ['A', 'Z', 'a'],
  );
});

test('code-point comparator: U+E000 sorts before U+10000 regardless of registration order', () => {
  const bmp = '\uE000';
  const astral = '\u{10000}';
  // UTF-16 less-than would put astral (D800) before BMP (E000); code-point order is opposite
  assert.ok('\u{10000}' < '\uE000', 'sanity: UTF-16 ordering is inverted');
  const r1 = new AdapterCapabilityRegistry([cap(astral), cap(bmp)]);
  assert.deepEqual(
    r1.list().map((c) => c.adapterId),
    [bmp, astral],
  );
  const r2 = new AdapterCapabilityRegistry([cap(bmp), cap(astral)]);
  assert.deepEqual(
    r2.list().map((c) => c.adapterId),
    [bmp, astral],
  );
  const r3 = new AdapterCapabilityRegistry();
  r3.register(cap(astral));
  r3.register(cap(bmp));
  assert.deepEqual(
    r3
      .listSupporting({ operation: 'automatedSearch', route: 'direct', targetKind: 'board' })
      .map((c) => c.adapterId),
    [bmp, astral],
  );
});

test('supports and listSupporting parse edge at runtime', () => {
  const registry = new AdapterCapabilityRegistry([cap('seek')]);
  assert.throws(() =>
    registry.supports('seek', {
      operation: 'invalid',
      route: 'direct',
      targetKind: 'board',
    } as unknown as never),
  );
  assert.throws(() =>
    registry.listSupporting({
      operation: 'invalid',
      route: 'direct',
      targetKind: 'board',
    } as unknown as never),
  );
  assert.throws(() =>
    registry.supports('seek', {
      operation: 'automatedSearch',
      route: 'direct',
    } as unknown as never),
  );
});

test('no displayName/notes/permission/policy/network/config/callback/snapshot leaks', () => {
  const parsed = AdapterCapabilitySchema.parse(cap('seek'));
  assert.equal((parsed as unknown as Record<string, unknown>).displayName, undefined);
  assert.equal((parsed as unknown as Record<string, unknown>).notes, undefined);
  assert.equal((parsed as unknown as Record<string, unknown>).permission, undefined);
});
