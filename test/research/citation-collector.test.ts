/**
 * CitationCollector tests — thread safety, dedup, index stability.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CitationCollector } from '../../src/research/citationCollector.js';

describe('CitationCollector', () => {
   describe('addResults', () => {
      it('assigns sequential 1-based indices', () => {
         const c = new CitationCollector();
         const startIdx = c.addResults(
            [
               { title: 'First', link: 'https://a.com/1', snippet: 'one' },
               { title: 'Second', link: 'https://b.com/2', snippet: 'two' },
            ],
            'web',
         );
         assert.strictEqual(startIdx, 1);
         assert.strictEqual(c.count, 2);
      });

      it('deduplicates by normalized URL', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'First', link: 'https://a.com/1', snippet: 'one' }], 'web');
         c.addResults([{ title: 'First Again', link: 'https://a.com/1', snippet: 'one' }], 'web');
         assert.strictEqual(c.count, 1, 'duplicate URL should not increase count');
      });

      it('deduplicates URLs with tracking params stripped', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'A', link: 'https://example.com/page?utm_source=foo', snippet: 'x' }], 'web');
         c.addResults([{ title: 'A again', link: 'https://example.com/page?utm_medium=bar', snippet: 'x' }], 'web');
         assert.strictEqual(c.count, 1, 'URLs differing only in tracking params should deduplicate');
      });

      it('deduplicates URLs differing only in trailing slash', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'A', link: 'https://example.com/page/', snippet: 'x' }], 'web');
         c.addResults([{ title: 'A again', link: 'https://example.com/page', snippet: 'x' }], 'web');
         assert.strictEqual(c.count, 1, 'URLs differing only in trailing slash should deduplicate');
      });

      it('treats different URLs as separate entries', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'A', link: 'https://a.com/1', snippet: 'x' }], 'web');
         c.addResults([{ title: 'B', link: 'https://b.com/2', snippet: 'y' }], 'web');
         assert.strictEqual(c.count, 2);
      });

      it('handles empty results array', () => {
         const c = new CitationCollector();
         const startIdx = c.addResults([], 'web');
         assert.strictEqual(startIdx, 1);
         assert.strictEqual(c.count, 0);
      });

      it('handles results with no URL', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'No URL' }], 'web');
         assert.strictEqual(c.count, 1);
         c.addResults([{ title: 'No URL again' }], 'web');
         assert.strictEqual(c.count, 2, 'results without URLs should not be deduped');
      });

      it('returns correct starting index for batches', () => {
         const c = new CitationCollector();
         assert.strictEqual(c.addResults([{ title: 'A', link: 'https://a.com', snippet: 'x' }], 'web'), 1);
         assert.strictEqual(c.addResults([{ title: 'B', link: 'https://b.com', snippet: 'y' }], 'arxiv'), 2);
         assert.strictEqual(c.addResults([{ title: 'C', link: 'https://c.com', snippet: 'z' }], 'web'), 3);
      });
   });

   describe('findCitation', () => {
      it('returns index for known URL', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'Test', link: 'https://example.com', snippet: 'x' }], 'web');
         assert.strictEqual(c.findCitation('https://example.com'), 1);
      });

      it('returns undefined for unknown URL', () => {
         const c = new CitationCollector();
         assert.strictEqual(c.findCitation('https://unknown.com'), undefined);
      });

      it('normalizes URL before lookup', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'Test', link: 'https://example.com/page?utm_source=foo', snippet: 'x' }], 'web');
         assert.strictEqual(c.findCitation('https://example.com/page'), 1);
      });
   });

   describe('formatting', () => {
      it('formatForLlm returns formatted citation text', () => {
         const c = new CitationCollector();
         c.addResults(
            [
               { title: 'First', link: 'https://a.com', snippet: 'Snippet A' },
               { title: 'Second', link: 'https://b.com', snippet: 'Snippet B' },
            ],
            'web',
         );
         const text = c.formatForLlm();
         assert.ok(text.includes('[1]'));
         assert.ok(text.includes('[2]'));
         assert.ok(text.includes('First'));
         assert.ok(text.includes('Second'));
      });

      it('formatForLlm returns placeholder when empty', () => {
         const c = new CitationCollector();
         assert.strictEqual(c.formatForLlm(), '(no sources collected)');
      });

      it('formatSourceList returns numbered list', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'Test', link: 'https://example.com', snippet: 'x' }], 'web');
         const text = c.formatSourceList();
         assert.ok(text.includes('[1] Test — https://example.com'));
      });
   });

   describe('reset', () => {
      it('clears entries but preserves urlMap for cross-run dedup', () => {
         const c = new CitationCollector();
         c.addResults([{ title: 'Test', link: 'https://example.com', snippet: 'x' }], 'web');
         assert.strictEqual(c.count, 1);

         c.reset();
         assert.strictEqual(c.count, 0, 'entries should be cleared');

         // URL map is preserved: adding same URL should deduplicate again
         c.addResults([{ title: 'Test again', link: 'https://example.com', snippet: 'x' }], 'web');
         assert.strictEqual(c.count, 0, 're-added same URL should still deduplicate (count stays 0)');
      });
   });
});
