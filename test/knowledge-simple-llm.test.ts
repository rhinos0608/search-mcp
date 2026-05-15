import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callSimpleLlm,
  SIMPLE_LLM_DEFAULT_MAX_RETRIES,
  SIMPLE_LLM_DEFAULT_TOTAL_TIMEOUT_MS,
} from '../src/knowledge/extractor/llm.js';
import type { LlmConfig } from '../src/config.js';

const originalFetch = globalThis.fetch;

const llm: LlmConfig = {
  provider: 'test-model',
  baseUrl: 'https://llm.example',
  apiToken: '',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('callSimpleLlm defaults to an 8-retry, 5-minute logical call budget', () => {
  assert.equal(SIMPLE_LLM_DEFAULT_MAX_RETRIES, 8);
  assert.equal(SIMPLE_LLM_DEFAULT_TOTAL_TIMEOUT_MS, 300_000);
});

test('callSimpleLlm retries retryable HTTP failures with exponential backoff before succeeding', async () => {
  let attempts = 0;
  const seenSignals: AbortSignal[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    if (init?.signal instanceof AbortSignal) {
      seenSignals.push(init.signal);
    }

    if (attempts < 3) {
      return new Response('temporarily unavailable', { status: 503 });
    }

    return Response.json({ choices: [{ message: { content: 'extracted content' } }] });
  }) as typeof fetch;

  const result = await callSimpleLlm(llm, 'system', 'user', {
    totalTimeoutMs: 1_000,
    maxRetries: 8,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  });

  assert.equal(result.success, true);
  assert.equal(result.content, 'extracted content');
  assert.equal(attempts, 3);
  assert.equal(seenSignals.length, 3);
});

test('callSimpleLlm does not retry non-retryable HTTP failures', async () => {
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response('bad request', { status: 400 });
  }) as typeof fetch;

  const result = await callSimpleLlm(llm, 'system', 'user', {
    totalTimeoutMs: 1_000,
    maxRetries: 8,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /HTTP 400/);
  assert.equal(attempts, 1);
});
