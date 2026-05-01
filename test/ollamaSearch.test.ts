import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ollamaSearch } from '../src/tools/ollamaSearch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DEFAULT_CONFIG = { baseUrl: 'http://localhost:11434', apiKey: '' };

// ── Response Mapping ─────────────────────────────────────────────────────────

test('maps a valid Ollama search response to SearchResult[]', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Example Page',
            url: 'https://example.com/page',
            description: 'A detailed description',
            domain: 'example.com',
            age: '2 days ago',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('test', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Example Page');
  assert.equal(results[0]!.url, 'https://example.com/page');
  assert.equal(results[0]!.description, 'A detailed description');
  assert.equal(results[0]!.domain, 'example.com');
  assert.equal(results[0]!.age, '2 days ago');
  assert.equal(results[0]!.source, 'ollama-search');
});

test('prefers snippet over description for description field', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Snippet Test',
            url: 'https://example.com',
            description: 'Long description',
            snippet: 'Short snippet',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('test-snippet', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results[0]!.description, 'Short snippet');
});

test('falls back to description if snippet is missing', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'No Snippet',
            url: 'https://example.com',
            description: 'Only description',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('no-snippet', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results[0]!.description, 'Only description');
});

test('maps multiple results from a single response', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          { title: 'First', url: 'https://one.com', description: 'One' },
          { title: 'Second', url: 'https://two.com', description: 'Two' },
          { title: 'Third', url: 'https://three.com', description: 'Three' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('multi', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 3);
  assert.equal(results[0]!.position, 1);
  assert.equal(results[2]!.position, 3);
});

test('respects the limit parameter', async () => {
  const rawResults = Array.from({ length: 20 }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://r${i + 1}.com`,
    description: `Desc ${i + 1}`,
  }));

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ results: rawResults }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await ollamaSearch('limit-test', 5, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 5);
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

test('empty results array returns empty list', async () => {
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await ollamaSearch('empty', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 0);
});

test('missing results key returns empty list', async () => {
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await ollamaSearch('missing-key', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 0);
});

test('handles missing fields gracefully', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ url: 'https://example.com' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('missing-fields', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, '');
  assert.equal(results[0]!.url, 'https://example.com');
  assert.equal(results[0]!.description, '');
  assert.equal(results[0]!.age, null);
});

test('extracts domain from URL when domain field missing', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Domain Test',
            url: 'https://sub.example.org/path?q=1',
            description: 'No domain field',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('domain-extract', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results[0]!.domain, 'sub.example.org');
});

test('handles invalid URL in domain extraction gracefully', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Bad URL',
            url: 'not-a-valid-url',
            description: 'Invalid URL',
          },
          {
            title: 'Good URL',
            url: 'https://ok.com',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('bad-url', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Good URL');
  assert.equal(results[0]!.domain, 'ok.com');
});

// ── Error Handling ───────────────────────────────────────────────────────────

test('throws on HTTP error status', async () => {
  globalThis.fetch = async () => {
    return new Response('Internal error', { status: 500, statusText: 'Internal Server Error' });
  };

  await assert.rejects(
    ollamaSearch('error-status', 10, 'moderate', DEFAULT_CONFIG),
    /Ollama search returned 500/i,
  );
});

test('throws on network error (unreachable host)', async () => {
  globalThis.fetch = async () => {
    const err = new Error('connect ECONNREFUSED');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    throw err;
  };

  await assert.rejects(
    ollamaSearch('network-error', 10, 'moderate', DEFAULT_CONFIG),
    /Ollama search host unreachable/i,
  );
});

test('throws on invalid JSON response', async () => {
  globalThis.fetch = async () => {
    return new Response('Not JSON at all', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await assert.rejects(
    ollamaSearch('bad-json', 10, 'moderate', DEFAULT_CONFIG),
    /Ollama search returned invalid JSON/i,
  );
});

// ── Auth ─────────────────────────────────────────────────────────────────────

test('sends Authorization header when apiKey is provided', async () => {
  let authHeader: string | null = null;

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers;
    if (headers instanceof Headers) {
      authHeader = headers.get('Authorization');
    } else {
      authHeader = (headers as Record<string, string> | undefined)?.Authorization ?? null;
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await ollamaSearch('auth-test', 10, 'moderate', {
    ...DEFAULT_CONFIG,
    apiKey: 'sk-test-key',
  });

  assert.equal(authHeader, 'Bearer sk-test-key');
});

test('does not send Authorization header when apiKey is empty', async () => {
  let authHeader: string | null = null;

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers;
    if (headers instanceof Headers) {
      authHeader = headers.get('Authorization');
    } else {
      authHeader = (headers as Record<string, string> | undefined)?.Authorization ?? null;
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await ollamaSearch('no-auth', 10, 'moderate', { baseUrl: 'http://localhost:11434', apiKey: '' });

  assert.equal(authHeader, null);
});

// ── URL Construction ─────────────────────────────────────────────────────────

test('strips trailing slash from baseUrl before appending path', async () => {
  let calledUrl = '';

  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await ollamaSearch('url-test', 10, 'moderate', {
    baseUrl: 'http://localhost:11434/',
    apiKey: '',
  });

  assert.equal(calledUrl, 'http://localhost:11434/v1/search');
});
