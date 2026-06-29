import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocumentUrl } from '../src/utils/documentExtraction.js';
import { isDocumentUrl } from '../src/utils/documentUtils.js';

test('text-like document URLs are routed as document URLs', () => {
  assert.equal(isDocumentUrl('https://example.com/data.json'), true);
  assert.equal(isDocumentUrl('https://example.com/notes.md'), true);
  assert.equal(isDocumentUrl('https://example.com/report.pdf'), true);
});

test('document extraction returns unsupported for binary document URLs without fetching', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('unexpected');
  }) as typeof fetch;

  try {
    const result = await extractDocumentUrl('https://example.com/report.pdf');
    assert.equal(result.success, false);
    assert.equal(result.unsupported, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document extraction formats JSON text documents as markdown code fences', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"name":"search-mcp","ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const result = await extractDocumentUrl('https://example.com/data.json');
    assert.equal(result.success, true);
    assert.equal(result.unsupported, false);
    assert.match(result.markdown, /^```json/);
    assert.match(result.markdown, /"name": "search-mcp"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
