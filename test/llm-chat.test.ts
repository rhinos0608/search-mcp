import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callOpenAiChatCompletion,
  LLM_DEFAULT_MAX_RETRIES,
  LLM_DEFAULT_TOTAL_TIMEOUT_MS,
} from '../src/utils/llmChat.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('callOpenAiChatCompletion defaults to an 8-retry, 5-minute logical call budget', () => {
  assert.equal(LLM_DEFAULT_MAX_RETRIES, 8);
  assert.equal(LLM_DEFAULT_TOTAL_TIMEOUT_MS, 300_000);
});

test('callOpenAiChatCompletion normalizes base URLs that already include /v1', async () => {
  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  }) as typeof fetch;

  const result = await callOpenAiChatCompletion({
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    totalTimeoutMs: 1_000,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  });

  assert.equal(result.success, true);
  assert.equal(requestedUrl, 'http://localhost:11434/v1/chat/completions');
});

test('callOpenAiChatCompletion retries retryable failures before succeeding', async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) return new Response('temporarily unavailable', { status: 503 });
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  }) as typeof fetch;

  const result = await callOpenAiChatCompletion({
    baseUrl: 'https://llm.example',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    totalTimeoutMs: 1_000,
    maxRetries: 8,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  });

  assert.equal(result.success, true);
  assert.equal(result.content, 'ok');
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
});
