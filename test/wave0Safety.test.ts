import assert from 'node:assert/strict';
import test from 'node:test';
import { jobTelemetry } from '../src/jobs/acquisition/telemetry.js';
import { SourcePolicyRegistry, runIfPermitted } from '../src/jobs/acquisition/policy/index.js';
import { assertSafeUrl, safeFetch } from '../src/httpGuards.js';

test('job telemetry never emits raw query or location', () => {
  const fields = jobTelemetry({ query: 'Jane Doe resume', location: 'Sydney NSW' });
  assert.equal('query' in fields, false);
  assert.equal('location' in fields, false);
  assert.equal(fields.queryLength, 'Jane Doe resume'.length);
});

test('blocked source policy decision is non-permitted', async () => {
  const registry = new SourcePolicyRegistry([
    {
      sourceId: 'seek',
      revision: '1',
      evidenceRefs: [],
      reviewedAt: '2026-01-01',
      modes: {
        automatedSearch: 'blocked',
        automatedFetch: 'blocked',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
    },
  ]);
  const decision = registry.decide('seek', 'automatedSearch');
  assert.equal(decision.state, 'blocked');
  let calls = 0;
  await runIfPermitted(decision, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);
});

test('encoded loopback address is blocked', () => {
  assert.throws(() => assertSafeUrl('http://2130706433/'), /private IP/);
});

test('safe fetch rejects mixed DNS answers before transport', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          resolver: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
          request: async () => {
            calls += 1;
            throw new Error('must not call');
          },
        },
      ),
    /mixed or private DNS/,
  );
  assert.equal(calls, 0);
});

test('safe fetch pins resolved address while preserving hostname', async () => {
  let options: import('node:http').RequestOptions | undefined;
  const result = await safeFetch(
    'https://example.com/path',
    { headers: { Authorization: 'secret', Accept: 'text/plain' } },
    {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (requestOptions) => {
        options = requestOptions;
        return { statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array() };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(options?.hostname, 'example.com');
  assert.equal(
    (options as (import('node:http').RequestOptions & { servername?: string }) | undefined)
      ?.servername,
    'example.com',
  );
  assert.equal(typeof options?.lookup, 'function');
  assert.deepEqual((options?.headers as Record<string, string>)?.authorization, 'secret');
});
