import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../src/errors.js';
import { firecrawlSearch } from '../src/tools/firecrawlSearch.js';
import { headerMap } from './helpers/fetchMock.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockFetch(
  captured: CapturedRequest[],
  response: unknown,
  status = 200,
  rawBody?: string,
): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: headerMap(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(rawBody ?? JSON.stringify(response), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('firecrawlSearch POSTs fixed /v2/search with Bearer and web source only', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    success: true,
    data: {
      web: [{ title: 'Example', description: 'A snippet', url: 'https://example.com/page' }],
    },
  });

  const results = await firecrawlSearch('q', 'fc-test-key', 5);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.headers.authorization, 'Bearer fc-test-key');
  assert.deepEqual(captured[0]!.body.sources, ['web']);
  assert.equal(captured[0]!.body.query, 'q');
  assert.equal(captured[0]!.body.limit, 5);
  assert.equal('scrapeOptions' in captured[0]!.body, false);
  assert.equal(captured[0]!.body.scrapeOptions, undefined);
  assert.equal(captured[0]!.body.formats, undefined);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Example');
  assert.equal(results[0]!.description, 'A snippet');
  assert.equal(results[0]!.url, 'https://example.com/page');
  assert.equal(results[0]!.contentKind, 'snippet');
  assert.equal(results[0]!.source, 'firecrawl');
  assert.equal(results[0]!.position, 1);
  assert.equal(results[0]!.domain, 'example.com');
});

test('firecrawlSearch maps only data.web title/description/url and ignores full content', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    success: true,
    data: {
      web: [
        {
          title: 'Keep',
          description: 'Snippet only',
          url: 'https://example.com/a',
          markdown: '# Full page markdown that must not become the snippet',
          html: '<p>full html</p>',
        },
      ],
      news: [{ title: 'News', snippet: 'ignored', url: 'https://news.example/x' }],
      images: [{ title: 'Img', url: 'https://img.example/x' }],
    },
  });

  const results = await firecrawlSearch('q', 'key');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.description, 'Snippet only');
  assert.ok(!results[0]!.description.includes('Full page'));
  assert.equal(results[0]!.extraSnippet, null);
  assert.equal(captured[0]!.body.scrapeOptions, undefined);
});

test('firecrawlSearch validates untrusted JSON without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    success: true,
    data: {
      web: [
        null,
        'nope',
        12,
        { title: 99, description: { x: 1 }, url: 'https://example.com/ok' },
        { title: 'No url', description: 'x' },
        { title: 'Ok', description: 'd', url: 'https://example.com/two' },
      ],
    },
  });

  const results = await firecrawlSearch('q', 'key', 10);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, '');
  assert.equal(results[0]!.description, '');
  assert.equal(results[0]!.url, 'https://example.com/ok');
  assert.equal(results[1]!.title, 'Ok');
  assert.equal(results[1]!.position, 2);
});

test('firecrawlSearch returns empty list for malformed payloads', async () => {
  for (const payload of [null, [], { data: null }, { data: { web: {} } }, { web: [] }]) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, payload);
    const results = await firecrawlSearch('q', 'key');
    assert.deepEqual(results, []);
  }
});

test('firecrawlSearch throws on status errors without leaking response bodies', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { error: 'super-secret-body' }, 401, '{"error":"super-secret-body"}');
  await assert.rejects(
    () => firecrawlSearch('q', 'key'),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, 'UNAVAILABLE');
      assert.ok(!err.message.includes('super-secret-body'));
      return true;
    },
  );

  mockFetch(captured, { error: 'secret-429' }, 429, '{"error":"secret-429"}');
  await assert.rejects(
    () => firecrawlSearch('q', 'key'),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, 'RATE_LIMIT');
      assert.ok(!err.message.includes('secret-429'));
      return true;
    },
  );
});

test('firecrawlSearch does not fetch when API key is empty', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => firecrawlSearch('q', ''),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'UNAVAILABLE');
      return true;
    },
  );
  assert.equal(called, false);
});

test('firecrawlSearch maps an aborted/timed-out request to TIMEOUT (not a raw DOMException)', async () => {
  globalThis.fetch = (async () =>
    Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))) as typeof fetch;
  await assert.rejects(
    () => firecrawlSearch('q', 'key', 5),
    (err: unknown) => {
      assert.ok(err instanceof ToolError, 'error is a ToolError');
      assert.equal((err as ToolError).code, 'TIMEOUT');
      assert.equal((err as ToolError).backend, 'firecrawl');
      return true;
    },
  );
});
