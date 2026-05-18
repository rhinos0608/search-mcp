import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepResearchLlmClient } from '../../src/research/llm/chat.js';
import { restoreFetch } from '../setup.js';

function makeClient(): DeepResearchLlmClient {
  return new DeepResearchLlmClient({
    baseUrl: 'https://llm.example.test',
    model: 'orchestrator-model',
    workerModel: 'worker-model',
  });
}

test('callJSON parses recoverable JSON from normal text without response_format', async (t) => {
  t.after(() => {
    restoreFetch();
  });

  const requests: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'Here is the JSON:\n```json\n{"findings":[]}\n```',
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const result = await makeClient().callJSON<{ findings: unknown[] }>({
    model: 'worker',
    messages: [{ role: 'user', content: 'Return JSON' }],
    responseFormat: 'json_object',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.success ? result.data : undefined, { findings: [] });
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as { response_format?: unknown }).response_format, { type: 'json_object' });
});

test('callJSON returns parse failure for non-JSON text', async (t) => {
  t.after(() => {
    restoreFetch();
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'No structured data here.' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const result = await makeClient().callJSON<{ findings: unknown[] }>({
    model: 'worker',
    messages: [{ role: 'user', content: 'Return JSON' }],
  });

  assert.equal(result.success, false);
  assert.equal(result.success ? undefined : result.parseError, 'LLM returned non-JSON content');
});

test('worker JSON calls use the worker base URL', async (t) => {
  t.after(() => {
    restoreFetch();
  });

  const endpoints: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    endpoints.push(String(input));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new DeepResearchLlmClient({
    baseUrl: 'https://orchestrator.example.test/v1',
    workerBaseUrl: 'https://worker.example.test/v1/chat/completions',
    model: 'orchestrator-model',
    workerModel: 'worker-model',
  });

  await client.callJSON<{ ok: boolean }>({
    model: 'worker',
    messages: [{ role: 'user', content: 'Return JSON' }],
  });

  assert.deepEqual(endpoints, ['https://worker.example.test/v1/chat/completions']);
});

test('callJSON parses JSON from array content parts', async (t) => {
  t.after(() => {
    restoreFetch();
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: 'text', text: '```json\n{"findings":[]}\n```' }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const result = await makeClient().callJSON<{ findings: unknown[] }>({
    model: 'worker',
    messages: [{ role: 'user', content: 'Return JSON' }],
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.success ? result.data : undefined, { findings: [] });
});
