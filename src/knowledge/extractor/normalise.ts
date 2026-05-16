/**
 * V7.0.0 — Content normaliser for knowledge graph extraction.
 *
 * Transforms raw tool results into a standardised `NormalizedExtractionInput`
 * shape that the extractor pipeline can consume. Each tool adapter extracts
 * text content, URL, title, and source kind from the tool's result format.
 */

import { logger } from '../../logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/**
 * Source kind classification for KG sources.
 *
 * Matches the `kg_sources.source_kind` column and the spec taxonomy.
 */
export type SourceKind =
  | 'primary_doc'
  | 'official_release'
  | 'research_paper'
  | 'documentation'
  | 'news'
  | 'blog'
  | 'forum'
  | 'social'
  | 'code_repo'
  | 'package_registry'
  | 'unknown';

/**
 * Standardised input for the knowledge graph extractor.
 */
export interface NormalizedExtractionInput {
  /** The extracted/cleaned text content. */
  text: string;
  /** Source URL (if available). */
  url: string | undefined;
  /** Page/article title (if available). */
  title: string | undefined;
  /** Classification of the source type. */
  sourceKind: SourceKind;
  /** ISO-8601 timestamp of when the content was retrieved. */
  retrievedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// Tool-to-SourceKind mapping
// ────────────────────────────────────────────────────────────────────

/**
 * Map a tool name to its likely source kind.
 */
function toolToSourceKind(toolName: string): SourceKind {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('web_search') || lower.startsWith('web_read') || lower.startsWith('web_crawl') || lower.startsWith('semantic_crawl')) {
    return 'documentation'; // generic web content
  }
  if (lower.startsWith('reddit')) return 'forum';
  if (lower.startsWith('youtube')) return 'social';
  if (lower.startsWith('github')) return 'code_repo';
  if (lower.startsWith('npm') || lower.startsWith('pypi')) return 'package_registry';
  if (lower.startsWith('academic') || lower.startsWith('arxiv')) return 'research_paper';
  if (lower.startsWith('hackernews') || lower.startsWith('stackoverflow')) return 'forum';
  if (lower.startsWith('research')) return 'research_paper';
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────
// Per-tool adapters
// ────────────────────────────────────────────────────────────────────

/**
 * Attempt to extract text content from a tool result.
 *
 * Handles various result shapes:
 * - `{ content: string }` — raw text
 * - `{ results: Array<{ content: string, url?: string, title?: string }> }` — web search results
 * - `{ articles: Array<{ content: string, url?: string, title?: string }> }` — web read results
 * - `{ pages: Array<{ content: string, url?: string, title?: string }> }` — crawl results
 * - `{ transcript: string, title?: string }` — YouTube transcript
 * - `{ posts: Array<{ content: string, url?: string, title?: string }> }` — Reddit/HN
 * - `{ items: Array<{ content: string, url?: string, title?: string }> }` — generic items
 */
function extractFromToolResult(
  toolName: string,
  result: Record<string, unknown>,
): { text: string; url: string | undefined; title: string | undefined } | null {
  const tool = toolName.toLowerCase();

  // ── Direct content fields ──
  if (typeof result.content === 'string' && result.content.trim().length > 0) {
    return {
      text: result.content,
      url: typeof result.url === 'string' ? result.url : undefined,
      title: typeof result.title === 'string' ? result.title : undefined,
    };
  }

  // ── Array-based results ──
  const arraysToTry: unknown[] = Array.isArray(result) ? [result] : [];
  for (const key of ['results', 'articles', 'pages', 'posts', 'items', 'data']) {
    arraysToTry.push(result[key]);
  }

  for (const arr of arraysToTry) {
    if (!Array.isArray(arr) || arr.length === 0) continue;

    // Concatenate all text content from the array
    const parts: string[] = [];
    let firstUrl: string | undefined;
    let firstTitle: string | undefined;

    for (const item of arr) {
      if (item === null || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const itemParts: string[] = [];

      for (const key of ['content', 'text', 'textContent', 'snippet', 'description', 'extraSnippet']) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim().length > 0) {
          itemParts.push(value.trim());
        }
      }

      if (itemParts.length > 0) {
        parts.push(itemParts.join('\n'));
      }

      if (firstUrl === undefined && typeof obj.url === 'string') {
        firstUrl = obj.url;
      }
      if (firstTitle === undefined && typeof obj.title === 'string') {
        firstTitle = obj.title;
      }
    }

    if (parts.length > 0) {
      return {
        text: parts.join('\n\n'),
        url: firstUrl,
        title: firstTitle ?? `${tool} results`,
      };
    }
  }

  // ── YouTube transcript specific ──
  if (tool.startsWith('youtube') && typeof result.transcript === 'string') {
    return {
      text: result.transcript,
      url: typeof result.url === 'string' ? result.url : undefined,
      title: typeof result.title === 'string' ? result.title : 'YouTube transcript',
    };
  }

  // ── Semantic crawl ──
  if (tool.startsWith('semantic_crawl')) {
    // semantic_crawl may have pages or a top-level text
    if (typeof result.text === 'string' && result.text.trim().length > 0) {
      return {
        text: result.text,
        url: typeof result.url === 'string' ? result.url : undefined,
        title: typeof result.title === 'string' ? result.title : undefined,
      };
    }
  }

  // ── GitHub repository result ──
  if (tool.startsWith('github')) {
    if (typeof result.readme === 'string') {
      return {
        text: result.readme,
        url: typeof result.url === 'string' ? result.url : undefined,
        title: typeof result.full_name === 'string' ? result.full_name : undefined,
      };
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Normalise a tool result into a standardised extraction input.
 *
 * Returns null if the result content is empty, only whitespace, or
 * cannot be mapped to any known tool output shape.
 */
export function normalizeToolResult(
  toolName: string,
  result: unknown,
): NormalizedExtractionInput | null {
  if (result === null || result === undefined || typeof result !== 'object') {
    logger.warn({ toolName }, 'kg: normalizeToolResult received non-object result');
    return null;
  }

  const obj = result as Record<string, unknown>;
  const extracted = extractFromToolResult(toolName, obj);

  if (extracted === null) {
    logger.warn({ toolName }, 'kg: normalizeToolResult could not extract text from result');
    return null;
  }

  const text = extracted.text.trim();
  if (text.length === 0) {
    logger.warn({ toolName }, 'kg: normalizeToolResult extracted empty text');
    return null;
  }

  return {
    text,
    url: extracted.url,
    title: extracted.title,
    sourceKind: toolToSourceKind(toolName),
    retrievedAt: new Date().toISOString(),
  };
}
