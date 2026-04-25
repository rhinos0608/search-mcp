import test from 'node:test';
import assert from 'node:assert/strict';
import { embedTexts, embedTextsBatched } from '../src/rag/embedding.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(typeof input === 'string');
    assert.ok(init);
    calls.push({ url: input, init });
    return handler(input, init);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test('embedTexts posts document-mode request to trusted sidecar URL', async () => {
  const stub = installFetchStub((url, init) => {
    assert.equal(url, 'http://127.0.0.1:8080/embed');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer token-1');
    assert.deepEqual(JSON.parse(String(init.body)), {
      texts: ['alpha'],
      titles: ['A'],
      mode: 'document',
      dimensions: 3,
    });
    return Response.json({
      embeddings: [[1, 0, 0]],
      model: 'test-model',
      modelRevision: 'rev-a',
      dimensions: 3,
      mode: 'document',
      truncatedIndices: [],
    });
  });

  try {
    const response = await embedTexts({
      baseUrl: 'http://127.0.0.1:8080/',
      apiToken: 'token-1',
      texts: ['alpha'],
      titles: ['A'],
      mode: 'document',
      dimensions: 3,
    });

    assert.deepEqual(response.embeddings, [[1, 0, 0]]);
    assert.equal(response.model, 'test-model');
    assert.equal(response.modelRevision, 'rev-a');
  } finally {
    stub.restore();
  }
});

test('embedTextsBatched splits requests at 512 and preserves query mode metadata', async () => {
  const texts = Array.from({ length: 513 }, (_, index) => `text-${index}`);
  const stub = installFetchStub((_url, init) => {
    const body = JSON.parse(String(init.body)) as { texts: string[]; mode: string };
    return Response.json({
      embeddings: body.texts.map(() => [0, 1]),
      model: 'batch-model',
      modelRevision: 'rev-b',
      dimensions: 2,
      mode: body.mode,
      truncatedIndices: [],
    });
  });

  try {
    const response = await embedTextsBatched({
      baseUrl: 'http://sidecar.local',
      texts,
      mode: 'query',
      dimensions: 2,
    });

    assert.equal(stub.calls.length, 2);
    assert.equal((JSON.parse(String(stub.calls[0]?.init.body)) as { texts: unknown[] }).texts.length, 512);
    assert.equal((JSON.parse(String(stub.calls[1]?.init.body)) as { texts: unknown[] }).texts.length, 1);
    assert.equal((JSON.parse(String(stub.calls[0]?.init.body)) as { mode: string }).mode, 'query');
    assert.equal(response.embeddings.length, 513);
    assert.equal(response.model, 'batch-model');
    assert.equal(response.modelRevision, 'rev-b');
    assert.equal(response.dimensions, 2);
  } finally {
    stub.restore();
  }
});

test('embedTextsBatched rebases truncated indices across batches', async () => {
  const texts = Array.from({ length: 513 }, (_, index) => `text-${index}`);
  const stub = installFetchStub((_url, init) => {
    const body = JSON.parse(String(init.body)) as { texts: string[]; mode: string };
    return Response.json({
      embeddings: body.texts.map(() => [0, 1]),
      model: 'batch-model',
      modelRevision: 'rev-b',
      dimensions: 2,
      mode: body.mode,
      truncatedIndices: [0],
    });
  });

  try {
    const response = await embedTextsBatched({
      baseUrl: 'http://sidecar.local',
      texts,
      mode: 'document',
      dimensions: 2,
    });

    assert.deepEqual(response.truncatedIndices, [0, 512]);
  } finally {
    stub.restore();
  }
});

test('embedTexts reports sanitized HTTP errors', async () => {
  const stub = installFetchStub(() => new Response('secret-token leaked detail', { status: 500 }));

  try {
    await assert.rejects(
      embedTexts({
        baseUrl: 'http://sidecar.local',
        apiToken: 'secret-token',
        texts: ['alpha'],
        mode: 'query',
        dimensions: 2,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Embedding sidecar returned HTTP 500/u);
        assert.doesNotMatch(error.message, /secret-token/u);
        assert.doesNotMatch(error.message, /leaked detail/u);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('embedTexts reports sanitized parse errors for invalid JSON response bodies', async () => {
  const invalidStub = installFetchStub(() => new Response('not json with secret-token leaked detail', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  try {
    await assert.rejects(
      embedTexts({
        baseUrl: 'http://sidecar.local',
        apiToken: 'secret-token',
        texts: ['alpha'],
        mode: 'query',
        dimensions: 2,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Embedding sidecar returned unexpected response shape');
        assert.equal((error as { code?: string }).code, 'PARSE_ERROR');
        assert.doesNotMatch(error.message, /secret-token/u);
        assert.doesNotMatch(error.message, /leaked detail/u);
        assert.doesNotMatch(error.message, /not json/u);
        return true;
      },
    );
  } finally {
    invalidStub.restore();
  }
});
