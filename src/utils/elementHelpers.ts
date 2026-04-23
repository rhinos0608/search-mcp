import { JSDOM } from 'jsdom';
import type { ContentElement } from '../types.js';
import { extractElementsFromHtml, MAX_TEXT_LENGTH, TRUNCATED_MARKER } from './htmlElements.js';
import { extractElementsFromMarkdown } from './markdownElements.js';

/**
 * Safely extracts content elements from an HTML string using JSDOM.
 * Ensures the DOM window is closed after extraction.
 */
export function safeExtractFromHtml(html: string | null | undefined): ContentElement[] {
  if (!html || html.trim().length === 0) return [];
  const dom = new JSDOM(html);
  try {
    return extractElementsFromHtml(dom.window.document);
  } finally {
    dom.window.close();
  }
}

/**
 * Extracts content elements from a markdown string.
 */
export function safeExtractFromMarkdown(markdown: string | null | undefined): ContentElement[] {
  if (!markdown || markdown.trim().length === 0) return [];
  try {
    return extractElementsFromMarkdown(markdown);
  } catch (error) {
    // Return empty list on failure rather than crashing
    return [];
  }
}

/**
 * Wraps plain text in a TextElement.
 */
export function wrapTextInElement(text: string | null | undefined): ContentElement[] {
  if (!text || text.trim().length === 0) return [];
  const trimmed = text.trim();
  const content =
    trimmed.length > MAX_TEXT_LENGTH
      ? trimmed.slice(0, MAX_TEXT_LENGTH) + TRUNCATED_MARKER
      : trimmed;
  return [{ type: 'text', text: content }];
}
