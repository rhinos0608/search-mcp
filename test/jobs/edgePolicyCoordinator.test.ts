import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AcquisitionPolicyEdgeSchema,
  type AcquisitionPolicyEdge,
} from '../../src/jobs/acquisition/contracts.js';
import {
  SourcePolicyRegistry,
  PolicyEdgeRequestSchema,
  resolveExecutionPolicyEdge,
  resolveInformationalPolicyEdge,
  executeIfPolicyPermitted,
  caveatsForInformationalEdges,
  type PolicyEdgeRequest,
} from '../../src/jobs/acquisition/policy/index.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';

const decidedAt = '2026-01-02T00:00:00Z';
const opts = { decidedAt };

function registryWith(policies: SourcePolicy[]): SourcePolicyRegistry {
  return new SourcePolicyRegistry(policies);
}
function baseRequest(overrides: Partial<PolicyEdgeRequest> = {}): PolicyEdgeRequest {
  return {
    edgeId: 'edge-1',
    actor: { kind: 'provider', namespace: 'provider', id: 'exa' },
    operation: 'automatedSearch',
    route: 'indexed',
    target: { kind: 'discovery_provider', sourceId: 'exa' },
    ...overrides,
  } as PolicyEdgeRequest;
}
function policy(overrides: Partial<SourcePolicy> = {}): SourcePolicy {
  const baseModes: SourcePolicy['modes'] = {
    automatedSearch: 'permitted',
    automatedFetch: 'blocked',
    userSuppliedContent: 'permitted',
    manualImport: 'requires_configuration',
    employerApi: 'not_supported',
  };
  return {
    sourceId: overrides.sourceId ?? 'exa',
    revision: overrides.revision ?? 'rev-1',
    modes: { ...baseModes, ...(overrides.modes as Partial<SourcePolicy['modes']>) },
    evidenceRefs: overrides.evidenceRefs ?? ['ev-1'],
    reviewedAt: overrides.reviewedAt ?? '2026-01-01T00:00:00Z',
    ...(overrides.notes !== undefined ? { notes: overrides.notes } : { notes: 'note' }),
  };
}

test('PolicyEdgeRequestSchema validates', () => {
  assert.doesNotThrow(() => PolicyEdgeRequestSchema.parse(baseRequest()));
});

test('resolveExecutionPolicyEdge separates execution effect', () => {
  const reg = registryWith([policy()]);
  const edge = resolveExecutionPolicyEdge(reg, baseRequest(), opts);
  assert.equal(edge.effect, 'authorized_operation');
  assert.equal(edge.state, 'permitted');
  assert.equal(edge.revision, 'rev-1');
  assert.equal(edge.reviewedAt, '2026-01-01T00:00:00Z');
  AcquisitionPolicyEdgeSchema.parse(edge);
  assert.ok(Object.isFrozen(edge));
  assert.ok(Object.isFrozen(edge.evidenceRefs));
});

test('resolveInformationalPolicyEdge separates informational effect', () => {
  const reg = registryWith([policy()]);
  const req = baseRequest({
    target: { kind: 'publisher', sourceId: 'acme', normalizedHost: 'acme.test' },
    operation: 'automatedFetch',
    route: 'direct',
    actor: { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
  });
  const edge = resolveInformationalPolicyEdge(reg, req, opts);
  assert.equal(edge.effect, 'informational_capability');
  assert.ok(Object.isFrozen(edge));
});

test('lookup uses target.sourceId + operation', () => {
  const reg = registryWith([
    policy({
      sourceId: 'acme',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'blocked',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
    }),
  ]);
  const req = baseRequest({
    target: { kind: 'publisher', sourceId: 'acme' },
    operation: 'automatedFetch',
    route: 'direct',
  });
  const edge = resolveExecutionPolicyEdge(reg, req, opts);
  assert.equal(edge.state, 'blocked');
  assert.equal(edge.target.sourceId, 'acme');
});

test('exact sentinel substitutes decidedAt and fixed note', () => {
  const reg = registryWith([]);
  const req = baseRequest({
    target: { kind: 'publisher', sourceId: 'missing' },
    operation: 'automatedSearch',
    route: 'direct',
  });
  const edge = resolveExecutionPolicyEdge(reg, req, opts);
  assert.equal(edge.state, 'not_supported');
  assert.equal(edge.revision, 'none');
  assert.equal(edge.reviewedAt, decidedAt);
  assert.deepEqual(edge.evidenceRefs, []);
  assert.equal(edge.notes, 'policy missing; fail closed');
  AcquisitionPolicyEdgeSchema.parse(edge);
});

test('reject malformed decidedAt', () => {
  const reg = registryWith([]);
  const req = baseRequest({ target: { kind: 'publisher', sourceId: 'missing' } });
  assert.throws(() => resolveExecutionPolicyEdge(reg, req, { decidedAt: 'not-a-date' } as never));
  assert.throws(() => resolveExecutionPolicyEdge(reg, req, { decidedAt: 'unknown' } as never));
});

test('near-sentinel not substituted and fails validation', () => {
  // Create registry with near-sentinel reviewedAt that is not exact 'unknown' but invalid, should reject via validation
  const nearPolicy: SourcePolicy = {
    sourceId: 'near',
    revision: 'none',
    modes: {
      automatedSearch: 'not_supported',
      automatedFetch: 'not_supported',
      userSuppliedContent: 'not_supported',
      manualImport: 'not_supported',
      employerApi: 'not_supported',
    },
    evidenceRefs: [],
    reviewedAt: 'Unknown',
  };
  const reg = registryWith([nearPolicy]);
  const req = baseRequest({ target: { kind: 'publisher', sourceId: 'near' } });
  assert.throws(() => resolveExecutionPolicyEdge(reg, req, opts));
});

test('executeIfPolicyPermitted runs once only for permitted authorized_operation', async () => {
  const reg = registryWith([policy()]);
  const permitted = resolveExecutionPolicyEdge(reg, baseRequest(), opts);
  let calls = 0;
  const res = await executeIfPolicyPermitted(permitted, async () => {
    calls += 1;
    return 42;
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 'executed');
  if (res.status === 'executed') {
    assert.equal(res.value, 42);
    assert.equal(res.edge.edgeId, permitted.edgeId);
  }
  assert.ok(Object.isFrozen(res));
});

test('executeIfPolicyPermitted zero calls for blocked', async () => {
  const reg = registryWith([policy()]);
  const req = baseRequest({
    operation: 'automatedFetch',
    target: { kind: 'publisher', sourceId: 'exa' },
    route: 'direct',
  });
  const blocked = resolveExecutionPolicyEdge(reg, req, opts);
  assert.equal(blocked.state, 'blocked');
  let calls = 0;
  const res = await executeIfPolicyPermitted(blocked, async () => {
    calls += 1;
    return 1;
  });
  assert.equal(calls, 0);
  assert.equal(res.status, 'not_executed');
  if (res.status === 'not_executed') {
    assert.equal(res.reason, 'policy_not_permitted');
  }
});

test('executeIfPolicyPermitted zero calls for informational effect even if permitted', async () => {
  const reg = registryWith([policy()]);
  const info = resolveInformationalPolicyEdge(reg, baseRequest(), opts);
  assert.equal(info.state, 'permitted');
  assert.equal(info.effect, 'informational_capability');
  let calls = 0;
  const res = await executeIfPolicyPermitted(info, async () => {
    calls += 1;
    return 1;
  });
  assert.equal(calls, 0);
  assert.equal(res.status, 'not_executed');
  if (res.status === 'not_executed') {
    assert.equal(res.reason, 'informational_only');
  }
});

test('executeIfPolicyPermitted propagates rejection', async () => {
  const reg = registryWith([policy()]);
  const edge = resolveExecutionPolicyEdge(reg, baseRequest(), opts);
  await assert.rejects(
    () =>
      executeIfPolicyPermitted(edge, async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
});

test('executeIfPolicyPermitted table-driven zero-call for non-permitted states', async () => {
  const cases: Array<{
    state: 'requires_configuration' | 'requires_review' | 'not_supported';
    mode: 'manualImport' | 'employerApi' | 'automatedSearch';
  }> = [
    { state: 'requires_configuration', mode: 'manualImport' },
    { state: 'requires_review', mode: 'employerApi' },
    { state: 'not_supported', mode: 'automatedSearch' },
  ];
  for (const c of cases) {
    const modes: SourcePolicy['modes'] = {
      automatedSearch: 'permitted',
      automatedFetch: 'permitted',
      userSuppliedContent: 'permitted',
      manualImport: 'permitted',
      employerApi: 'permitted',
    };
    // override target mode to desired blocked state
    (modes as Record<string, string>)[c.mode] = c.state;
    const reg = registryWith([
      policy({
        sourceId: 'exa',
        modes,
      }),
    ]);
    const edge = resolveExecutionPolicyEdge(
      reg,
      baseRequest({
        operation: c.mode as PolicyEdgeRequest['operation'],
        target: { kind: 'publisher', sourceId: 'exa' },
        route: 'direct',
      }),
      opts,
    );
    assert.equal(edge.state, c.state);
    let calls = 0;
    const res = await executeIfPolicyPermitted(edge, async () => {
      calls += 1;
      return 1;
    });
    assert.equal(calls, 0, `callback should not run for ${c.state}`);
    assert.equal(res.status, 'not_executed');
    if (res.status === 'not_executed') assert.equal(res.reason, 'policy_not_permitted');
    assert.ok(Object.isFrozen(res));
  }
});

test('executeIfPolicyPermitted zero calls for malformed edge', async () => {
  const malformed = {
    edgeId: 'edge-1',
    schemaVersion: '1.0.0',
    actor: { kind: 'provider', namespace: 'provider', id: 'exa' },
    operation: 'automatedSearch',
    route: 'indexed',
    target: { kind: 'discovery_provider', sourceId: 'exa' },
    state: 'permitted',
    effect: 'authorized_operation',
    revision: 'rev-1',
    evidenceRefs: ['ev-1'],
    // reviewedAt missing -> schema validation fails
  } as unknown as AcquisitionPolicyEdge;
  let calls = 0;
  await assert.rejects(() =>
    executeIfPolicyPermitted(malformed, async () => {
      calls += 1;
      return 1;
    }),
  );
  assert.equal(calls, 0);
});

test('caveatsForInformationalEdges only informational direct publisher/board/ats_tenant, unique fixed order', () => {
  const mk = (over: Partial<AcquisitionPolicyEdge>): AcquisitionPolicyEdge =>
    AcquisitionPolicyEdgeSchema.parse({
      edgeId: `e-${Math.random().toString(36).slice(2, 8)}`,
      schemaVersion: '1.0.0',
      actor: { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
      operation: 'automatedSearch',
      route: 'direct',
      target: { kind: 'publisher', sourceId: 'acme' },
      state: 'blocked',
      effect: 'informational_capability',
      revision: 'r1',
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
      ...over,
    });
  const edges = [
    mk({
      state: 'blocked',
      operation: 'automatedFetch',
      target: { kind: 'board', sourceId: 'seek' },
    }),
    mk({
      state: 'blocked',
      operation: 'automatedSearch',
      target: { kind: 'publisher', sourceId: 'acme' },
    }),
    mk({ state: 'requires_review', target: { kind: 'ats_tenant', sourceId: 'greenhouse' } }),
    // duplicates should be unique
    mk({
      state: 'blocked',
      operation: 'automatedSearch',
      target: { kind: 'publisher', sourceId: 'dup' },
    }),
    // excluded: provider indexed
    mk({
      state: 'blocked',
      operation: 'automatedSearch',
      target: { kind: 'discovery_provider', sourceId: 'exa' },
    }),
    // excluded: authorized_operation
    mk({
      state: 'blocked',
      operation: 'automatedSearch',
      effect: 'authorized_operation',
      target: { kind: 'publisher', sourceId: 'acme' },
    }),
    // excluded: route not direct
    mk({
      state: 'blocked',
      operation: 'automatedSearch',
      route: 'indexed',
      target: { kind: 'publisher', sourceId: 'acme' },
    }),
  ];
  const caveats = caveatsForInformationalEdges(
    edges as unknown as readonly AcquisitionPolicyEdge[],
  );
  // Expected order by CAVEAT_ORDER: direct_search_blocked (index 2), destination_fetch_blocked (3), publisher_policy_unknown (5)
  assert.deepEqual(caveats, [
    'direct_search_blocked',
    'destination_fetch_blocked',
    'publisher_policy_unknown',
  ]);
  assert.ok(Object.isFrozen(caveats));
});

test('provider indexed candidate independence preserved', () => {
  const reg = registryWith([
    policy({
      sourceId: 'exa',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'blocked',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
    }),
  ]);
  const providerEdge = resolveExecutionPolicyEdge(reg, baseRequest(), opts);
  assert.equal(providerEdge.state, 'permitted');
  // Informational publisher blocked should not affect provider
  const pubReq = baseRequest({
    target: { kind: 'publisher', sourceId: 'blocked-pub' },
    operation: 'automatedSearch',
    route: 'direct',
  });
  const pubEdge = resolveInformationalPolicyEdge(registryWith([]), pubReq, opts);
  assert.equal(pubEdge.state, 'not_supported');
  const caveats = caveatsForInformationalEdges([providerEdge, pubEdge]);
  // provider edge is authorized_operation so not included
  assert.deepEqual(caveats, ['publisher_policy_unknown']);
});
