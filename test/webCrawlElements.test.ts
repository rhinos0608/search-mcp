import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webCrawl } from '../src/tools/webCrawl.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildMockResponse(
  body: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

const defaultOpts = {
  strategy: 'bfs' as const,
  maxDepth: 1,
  maxPages: 10,
  includeExternalLinks: false,
};

test('webCrawl extracts elements from markdown', async () => {
  const markdown = `# Hello World

This is a paragraph.

| A | B |
|---|---|
| 1 | 2 |

- item one
- item two

\`\`\`python
print(1)
\`\`\`
`;

  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown,
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.ok(result.pages[0].elements, 'should have elements array');
  assert.ok(result.pages[0].elements!.length > 0, 'should have elements');

  const heading = result.pages[0].elements!.find((e) => e.type === 'heading');
  assert.ok(heading, 'should have heading');
  assert.equal(heading!.text, 'Hello World');

  const table = result.pages[0].elements!.find((e) => e.type === 'table');
  assert.ok(table, 'should have table');
  assert.equal(table!.rows, 2);
  assert.equal(table!.cols, 2);

  const list = result.pages[0].elements!.find((e) => e.type === 'list');
  assert.ok(list, 'should have list');
  assert.equal(list!.items.length, 2);

  const code = result.pages[0].elements!.find((e) => e.type === 'code');
  assert.ok(code, 'should have code block');
  assert.equal(code!.language, 'python');
});

test('webCrawl does not include elements when markdown is empty', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '',
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].elements, undefined);
});
