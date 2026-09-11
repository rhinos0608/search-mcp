import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../src/errors.js';
import { firecrawlScrape } from '../src/tools/firecrawlScrape.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: RequestRedirect | undefined;
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  }
  return out;
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
      redirect: init?.redirect,
    });
    return new Response(rawBody ?? JSON.stringify(response), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('firecrawlScrape prevalidates target URL and never fetches unsafe targets', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}');
  };

  const unsafeTargets = [
    'http://127.0.0.1/secret',
    'http://[::1]/secret',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/admin',
    'file:///etc/passwd',
  ];

  for (const target of unsafeTargets) {
    await assert.rejects(
      () => firecrawlScrape(target, 'key'),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  }
  assert.equal(called, false);
});

test('firecrawlScrape POSTs fixed /v2/scrape with markdown-only safe options', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    success: true,
    data: {
      markdown: '# Hello',
      html: '<p>ignore</p>',
      links: ['https://example.com/next'],
      metadata: {
        title: 'Hello',
        description: 'Desc',
        statusCode: 200,
        sourceURL: 'https://internal.example/redirected',
      },
    },
  });

  const page = await firecrawlScrape('https://example.com/article', 'fc-test-key');

  assert.equal(captured.length, 1, 'single request, no page following');
  assert.equal(captured[0]!.url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.headers.authorization, 'Bearer fc-test-key');
  assert.equal(captured[0]!.redirect, 'error');
  assert.deepEqual(captured[0]!.body.formats, ['markdown']);
  assert.equal(captured[0]!.body.onlyMainContent, true);
  assert.equal(captured[0]!.body.skipTlsVerification, false);
  assert.equal(captured[0]!.body.storeInCache, false);
  assert.equal(captured[0]!.body.maxAge, 0);
  assert.equal(captured[0]!.body.url, 'https://example.com/article');
  assert.equal(typeof captured[0]!.body.timeout, 'number');
  assert.ok((captured[0]!.body.timeout as number) > 0);
  assert.equal(captured[0]!.body.actions, undefined);

  assert.equal(page.url, 'https://example.com/article');
  assert.equal(page.success, true);
  assert.equal(page.markdown, '# Hello');
  assert.equal(page.title, 'Hello');
  assert.equal(page.description, 'Desc');
  assert.equal(page.statusCode, 200);
  assert.equal(page.errorMessage, null);
  assert.deepEqual(page.links, []);
  assert.equal(page.html, undefined);
});

test('firecrawlScrape maps one page and ignores extra pages/untrusted fields', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    success: true,
    data: {
      markdown: 'keep',
      pages: [
        { pageNumber: 1, markdown: 'p1' },
        { pageNumber: 2, markdown: 'p2' },
      ],
      metadata: { title: 11, description: false, statusCode: '200', error: { msg: 'nope' } },
    },
  });

  const page = await firecrawlScrape('https://example.com/doc', 'key');
  assert.equal(captured.length, 1);
  assert.equal(page.markdown, 'keep');
  assert.equal(page.title, null);
  assert.equal(page.description, null);
  assert.equal(page.statusCode, null);
  assert.equal(page.errorMessage, null);
  assert.deepEqual(page.links, []);
});

test('firecrawlScrape returns one failed page for untrusted 200 JSON', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, null);
  const page = await firecrawlScrape('https://example.com/x', 'key');
  assert.equal(page.url, 'https://example.com/x');
  assert.equal(page.success, false);
  assert.equal(page.markdown, '');
  assert.deepEqual(page.links, []);
});

test('firecrawlScrape throws on status errors without leaking response bodies', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, { error: 'scrape-secret' }, 500, '{"error":"scrape-secret"}');
  await assert.rejects(
    () => firecrawlScrape('https://example.com/x', 'key'),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.statusCode, 500);
      assert.ok(!err.message.includes('scrape-secret'));
      return true;
    },
  );
});

test('firecrawlScrape does not fetch when API key is empty', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}');
  };
  await assert.rejects(
    () => firecrawlScrape('https://example.com/x', ''),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'UNAVAILABLE');
      return true;
    },
  );
  assert.equal(called, false);
});
