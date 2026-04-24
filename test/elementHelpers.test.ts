import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  finalizeStructuredContent,
  safeStructuredFromHtml,
  safeStructuredFromMarkdown,
  wrapCodeAsStructuredContent,
  wrapTextAsStructuredContent,
} from '../src/utils/elementHelpers.js';
import { MAX_ELEMENTS, MAX_TEXT_LENGTH, TRUNCATED_MARKER } from '../src/utils/htmlElements.js';
import type { ContentElement } from '../src/types.js';

describe('elementHelpers', () => {
  describe('safeStructuredFromHtml', () => {
    it('extracts finalized elements from valid HTML', () => {
      const structured = safeStructuredFromHtml('<h1>Title</h1><p>Paragraph</p>');
      assert.strictEqual(structured.elements?.length, 2);
      assert.strictEqual(structured.elements?.[0]?.type, 'heading');
      assert.strictEqual(structured.elements?.[1]?.type, 'text');
      assert.strictEqual(structured.truncatedElements, undefined);
    });

    it('resolves relative image URLs when a base URL is provided', () => {
      const structured = safeStructuredFromHtml(
        '<img src="/pic.png" alt="diagram">',
        'https://example.com/article',
      );
      const image = structured.elements?.[0];
      assert.strictEqual(image?.type, 'image');
      if (image?.type === 'image') {
        assert.strictEqual(image.src, 'https://example.com/pic.png');
      }
    });

    it('returns empty structured content for empty HTML', () => {
      assert.deepStrictEqual(safeStructuredFromHtml(''), {});
      assert.deepStrictEqual(safeStructuredFromHtml(null), {});
      assert.deepStrictEqual(safeStructuredFromHtml(undefined), {});
    });
  });

  describe('safeStructuredFromMarkdown', () => {
    it('extracts finalized elements from valid markdown', () => {
      const structured = safeStructuredFromMarkdown('# Title\n\nParagraph');
      assert.strictEqual(structured.elements?.length, 2);
      assert.strictEqual(structured.elements?.[0]?.type, 'heading');
      assert.strictEqual(structured.elements?.[1]?.type, 'text');
      assert.strictEqual(structured.truncatedElements, undefined);
    });

    it('returns empty structured content for empty markdown', () => {
      assert.deepStrictEqual(safeStructuredFromMarkdown(''), {});
      assert.deepStrictEqual(safeStructuredFromMarkdown(null), {});
      assert.deepStrictEqual(safeStructuredFromMarkdown(undefined), {});
    });
  });

  describe('finalizeStructuredContent', () => {
    it('prioritizes structural elements over low-value text and restores original order', () => {
      const lowValueText: ContentElement[] = Array.from({ length: MAX_ELEMENTS }, (_, i) => ({
        type: 'text',
        text: `Paragraph ${i}`,
      }));
      const candidates: ContentElement[] = [
        lowValueText[0]!,
        { type: 'heading', level: 2, text: 'Early heading', id: null },
        ...lowValueText.slice(1),
        { type: 'table', markdown: '| A |\n| --- |\n| B |', caption: null, rows: 2, cols: 1 },
        { type: 'code', language: 'ts', content: 'const x = 1;' },
      ];

      const structured = finalizeStructuredContent(candidates);

      assert.strictEqual(structured.elements?.length, MAX_ELEMENTS);
      assert.strictEqual(structured.truncatedElements, true);
      assert.strictEqual(structured.originalElementCount, candidates.length);
      assert.strictEqual(structured.omittedElementCount, candidates.length - MAX_ELEMENTS);
      assert.ok(structured.elements?.some((element) => element.type === 'heading'));
      assert.ok(structured.elements?.some((element) => element.type === 'table'));
      assert.ok(structured.elements?.some((element) => element.type === 'code'));

      const headingIndex = structured.elements!.findIndex((element) => element.type === 'heading');
      const tableIndex = structured.elements!.findIndex((element) => element.type === 'table');
      const codeIndex = structured.elements!.findIndex((element) => element.type === 'code');
      assert.ok(headingIndex < tableIndex);
      assert.ok(tableIndex < codeIndex);
    });
  });

  describe('wrappers', () => {
    it('wraps long text with truncation metadata', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const structured = wrapTextAsStructuredContent(longText);
      const text = structured.elements?.[0] as
        | { type: 'text'; text: string; truncated?: true; originalLength?: number }
        | undefined;

      assert.strictEqual(text?.type, 'text');
      assert.strictEqual(text?.truncated, true);
      assert.strictEqual(text?.originalLength, longText.length);
      assert.ok(text?.text.endsWith(TRUNCATED_MARKER));
    });

    it('wraps code directly without text-element mutation', () => {
      const longCode = 'x'.repeat(MAX_TEXT_LENGTH + 100);
      const structured = wrapCodeAsStructuredContent(longCode, 'typescript');
      const code = structured.elements?.[0] as
        | {
            type: 'code';
            language: string | null;
            content: string;
            truncated?: true;
            originalLength?: number;
          }
        | undefined;

      assert.strictEqual(code?.type, 'code');
      assert.strictEqual(code.language, 'typescript');
      assert.strictEqual(code.truncated, true);
      assert.strictEqual(code.originalLength, longCode.length);
      assert.ok(code.content.endsWith(TRUNCATED_MARKER));
    });

    it('omits structured content for empty wrappers', () => {
      assert.deepStrictEqual(wrapTextAsStructuredContent(''), {});
      assert.deepStrictEqual(wrapCodeAsStructuredContent('', 'text'), {});
    });
  });
});
