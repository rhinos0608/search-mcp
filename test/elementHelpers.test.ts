import { describe, it } from 'node:test';
import assert from 'node:assert';
import { safeExtractFromHtml, safeExtractFromMarkdown, wrapTextInElement } from '../src/utils/elementHelpers.js';
import { MAX_ELEMENTS, MAX_TEXT_LENGTH, TRUNCATED_MARKER } from '../src/utils/htmlElements.js';

describe('elementHelpers', () => {
  describe('safeExtractFromHtml', () => {
    it('should extract elements from valid HTML', () => {
      const html = '<h1>Title</h1><p>Paragraph</p>';
      const elements = safeExtractFromHtml(html);
      assert.strictEqual(elements.length, 2);
      assert.strictEqual(elements[0]?.type, 'heading');
      assert.strictEqual(elements[1]?.type, 'text');
    });

    it('should respect MAX_ELEMENTS limit', () => {
      let html = '';
      for (let i = 0; i < MAX_ELEMENTS + 10; i++) {
        html += `<p>Paragraph ${i}</p>`;
      }
      const elements = safeExtractFromHtml(html);
      assert.strictEqual(elements.length, MAX_ELEMENTS);
    });

    it('should truncate long text', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const html = `<p>${longText}</p>`;
      const elements = safeExtractFromHtml(html);
      assert.strictEqual(elements[0]?.type, 'text');
      if (elements[0]?.type === 'text') {
        assert.strictEqual(elements[0].text.length, MAX_TEXT_LENGTH + TRUNCATED_MARKER.length);
        assert.ok(elements[0].text.endsWith(TRUNCATED_MARKER));
      }
    });

    it('should truncate table markdown', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const html = `<table><tr><td>${longText}</td></tr></table>`;
      const elements = safeExtractFromHtml(html);
      assert.strictEqual(elements[0]?.type, 'table');
      if (elements[0]?.type === 'table') {
        assert.ok(elements[0].markdown.length >= MAX_TEXT_LENGTH);
        assert.ok(elements[0].markdown.endsWith(TRUNCATED_MARKER));
      }
    });
  });

  describe('safeExtractFromMarkdown', () => {
    it('should extract elements from valid markdown', () => {
      const markdown = '# Title\n\nParagraph';
      const elements = safeExtractFromMarkdown(markdown);
      assert.strictEqual(elements.length, 2);
      assert.strictEqual(elements[0]?.type, 'heading');
      assert.strictEqual(elements[1]?.type, 'text');
    });

    it('should respect MAX_ELEMENTS limit', () => {
      let markdown = '';
      for (let i = 0; i < MAX_ELEMENTS + 10; i++) {
        markdown += `Paragraph ${i}\n\n`;
      }
      const elements = safeExtractFromMarkdown(markdown);
      assert.strictEqual(elements.length, MAX_ELEMENTS);
    });

    it('should truncate long text', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const markdown = longText;
      const elements = safeExtractFromMarkdown(markdown);
      assert.strictEqual(elements[0]?.type, 'text');
      if (elements[0]?.type === 'text') {
        assert.strictEqual(elements[0].text.length, MAX_TEXT_LENGTH + TRUNCATED_MARKER.length);
        assert.ok(elements[0].text.endsWith(TRUNCATED_MARKER));
      }
    });

    it('should truncate code content', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const markdown = '```\n' + longText + '\n```';
      const elements = safeExtractFromMarkdown(markdown);
      assert.strictEqual(elements[0]?.type, 'code');
      if (elements[0]?.type === 'code') {
        assert.strictEqual(elements[0].content.length, MAX_TEXT_LENGTH + TRUNCATED_MARKER.length);
        assert.ok(elements[0].content.endsWith(TRUNCATED_MARKER));
      }
    });
  });

  describe('wrapTextInElement', () => {
    it('should wrap text in a TextElement', () => {
      const elements = wrapTextInElement('Hello world');
      assert.strictEqual(elements.length, 1);
      assert.strictEqual(elements[0]?.type, 'text');
      if (elements[0]?.type === 'text') {
        assert.strictEqual(elements[0].text, 'Hello world');
      }
    });

    it('should truncate wrapped text', () => {
      const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
      const elements = wrapTextInElement(longText);
      assert.strictEqual(elements.length, 1);
      if (elements[0]?.type === 'text') {
        assert.strictEqual(elements[0].text.length, MAX_TEXT_LENGTH + TRUNCATED_MARKER.length);
        assert.ok(elements[0].text.endsWith(TRUNCATED_MARKER));
      }
    });

    it('should return empty array for empty text', () => {
      assert.strictEqual(wrapTextInElement('').length, 0);
      assert.strictEqual(wrapTextInElement(null).length, 0);
      assert.strictEqual(wrapTextInElement(undefined).length, 0);
    });
  });
});
