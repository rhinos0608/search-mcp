import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { jinaSearch } from '../src/tools/jinaSearch.js';
import { isToolError } from '../src/errors.js';
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
  response: { status?: number; statusText?: string; json?: unknown; reject?: Error },
): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: headerMap(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (response.reject) throw response.reject;
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      headers: { 'content-type': 'application/json' },
    });
  };
}

const SECRET_KEY = 'jina-secret-key-for-tests';

test('jinaSearch POSTs to s.jina.ai with contract headers and JSON body', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    json: {
      data: [
        {
          title: 'Jina Result',
          url: 'https://docs.example.com/guide',
          description: 'A relevant snippet.',
          content: '# full page markdown that must be ignored',
        },
      ],
    },
  });

  await jinaSearch('contract headers', SECRET_KEY, 5);

  const req = captured[0]!;
  assert.equal(req.url, 'https://s.jina.ai/');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['authorization'], `Bearer ${SECRET_KEY}`);
  assert.equal(req.headers['accept'], 'application/json');
  assert.equal(req.headers['x-respond-with'], 'no-content');
  assert.deepEqual(req.body, { q: 'contract headers', num: 5 });
});

test('jinaSearch maps validated title/description/url and ignores content', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    json: {
      data: [
        {
          title: 'Jina Result',
          url: 'https://docs.example.com/guide',
          description: 'A relevant snippet.',
          content: '# full page markdown that must be ignored',
        },
      ],
    },
  });

  const results = await jinaSearch('map-fields', SECRET_KEY, 5);

  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.title, 'Jina Result');
  assert.equal(r.url, 'https://docs.example.com/guide');
  assert.equal(r.description, 'A relevant snippet.');
  assert.ok(!r.description.includes('full page markdown'), 'content field never leaks into snippet');
  assert.equal(r.source, 'jina');
  assert.equal(r.position, 1);
  assert.equal(r.domain, 'docs.example.com');
  assert.equal(r.age, null);
  assert.equal(r.extraSnippet, null);
  assert.equal(r.deepLinks, null);
  assert.equal(r.contentKind, 'snippet');
});

test('jinaSearch skips malformed entries: non-objects, empty urls, missing fields', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    json: {
      data: [
        null,
        'not an object',
        { title: 'no url' },
        { url: 'https://valid.example.com/ok', description: 'desc', title: 'Valid' },
        { title: 'empty url', url: '' },
        { title: 42, url: 'https://numeric-title.example.com/x', description: { nested: true } },
      ],
    },
  });

  const results = await jinaSearch('malformed', SECRET_KEY, 10);

  assert.equal(results.length, 2, 'only entries with a usable url survive');
  assert.equal(results[0]!.title, 'Valid');
  assert.equal(results[0]!.domain, 'valid.example.com');
  assert.equal(results[1]!.title, '', 'numeric title coerced to empty string, not a crash');
  assert.equal(results[1]!.description, '', 'object description coerced to empty string');
  assert.equal(results[1]!.position, 2, 'positions stay contiguous over surviving entries');
});

test('jinaSearch accepts a bare top-level result array as well as a data wrapper', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    json: [{ title: 'Bare', url: 'https://bare.example.com/', description: 'd' }],
  });

  const results = await jinaSearch('bare-array', SECRET_KEY, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Bare');
});

test('jinaSearch clamps num to a positive bounded value', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { json: { data: [] } });

  await jinaSearch('clamp-high', SECRET_KEY, 100);
  assert.ok((captured[0]!.body.num as number) <= 20, 'num clamped to provider max');

  await jinaSearch('clamp-zero', SECRET_KEY, 0);
  assert.ok((captured[1]!.body.num as number) >= 1, 'num floored above zero');
});

test('jinaSearch throws UNAVAILABLE when key missing, before any network call', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { json: {} });

  await assert.rejects(jinaSearch('no-key', '', 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(captured.length, 0, 'no fetch attempted without a key');
});

test('jinaSearch maps 429 to RATE_LIMIT and 401 to UNAVAILABLE without leaking the key', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { status: 429, statusText: 'Too Many Requests' });
  await assert.rejects(jinaSearch('rate', SECRET_KEY, 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'RATE_LIMIT');
    assert.ok(!err.message.includes(SECRET_KEY), 'key never appears in error message');
    return true;
  });

  mockFetch(captured, { status: 401, statusText: 'Unauthorized' });
  await assert.rejects(jinaSearch('auth', SECRET_KEY, 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'UNAVAILABLE');
    assert.ok(!err.message.includes(SECRET_KEY), 'key never appears in error message');
    return true;
  });
});

test('jinaSearch maps 5xx to UNAVAILABLE with status code', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { status: 500, statusText: 'Internal Server Error' });
  await assert.rejects(jinaSearch('server-error', SECRET_KEY, 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'UNAVAILABLE');
    assert.equal(err.statusCode, 500);
    return true;
  });
});

test('jinaSearch maps an aborted/timed-out request to TIMEOUT', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    reject: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
  });
  await assert.rejects(jinaSearch('timeout', SECRET_KEY, 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'TIMEOUT');
    return true;
  });
});

test('jinaSearch rejects an empty key even when a prior keyed call populated the cache', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    json: { data: [{ title: 'T', url: 'https://example.com/a', description: 'd' }] },
  });
  const first = await jinaSearch('cache-order-q', SECRET_KEY, 5);
  assert.equal(first.length, 1);

  // Second call with an empty key must throw unavailable BEFORE the cache
  // lookup (guard precedes cache read), even though the cache now holds
  // results for this query.
  await assert.rejects(jinaSearch('cache-order-q', '', 5), (err: unknown) => {
    assert.ok(isToolError(err));
    assert.equal(err.code, 'UNAVAILABLE');
    assert.match(err.message, /JINA_API_KEY/);
    return true;
  });
  // And no fetch happened for the rejected call.
  assert.equal(captured.length, 1);
});
