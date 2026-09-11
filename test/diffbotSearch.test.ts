import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { diffbotSearch } from '../src/tools/diffbotSearch.js';
import { headerMap } from './helpers/fetchMock.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  signal: unknown;
}

function mockFetch(captured: CapturedRequest[], response: unknown, status = 200): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = headerMap(init?.headers);
    captured.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers,
      signal: init?.signal,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const SAMPLE = {
  query: ['diffbot'],
  search_results: [
    {
      score: 0.93,
      pageUrl: 'https://www.diffbot.com/',
      title: 'Web Data for your AI',
      content: 'Imagine if your app could access the web like a structured database.',
    },
    {
      score: 0.899,
      pageUrl: 'https://en.wikipedia.org/wiki/Diffbot',
      title: 'Diffbot',
      date: 'Mon, 15 Jun 2026 16:32:36 GMT',
      content: 'Diffbot is a developer of machine learning and computer vision algorithms.',
    },
  ],
  timeMs: 167,
};

test('diffbotSearch sends GET to the fixed endpoint with encoded text and size, Bearer token only in header', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  await diffbotSearch('structured web data & more', 'secret-diffbot-token', 5);

  assert.equal(captured.length, 1);
  const req = captured[0]!;
  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, 'https://llm.diffbot.com/api/v1/web_search');
  assert.equal(url.searchParams.get('text'), 'structured web data & more');
  assert.equal(url.searchParams.get('size'), '5');
  assert.ok(!req.url.includes('secret-diffbot-token'), 'token must never appear in the URL');
  assert.equal(req.headers['authorization'], 'Bearer secret-diffbot-token');
  assert.equal(req.headers['accept'], 'application/json');
  assert.ok(req.signal instanceof AbortSignal, 'request carries an abort/timeout signal');
});

test('diffbotSearch maps search_results to bounded snippets; content is snippet, not AI summary', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await diffbotSearch('diffbot', 'key', 10);

  assert.equal(results.length, 2);
  const first = results[0]!;
  assert.equal(first.title, 'Web Data for your AI');
  assert.equal(first.url, 'https://www.diffbot.com/');
  assert.equal(first.domain, 'www.diffbot.com');
  assert.equal(
    first.description,
    'Imagine if your app could access the web like a structured database.',
  );
  assert.equal(first.position, 1);
  assert.equal(first.source, 'diffbot');
  assert.equal(first.contentKind, 'snippet', 'content is a spliced highlight, not a summary');
  assert.equal(first.generatedSummary, null, 'Diffbot has no native AI summary');
  assert.equal(first.age, null, 'missing date yields null age');
  assert.equal(first.ageKind, 'unknown');

  const second = results[1]!;
  assert.equal(second.position, 2, 'position renumbered');
  assert.equal(second.age, 'Mon, 15 Jun 2026 16:32:36 GMT');
  assert.equal(second.ageKind, 'published');
});

test('diffbotSearch truncates long content snippets to a bounded cap', async () => {
  const captured: CapturedRequest[] = [];
  const longContent = 'word '.repeat(2000); // ~10k chars
  mockFetch(captured, {
    search_results: [
      {
        score: 0.9,
        pageUrl: 'https://example.com/long',
        title: 'Long',
        content: longContent,
      },
    ],
  });

  const results = await diffbotSearch('q', 'key', 10);
  const desc = results[0]?.description ?? '';
  assert.ok(desc.length <= 2560, 'snippet bounded at the shared highlight cap');
  assert.ok(desc.endsWith('…'), 'truncated snippet marked with ellipsis');
});

test('diffbotSearch tolerates untrusted response containers mapping to []', async () => {
  for (const container of [{}, null, 42, 'scalar', true, { nope: true }, { search_results: 7 }]) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, container);
    const results = await diffbotSearch('container-q', 'key', 10);
    assert.deepEqual(results, [], `container ${JSON.stringify(container)} maps to empty`);
  }
});

test('diffbotSearch skips null/scalar entries, empty urls, and coerces malformed fields', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    search_results: [
      null,
      42,
      'junk',
      {
        // Empty/invalid pageUrl coerces to '' and is skipped, matching the
        // jina/firecrawl adapters (no linkless result slot, no dedupe collapse).
        score: 'not-a-number',
        pageUrl: 123,
        title: 'no-usable-link',
        content: 'x',
        date: '',
      },
      {
        score: 0.9,
        pageUrl: 'https://example.com/ok',
        title: 456,
        content: 789,
        date: 20260615,
      },
    ],
  });

  const results = await diffbotSearch('malformed-q', 'key', 10);
  assert.equal(results.length, 1, 'only the entry with a usable url is kept');
  const r = results[0]!;
  assert.equal(r.url, 'https://example.com/ok');
  assert.equal(r.title, '', 'numeric title coerced to empty string');
  assert.equal(r.description, '', 'numeric content coerced to empty string');
  assert.equal(r.domain, 'example.com');
  assert.equal(r.age, null, 'numeric date coerced to null');
  assert.equal(r.ageKind, 'unknown');
});

test('diffbotSearch respects the requested limit', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    search_results: Array.from({ length: 10 }, (_, i) => ({
      score: 0.5,
      pageUrl: `https://example.com/${i}`,
      title: `Result ${i}`,
      content: 'c',
    })),
  });

  const results = await diffbotSearch('limit-q', 'key', 3);
  assert.equal(results.length, 3);
  assert.equal(results[2]?.position, 3);
});

test('diffbotSearch empty query results yield empty array without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { search_results: [] });
  const results = await diffbotSearch('empty-q', 'key', 10);
  assert.deepEqual(results, []);
});

test('diffbotSearch throws unavailableError before any network call when key is empty', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };
  await assert.rejects(
    () => diffbotSearch('q', '', 10),
    (err: unknown) => {
      assert.equal((err as Error).message.includes('not configured'), true);
      return true;
    },
  );
  assert.equal(calls, 0, 'no network call without a key');
});

test('diffbotSearch maps 429 to RATE_LIMIT and 401 to UNAVAILABLE with backend diffbot', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { code: 401, message: 'Missing or invalid Authorization header.' }, 401);
  await assert.rejects(
    () => diffbotSearch('q', 'key', 10),
    (err: unknown) => {
      assert.equal((err as Error).message.includes('401'), true);
      assert.equal((err as { code?: string }).code, 'UNAVAILABLE');
      assert.equal((err as { backend?: string }).backend, 'diffbot');
      return true;
    },
  );

  const captured429: CapturedRequest[] = [];
  mockFetch(captured429, { errors: ['rate limited'] }, 429);
  await assert.rejects(
    () => diffbotSearch('q', 'key', 10),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'RATE_LIMIT');
      assert.equal((err as { backend?: string }).backend, 'diffbot');
      return true;
    },
  );
});

test('diffbotSearch maps other non-OK statuses to UNAVAILABLE with the status code', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { errors: ['query param text size must be between 1 and 5'] }, 400);
  await assert.rejects(
    () => diffbotSearch('q', 'key', 10),
    (err: unknown) => {
      assert.equal((err as Error).message.includes('400'), true);
      assert.equal((err as { code?: string }).code, 'UNAVAILABLE');
      assert.equal((err as { statusCode?: number }).statusCode, 400);
      return true;
    },
  );
});

test('diffbotSearch maps an aborted/timed-out request to TIMEOUT (not a raw DOMException)', async () => {
  globalThis.fetch = (async () =>
    Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))) as typeof fetch;
  await assert.rejects(
    () => diffbotSearch('q', 'key', 10),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'TIMEOUT');
      assert.equal((err as { backend?: string }).backend, 'diffbot');
      return true;
    },
  );
});
