/**
 * Tests for contextual embedding enrichment.
 * Stage 1: V3.3.0 Extraction Resilience
 */

import { describe, it, mock } from 'node:test';
import { strictEqual, ok, fail, rejects } from 'node:assert';
import type { LlmConfig } from '../src/config.js';
import type { CorpusChunk } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Minimal corpus chunk for testing. */
function makeChunk(text: string, url = 'https://example.com/page'): CorpusChunk {
  return { text, url, section: 'page', charOffset: 0, chunkIndex: 0, totalChunks: 1 };
}

/** Create a mock fetch Response with all required properties. */
function makeMockResponse(bodyObj: unknown, status = 200): Response {
  const bodyText = JSON.stringify(bodyObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(bodyObj),
    text: () => Promise.resolve(bodyText),
  } as Response;
}

/** Mock LLM config. */
function makeLlmConfig(): LlmConfig {
  return {
    provider: 'openai',
    apiToken: 'test-token',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
  };
}

/** Build a minimal document map for testing. */
function makeDocMap(url: string, content: string): Map<string, string> {
  const map = new Map<string, string>();
  map.set(url, content);
  return map;
}

// ── Module import (tests fail until module is created) ─────────────────────

// If this import throws, the module doesn't exist yet — tests fail as required.
let contextualEmbeddingModule: typeof import('../src/rag/contextualEmbedding.js') | undefined;
try {
  contextualEmbeddingModule = await import('../src/rag/contextualEmbedding.js');
} catch {
  // Module not yet created — this is expected in the RED phase.
}

describe('contextualEmbedding', () => {
  // ── Unit: enrichChunkWithContext ──────────────────────────────────────────

  describe('enrichChunkWithContext', () => {
    it('rejects empty chunk text', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }
      await rejects(
        () =>
          contextualEmbeddingModule!.enrichChunkWithContext(
            '',
            'full document text',
            makeLlmConfig(),
          ),
        /chunk.*empty/i,
      );
    });

    it('rejects empty document text', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }
      await rejects(
        () =>
          contextualEmbeddingModule!.enrichChunkWithContext('some chunk text', '', makeLlmConfig()),
        /document.*empty/i,
      );
    });

    it('returns enrichText = chunk when LLM call fails gracefully', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      // Mock fetch that throws
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() => Promise.reject(new Error('network error')));

      try {
        const result = await contextualEmbeddingModule!.enrichChunkWithContext(
          'function hello() { return "world"; }',
          'A TypeScript file demonstrating basic function syntax.',
          makeLlmConfig(),
        );

        strictEqual(result.enriched, false);
        strictEqual(result.embedText, 'function hello() { return "world"; }');
        strictEqual(result.originalText, 'function hello() { return "world"; }');
        ok(result.context === '' || result.context.length > 0); // context may be empty string on failure
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns enriched text from a successful LLM response', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() =>
        Promise.resolve(
          makeMockResponse({
            choices: [
              {
                message: {
                  content:
                    'Context: function declaration in TypeScript file.\n---\nfunction hello() { return "world"; }',
                },
              },
            ],
          }),
        ),
      );

      try {
        const result = await contextualEmbeddingModule!.enrichChunkWithContext(
          'function hello() { return "world"; }',
          'A TypeScript file demonstrating basic function syntax.',
          makeLlmConfig(),
        );

        strictEqual(result.enriched, true);
        ok(result.embedText.length > 0, 'embedText should not be empty');
        strictEqual(result.originalText, 'function hello() { return "world"; }');
        ok(result.context.length > 0, 'context should be non-empty');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ── Unit: enrichChunksBatched ──────────────────────────────────────────────

  describe('enrichChunksBatched', () => {
    it('processes multiple chunks in parallel', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      let callCount = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() => {
        callCount++;
        return Promise.resolve(
          makeMockResponse({
            choices: [
              {
                message: {
                  content: `Context: chunk ${callCount}.\n---\nchunk content`,
                },
              },
            ],
          }),
        );
      });

      try {
        const chunks: CorpusChunk[] = [
          makeChunk('chunk A', 'https://example.com/a'),
          makeChunk('chunk B', 'https://example.com/b'),
          makeChunk('chunk C', 'https://example.com/c'),
        ];
        const docMap = new Map<string, string>();
        docMap.set('https://example.com/a', 'Document A with intro text.');
        docMap.set('https://example.com/b', 'Document B with intro text.');
        docMap.set('https://example.com/c', 'Document C with intro text.');

        const results = await contextualEmbeddingModule!.enrichChunksBatched(
          chunks,
          docMap,
          makeLlmConfig(),
          5, // concurrency
        );

        strictEqual(results.length, 3);
        ok(callCount >= 3, `Expected at least 3 LLM calls, got ${String(callCount)}`);
        for (const r of results) {
          strictEqual(r.originalText.length > 0, true);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('respects concurrency limit', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      let maxConcurrent = 0;
      let currentConcurrent = 0;
      let totalCalls = 0;
      const originalFetch = globalThis.fetch;

      // Simulate a slow LLM endpoint
      globalThis.fetch = mock.fn(() => {
        totalCalls++;
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            currentConcurrent--;
            resolve(
              makeMockResponse({
                choices: [{ message: { content: 'Context.\n---\nchunk content' } }],
              }),
            );
          }, 50);
        });
      });

      try {
        const chunks: CorpusChunk[] = Array.from({ length: 6 }, (_, i) =>
          makeChunk(`chunk ${String(i)}`, `https://example.com/${String(i)}`),
        );
        const docMap = new Map<string, string>();
        for (let i = 0; i < 6; i++) {
          docMap.set(`https://example.com/${String(i)}`, 'Document content.');
        }

        // concurrency = 2 should keep maxConcurrent at 2
        await contextualEmbeddingModule!.enrichChunksBatched(chunks, docMap, makeLlmConfig(), 2);

        strictEqual(totalCalls, 6);
        ok(maxConcurrent <= 2, `Concurrency exceeded: max=${String(maxConcurrent)}, expected ≤2`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('degrades gracefully when LLM returns empty content', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() =>
        Promise.resolve(
          makeMockResponse({
            choices: [{ message: { content: '' } }],
          }),
        ),
      );

      try {
        const result = await contextualEmbeddingModule!.enrichChunkWithContext(
          'original chunk text',
          'Full document text for context.',
          makeLlmConfig(),
        );

        // Empty response should fall back to original text
        strictEqual(result.enriched, false);
        strictEqual(result.embedText, 'original chunk text');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ── Integration: no-op when LLM config missing ───────────────────────────────

  describe('no-op when LLM config missing', () => {
    it('enrichChunkWithContext returns original text unchanged', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      const chunk = makeChunk('function test() {}');
      const docMap = makeDocMap(chunk.url, 'A test file.');

      // Pass undefined llm config
      const result = await contextualEmbeddingModule!.enrichChunkWithContext(
        chunk.text,
        docMap.get(chunk.url) ?? '',
        undefined,
      );

      strictEqual(result.enriched, false);
      strictEqual(result.embedText, chunk.text);
      strictEqual(result.originalText, chunk.text);
      strictEqual(result.context, '');
    });

    it('enrichChunksBatched returns original texts when llm is undefined', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      const chunks = [
        makeChunk('chunk 1', 'https://example.com/1'),
        makeChunk('chunk 2', 'https://example.com/2'),
      ];
      const docMap = new Map<string, string>();
      docMap.set('https://example.com/1', 'Doc 1.');
      docMap.set('https://example.com/2', 'Doc 2.');

      const results = await contextualEmbeddingModule!.enrichChunksBatched(
        chunks,
        docMap,
        undefined,
      );

      strictEqual(results.length, 2);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const c = chunks[i];
        if (!r || !c) continue;
        strictEqual(r.embedText, c.text);
        strictEqual(r.originalText, c.text);
        strictEqual(r.enriched, false);
      }
    });
  });

  // ── Prompt format ───────────────────────────────────────────────────────────

  describe('prompt format', () => {
    it('constructs a prompt with document and chunk sections', async () => {
      if (!contextualEmbeddingModule) {
        fail('Module not found — implement src/rag/contextualEmbedding.ts first');
      }

      let capturedBody: string | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn((_url, init) => {
        const body = (init as { body?: string })?.body;
        if (body) capturedBody = body;
        return Promise.resolve(
          makeMockResponse({
            choices: [
              {
                message: {
                  content: 'Context: doc.\n---\nchunk',
                },
              },
            ],
          }),
        );
      });

      try {
        await contextualEmbeddingModule!.enrichChunkWithContext(
          'my chunk text',
          'my document text',
          makeLlmConfig(),
        );

        ok(capturedBody !== undefined, 'Request body should be captured');
        const parsed = JSON.parse(capturedBody!);
        const userMessage = parsed.messages?.find((m: { role: string }) => m.role === 'user');
        ok(userMessage !== undefined, 'Should have a user message');
        ok(
          userMessage.content.includes('<document>') &&
            userMessage.content.includes('my document text'),
          'Prompt should contain document tag and content',
        );
        ok(
          userMessage.content.includes('<chunk>') && userMessage.content.includes('my chunk text'),
          'Prompt should contain chunk tag and content',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
