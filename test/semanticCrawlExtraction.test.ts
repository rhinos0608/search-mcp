import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { semanticCrawl } from '../src/tools/semanticCrawl.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('semanticCrawl forwards extractionConfig and returns extractedData keyed by URL', async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/embed')) {
      const body = init?.body ? JSON.parse(await new Response(init.body).text()) : { texts: [] };
      return buildMockResponse({
        embeddings: body.texts.map(() => Array.from({ length: 768 }, () => Math.random())),
        model: 'test-model',
      });
    }

    return buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello\n\nSome paragraph text here.',
        extracted_content: [{ title: 'Job 1' }],
        metadata: { title: 'Example' },
        links: { internal: [], external: [] },
      },
    });
  };

  const result = await semanticCrawl(
    {
      source: { type: 'url', url: 'https://example.com' },
      query: 'test',
      topK: 1,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
      extractionConfig: {
        type: 'css_schema',
        schema: { name: 'Jobs', baseSelector: 'article', fields: [{ name: 'title', selector: 'h2', type: 'text' }] },
      },
    },
    { baseUrl: 'https://crawl4ai.example.com', apiToken: '' },
    'https://embedding.example.com',
    '',
    768,
  );

  assert.ok(result.extractedData);
  assert.ok(result.extractedData!['https://example.com']);
  assert.equal(result.extractedData!['https://example.com']![0]!.title, 'Job 1');
});

test('semanticCrawl omits extractedData when extractionConfig is not provided', async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/embed')) {
      const body = init?.body ? JSON.parse(await new Response(init.body).text()) : { texts: [] };
      return buildMockResponse({
        embeddings: body.texts.map(() => Array.from({ length: 768 }, () => Math.random())),
        model: 'test-model',
      });
    }

    return buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello\n\nSome paragraph text here.',
        metadata: { title: 'Example' },
        links: { internal: [], external: [] },
      },
    });
  };

  const result = await semanticCrawl(
    {
      source: { type: 'url', url: 'https://example.com' },
      query: 'test',
      topK: 1,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
    },
    { baseUrl: 'https://crawl4ai.example.com', apiToken: '' },
    'https://embedding.example.com',
    '',
    768,
  );

  assert.equal(result.extractedData, undefined);
});
