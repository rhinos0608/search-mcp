import test from 'node:test';
import assert from 'node:assert/strict';
import { webCrawl } from '../src/tools/webCrawl.js';
import type { WebCrawlResult } from '../src/types.js';

function buildMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const defaultOpts = {
  strategy: 'bfs' as const,
  maxDepth: 1,
  maxPages: 1,
  includeExternalLinks: false,
};

test('webCrawl retries shell-only markdown with an aggressive render profile', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const testUrl = 'https://example.com/test-retry-shell';

  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requestBodies.push(JSON.parse(await req.text()) as Record<string, unknown>);

      if (requestBodies.length === 1) {
        return buildMockResponse({
          result: {
            url: testUrl,
            success: true,
            markdown: 'Loading...',
          },
        });
      }

      return buildMockResponse({
        result: {
          url: testUrl,
          success: true,
          markdown: '# Loaded docs\n\nThe page content finally rendered.',
        },
      });
    };

    const result = (await webCrawl(
      testUrl,
      'https://crawl4ai.example.com',
      '',
      defaultOpts,
    )) as WebCrawlResult & { warnings?: string[] };

    assert.equal(requestBodies.length, 2, 'expected a retry with a second crawl request');
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]?.markdown, '# Loaded docs\n\nThe page content finally rendered.');
    assert.ok(
      result.warnings?.some((warning) => warning.includes('aggressive render profile')),
      'expected a warning about the recovery retry',
    );

    const retryBody = requestBodies[1];
    assert.ok(retryBody, 'expected a second request body');
    const retryParams = retryBody.crawler_config as {
      params?: {
        wait_for?: string;
        delay_before_return_html?: number;
        js_code?: string;
        js_code_before_wait?: string;
      };
    };
    assert.equal(typeof retryParams?.params?.wait_for, 'string', 'expected a JS wait condition');
    assert.match(retryParams?.params?.wait_for ?? '', /^js:/, 'expected a js: wait condition');
    assert.match(
      retryParams?.params?.wait_for ?? '',
      /document\.body\.innerText/,
      'expected the wait condition to inspect body text',
    );
    // JS shell classification uses delay=8 with body-text wait condition
    assert.equal(retryParams?.params?.delay_before_return_html, 8);
    assert.equal(
      retryParams?.params?.js_code_before_wait,
      'window.scrollTo(0, document.body.scrollHeight);',
    );
    assert.equal(
      retryParams?.params?.js_code,
      'window.scrollTo(0, document.body.scrollHeight);',
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('webCrawl does not retry when the baseline page is already meaningful', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const testUrl = 'https://example.com/test-no-retry-meaningful';

  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requestBodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
      return buildMockResponse({
        result: {
          url: testUrl,
          success: true,
          markdown:
            '# My Package\n\n## Installation\nInstall with `npm install my-package`. This is a long paragraph that has enough content to count as meaningful prose.\n\n## Usage\nUsage is straightforward. Call the function and it will connect to the server.',
        },
      });
    };

    const result = (await webCrawl(
      testUrl,
      'https://crawl4ai.example.com',
      '',
      defaultOpts,
    )) as WebCrawlResult & { warnings?: string[] };

    assert.equal(requestBodies.length, 1, 'expected no retry for a good page');
    assert.ok(result.pages[0]?.markdown.startsWith('# My Package'), 'content should start with title');
    assert.ok(!result.warnings || !result.warnings.some((w) => w.includes('aggressive render')), 'should not have aggressive render warnings');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
