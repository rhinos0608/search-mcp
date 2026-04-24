import { JSDOM } from 'jsdom';
import type { ContentElement, StructuredContent } from '../types.js';
import { extractElementsFromHtml, MAX_ELEMENTS } from './htmlElements.js';
import { extractElementsFromMarkdown } from './markdownElements.js';
import { truncateElementText } from './elementTruncation.js';

interface IndexedElement {
  element: ContentElement;
  index: number;
}

function elementScore(element: ContentElement): number {
  switch (element.type) {
    case 'heading':
      return 100 + (7 - element.level);
    case 'table':
      return 90;
    case 'code':
      return 85;
    case 'list':
      return 75;
    case 'image':
      return 65;
    case 'text':
      return 50;
  }
}

export function finalizeStructuredContent(elements: ContentElement[]): StructuredContent {
  if (elements.length === 0) return {};
  if (elements.length <= MAX_ELEMENTS) return { elements };

  const selected = elements
    .map((element, index): IndexedElement => ({ element, index }))
    .sort((a, b) => {
      const scoreDelta = elementScore(b.element) - elementScore(a.element);
      if (scoreDelta !== 0) return scoreDelta;
      return a.index - b.index;
    })
    .slice(0, MAX_ELEMENTS)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.element);

  return {
    elements: selected,
    truncatedElements: true,
    originalElementCount: elements.length,
    omittedElementCount: elements.length - MAX_ELEMENTS,
  };
}

/**
 * Safely extracts finalized content elements from an HTML string using JSDOM.
 * Ensures the DOM window is closed after extraction.
 */
export function safeStructuredFromHtml(
  html: string | null | undefined,
  baseUrl?: string,
): StructuredContent {
  if (!html || html.trim().length === 0) return {};

  let dom: JSDOM | undefined;
  try {
    dom = baseUrl ? new JSDOM(html, { url: baseUrl }) : new JSDOM(html);
    return finalizeStructuredContent(extractElementsFromHtml(dom.window.document));
  } catch {
    return {};
  } finally {
    dom?.window.close();
  }
}

/**
 * Extracts finalized content elements from markdown.
 */
export function safeStructuredFromMarkdown(markdown: string | null | undefined): StructuredContent {
  if (!markdown || markdown.trim().length === 0) return {};
  try {
    return finalizeStructuredContent(extractElementsFromMarkdown(markdown));
  } catch {
    return {};
  }
}

/**
 * Wraps plain text in finalized structured content.
 */
export function wrapTextAsStructuredContent(text: string | null | undefined): StructuredContent {
  if (!text || text.trim().length === 0) return {};
  const trimmed = text.trim();
  const truncated = truncateElementText(trimmed);
  return finalizeStructuredContent([
    {
      type: 'text',
      text: truncated.value,
      ...(truncated.truncated && {
        truncated: truncated.truncated,
        originalLength: truncated.originalLength,
      }),
    },
  ]);
}

/**
 * Wraps code in finalized structured content.
 */
export function wrapCodeAsStructuredContent(
  content: string | null | undefined,
  language: string | null,
): StructuredContent {
  if (!content || content.trim().length === 0) return {};
  const truncated = truncateElementText(content);
  return finalizeStructuredContent([
    {
      type: 'code',
      language,
      content: truncated.value,
      ...(truncated.truncated && {
        truncated: truncated.truncated,
        originalLength: truncated.originalLength,
      }),
    },
  ]);
}

// Backward-compatible array helpers for any transitional consumers.
export function safeExtractFromHtml(html: string | null | undefined): ContentElement[] {
  return safeStructuredFromHtml(html).elements ?? [];
}

export function safeExtractFromMarkdown(markdown: string | null | undefined): ContentElement[] {
  return safeStructuredFromMarkdown(markdown).elements ?? [];
}

export function wrapTextInElement(text: string | null | undefined): ContentElement[] {
  return wrapTextAsStructuredContent(text).elements ?? [];
}
