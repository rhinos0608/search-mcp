import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webCrawl } from '../src/tools/webCrawl.js';

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

const defaultOpts = {
  strategy: 'bfs' as const,
  maxDepth: 1,
  maxPages: 10,
  includeExternalLinks: false,
};

test('webCrawl includes extraction_config in request body when extractionConfig is provided', async () => {
  let capturedBody: unknown = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    capturedBody = JSON.parse(await req.text());
    return buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        extracted_content: [{ title: 'Job 1' }],
      },
    });
  };

  await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    {
      ...defaultOpts,
      extractionConfig: {
        type: 'css_schema',
        schema: { name: 'Jobs', baseSelector: 'article', fields: [{ name: 'title', selector: 'h2', type: 'text' }] },
      },
    },
  );

  assert.ok(capturedBody);
  const body = capturedBody as { extraction_config?: unknown };
  assert.ok(body.extraction_config);
  assert.equal((body.extraction_config as { type: string }).type, 'JsonCssExtractionStrategy');
});

test('webCrawl parses extracted_content into extractedData', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        extracted_content: [{ title: 'Job 1' }, { title: 'Job 2' }],
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    {
      ...defaultOpts,
      extractionConfig: {
        type: 'css_schema',
        schema: { name: 'Jobs', baseSelector: 'article', fields: [{ name: 'title', selector: 'h2', type: 'text' }] },
      },
    },
  );

  assert.ok(result.pages[0]);
  assert.ok(result.pages[0].extractedData);
  assert.equal(result.pages[0].extractedData!.length, 2);
  assert.equal(result.pages[0].extractedData![0]!.title, 'Job 1');
});

test('webCrawl throws parseError when sidecar lacks extraction support', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        // No extracted_content field — sidecar doesn't support extraction
      },
    });

  await assert.rejects(
    async () =>
      webCrawl(
        'https://example.com',
        'https://crawl4ai.example.com',
        '',
        {
          ...defaultOpts,
          extractionConfig: {
            type: 'css_schema',
            schema: { name: 'Jobs', baseSelector: 'article', fields: [{ name: 'title', selector: 'h2', type: 'text' }] },
          },
        },
      ),
    (err: unknown) => {
      return err instanceof Error && /Upgrade Crawl4AI sidecar to v0\.8\.x/i.test(err.message);
    },
  );
});

test('webCrawl passes llmFallback credentials through to extraction_config', async () => {
  let capturedBody: unknown = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    capturedBody = JSON.parse(await req.text());
    return buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        extracted_content: [{ title: 'Job 1' }],
      },
    });
  };

  await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    {
      ...defaultOpts,
      extractionConfig: {
        type: 'llm',
        instruction: 'Extract all jobs',
      },
    },
    { provider: 'openai/gpt-4o', apiToken: 'sk-test' },
  );

  assert.ok(capturedBody);
  const body = capturedBody as { extraction_config?: { type: string; params: { llm_config: { provider: string; api_token: string } } } };
  assert.ok(body.extraction_config);
  assert.equal(body.extraction_config.type, 'LLMExtractionStrategy');
  assert.equal(body.extraction_config.params.llm_config.provider, 'openai/gpt-4o');
  assert.equal(body.extraction_config.params.llm_config.api_token, 'sk-test');
});