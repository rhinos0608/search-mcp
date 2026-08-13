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
            content: 'A detailed content snippet',
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
  assert.equal(results[0]!.description, 'A detailed content snippet');
  assert.equal(results[0]!.domain, 'example.com');
  assert.equal(results[0]!.age, null);
  assert.equal(results[0]!.source, 'ollama-search');
});

test('uses content field for description', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Content Test',
            url: 'https://example.com',
            content: 'Primary content field',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('content-test', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results[0]!.description, 'Primary content field');
});

test('falls back to empty string when content is missing', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'No Content',
            url: 'https://example.com',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('no-content', 10, 'moderate', DEFAULT_CONFIG);

  assert.equal(results[0]!.description, '');
});

test('maps multiple results from a single response', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [
          { title: 'First', url: 'https://one.com', content: 'One' },
          { title: 'Second', url: 'https://two.com', content: 'Two' },
          { title: 'Third', url: 'https://three.com', content: 'Three' },
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
    content: `Desc ${i + 1}`,
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
            content: 'No domain field',
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
            content: 'Invalid URL',
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

test('throws on 401 with ollama signin message and is not retryable', async () => {
  globalThis.fetch = async () => {
    return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' });
  };

  try {
    await ollamaSearch('unauthorized', 10, 'moderate', DEFAULT_CONFIG);
    assert.fail('Expected an error to be thrown');
  } catch (err: unknown) {
    assert.match(String(err), /ollama signin/i);
    if (err instanceof Object && 'retryable' in err) {
      assert.strictEqual((err as { retryable: boolean }).retryable, false);
    }
  }
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

// ── Content Truncation ───────────────────────────────────────────────────────

test('caps long full-body content to a concise excerpt and stays honest as a snippet', async () => {
  const nav =
    '# Nav\n\n[Home](/) [Docs](/docs)\n\n' +
    'Body sentence with real details about the topic. '.repeat(80);
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Long', url: 'https://example.com', content: nav }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('long', 10, 'moderate', DEFAULT_CONFIG);
  const desc = results[0]!.description;
  assert.ok(
    Buffer.byteLength(desc, 'utf8') <= 2560,
    `excerpt bytes ${Buffer.byteLength(desc, 'utf8')} > 2560`,
  );
  assert.equal(results[0]!.contentKind, 'snippet', 'content stays labeled a snippet');
  assert.equal(results[0]!.age, null, 'no invented age');
  assert.equal(results[0]!.ageKind, 'unknown');
});

test('caps long ASCII content to the UTF-8 byte budget', async () => {
  const base = 'A'.repeat(3000);
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Ascii', url: 'https://example.com', content: base }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const results = await ollamaSearch('ascii', 10, 'moderate', DEFAULT_CONFIG);
  const desc = results[0]!.description;
  assert.equal(desc, 'A'.repeat(2560), 'ASCII content hard-capped at 2560 bytes');
  assert.equal(Buffer.byteLength(desc, 'utf8'), 2560);
});

test('prefers a paragraph boundary within the byte budget', async () => {
  const base = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(2000);
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Para', url: 'https://example.com', content: base }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const results = await ollamaSearch('para', 10, 'moderate', DEFAULT_CONFIG);
  const desc = results[0]!.description;
  assert.equal(desc, 'A'.repeat(2000), 'cut at paragraph boundary');
  assert.ok(Buffer.byteLength(desc, 'utf8') <= 2560);
});

test('prefers a sentence boundary within the byte budget', async () => {
  const base = 'A'.repeat(2000) + '. ' + 'B'.repeat(2000);
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Sent', url: 'https://example.com', content: base }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const results = await ollamaSearch('sent', 10, 'moderate', DEFAULT_CONFIG);
  const desc = results[0]!.description;
  assert.equal(desc, 'A'.repeat(2000) + '.', 'cut at sentence boundary');
  assert.ok(Buffer.byteLength(desc, 'utf8') <= 2560);
});

test('does not split a surrogate pair when capping long content', async () => {
  // 2550 'A' + 3 emoji (4 UTF-8 bytes each) + 'x' = 2563 bytes > 2560 cap. The
  // hard cut at 2560 bytes lands on the high surrogate of the third emoji.
  const base = 'A'.repeat(2550) + '😀😀😀' + 'x';
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Emoji', url: 'https://example.com', content: base }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('emoji', 10, 'moderate', DEFAULT_CONFIG);
  const desc = results[0]!.description;
  // The hard cut lands on the third emoji's high surrogate; that lone high
  // surrogate must be dropped, retaining the full safe prefix and the two
  // complete emoji that precede the cut.
  assert.equal(
    desc,
    'A'.repeat(2550) + '😀😀',
    'safe prefix and two complete emoji retained, partial third emoji dropped',
  );
  assert.ok(
    Buffer.byteLength(desc, 'utf8') <= 2560,
    `excerpt bytes ${Buffer.byteLength(desc, 'utf8')} > 2560`,
  );
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(desc), 'no orphan high surrogate');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(desc), 'no orphan low surrogate');
});

test('preserves short content unchanged', async () => {
  const short = 'A concise snippet with a clear summary.';
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        results: [{ title: 'Short', url: 'https://example.com', content: short }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const results = await ollamaSearch('short', 10, 'moderate', DEFAULT_CONFIG);
  assert.equal(results[0]!.description, short);
});

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

  assert.equal(calledUrl, 'http://localhost:11434/api/experimental/web_search');
});
