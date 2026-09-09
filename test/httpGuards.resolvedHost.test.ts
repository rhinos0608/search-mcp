import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeResolvedHost } from '../src/httpGuards.js';

type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('assertSafeResolvedHost accepts public answers', async () => {
  await assertSafeResolvedHost('example.com', publicResolver);
});

test('assertSafeResolvedHost rejects hanging resolver on timeoutMs deadline', async () => {
  const hanging: Resolver = () => new Promise(() => {});
  await assert.rejects(
    () => assertSafeResolvedHost('example.com', hanging, { timeoutMs: 20 }),
    /timed out for host "example.com"/,
  );
});

test('assertSafeResolvedHost rejects immediately when signal already aborted', async () => {
  let calls = 0;
  const counting: Resolver = () => {
    calls++;
    return publicResolver('example.com');
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => assertSafeResolvedHost('example.com', counting, { signal: controller.signal }),
    /aborted for host "example.com"/,
  );
  assert.equal(calls, 0, 'resolver must not be invoked after cancellation');
});

test('assertSafeResolvedHost rejects when signal aborts while resolver pending', async () => {
  const controller = new AbortController();
  const pending: Resolver = () => new Promise(() => {});
  const attempt = assertSafeResolvedHost('example.com', pending, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => attempt, /aborted for host "example.com"/);
});
