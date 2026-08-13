/**
 * In-house document extraction seam.
 *
 * Handles text-like document URLs (txt, md, csv, json, xml) by fetching and
 * converting to markdown. Binary formats (pdf, office, images) return explicit
 * unsupported so existing fallback chains (Crawl4AI, Readability, Wayback) can
 * continue.
 *
 * When `config.documentParsing.enabled` is true, binary document URLs run a
 * tiered in-process pipeline instead of short-circuiting:
 *   1. HTML-first: try `documentFallbackUrls()` candidates (e.g. arxiv HTML
 *      twins, stripped-extension landing pages), convert fetched HTML to
 *      markdown via the existing Readability path.
 *   2. PDF: fetch bytes and run `parsePdf`.
 *   3. Office: fetch bytes and run `parseOffice` for office extensions.
 * If every tier yields nothing, the URL is returned as unsupported so
 * downstream Crawl4AI/Wayback fallbacks still run. When disabled (default),
 * binary URLs keep the exact legacy behavior: `{ unsupported: true }`, no fetch.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { assertSafeUrl } from '../httpGuards.js';
import { logger } from '../logger.js';
import { loadConfig, type SearchConfig } from '../config.js';
import { getUserAgent } from '../version.js';
import { parsePdf } from './documentParsers/pdf.js';
import { parseOffice } from './documentParsers/office.js';
import { describeVisuals } from './documentParsers/vlm.js';
import type { ParsedDocument } from './documentParsers/types.js';
import { documentFallbackUrls } from './documentUtils.js';

// ── Document extension sets ────────────────────────────────────────────────

/** Extensions for text documents we can fetch and convert inline. */
export const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.env',
]);

/** Extensions for binary documents we cannot extract (return unsupported). */
export const BINARY_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.tex',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.djvu',
]);

/** Office formats parseable in-process via `parseOffice` (Task 5 tier c).
 * Legacy binary extensions (.doc/.ppt/.xls) are intentionally excluded:
 * `officeparser` supports only the OOXML/ODF/RTF formats listed here, so those
 * legacy formats stay in BINARY_EXTENSIONS and reach the downstream fallback. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.odt', '.ods', '.odp', '.rtf']);

/** Scan-only image formats: no in-process text parser, and no HTML twin to probe. */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.djvu',
]);

/**
 * Maximum in-process document body size (bytes). Fetches that exceed this cap
 * (via Content-Length or accumulated stream bytes) are rejected up front so
 * parsers only ever receive bounded content. No config field exists for this
 * today, so the cap is a module-level constant.
 */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// ── Result types ───────────────────────────────────────────────────────────

export interface DocumentExtractionResult {
  markdown: string;
  title: string;
  success: boolean;
  /** true when the URL is a binary format we cannot extract inline. */
  unsupported: boolean;
  warnings: string[];
  /** Embedded images extracted from a parsed document (multimodal tier). */
  images?: ParsedDocument['images'];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getExtension(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dot = pathname.lastIndexOf('.');
    if (dot < 0) return undefined;
    return pathname.slice(dot);
  } catch {
    return undefined;
  }
}

function isTextExtension(url: string): boolean {
  const ext = getExtension(url);
  return ext !== undefined && TEXT_EXTENSIONS.has(ext);
}

function isBinaryExtension(url: string): boolean {
  const ext = getExtension(url);
  return ext !== undefined && BINARY_EXTENSIONS.has(ext);
}

/** Rough attempt to turn generic text/plain content into markdown. */
function wrapAsMarkdown(text: string, url: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';

  const ext = getExtension(url);

  // CSV → markdown table
  if (ext === '.csv') {
    const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return trimmed;
    const rows = lines.map((l) => l.split(',').map((c) => c.trim()));
    const header = rows[0];
    if (header === undefined) return trimmed;
    const separator = header.map(() => '---');
    const body = rows.slice(1);
    const tableRows = [header, separator, ...body].map((r) => `| ${r.join(' | ')} |`);
    return tableRows.join('\n');
  }

  // JSON → formatted with code fence
  if (ext === '.json') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
    } catch {
      return '```\n' + trimmed + '\n```';
    }
  }

  // XML → code fence
  if (ext === '.xml') {
    return '```xml\n' + trimmed + '\n```';
  }

  // YAML → code fence
  if (ext === '.yaml' || ext === '.yml') {
    return '```yaml\n' + trimmed + '\n```';
  }

  // Plain text / markdown — return as-is
  return trimmed;
}

/**
 * Convert fetched HTML to markdown using the repo's existing in-process
 * converter (`@mozilla/readability` + `jsdom`, the same pipeline webRead uses).
 * Readability's cleaned `textContent` is the established markdown
 * representation used by `readabilityFallbackResult`. Never throws.
 */
function htmlToMarkdown(html: string, url: string): { markdown: string; title: string } {
  try {
    const dom = new JSDOM(html, { url });
    try {
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      const markdown = (article?.textContent ?? '').trim();
      const title = (article?.title ?? '').trim();
      return { markdown, title };
    } finally {
      dom.window.close();
    }
  } catch {
    return { markdown: '', title: '' };
  }
}

/**
 * Fetch a candidate HTML page as a bounded stream. Returns null on any
 * failure/non-HTML/empty, or when the body exceeds MAX_DOCUMENT_BYTES (rejected
 * immediately on Content-Length, or aborted mid-stream once accumulated bytes
 * exceed the cap).
 */
async function tryFetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  try {
    assertSafeUrl(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': getUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;
    if (contentLengthExceedsLimit(response, url)) return null;
    const html = await readCappedBody(response, url);
    if (html === null) return null;
    return html.trim().length === 0 ? null : html;
  } catch {
    return null;
  }
}

/**
 * Fetch raw bytes of a binary document as a bounded stream. Returns null on
 * any failure/empty/oversized body (see MAX_DOCUMENT_BYTES).
 */
async function tryFetchBytes(url: string, timeoutMs: number): Promise<ArrayBuffer | null> {
  try {
    assertSafeUrl(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': getUserAgent(),
        Accept: 'application/octet-stream,*/*',
      },
    });
    if (!response.ok) return null;
    if (contentLengthExceedsLimit(response, url)) return null;
    const bytes = await readCappedBytes(response, url);
    return bytes === null || bytes.byteLength === 0 ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Reject up front when the response advertises a Content-Length over the cap.
 */
function contentLengthExceedsLimit(response: Response, url: string): boolean {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return false;
  const len = Number.parseInt(contentLength, 10);
  if (Number.isNaN(len)) return false;
  if (len > MAX_DOCUMENT_BYTES) {
    logger.debug(
      { url, length: len, max: MAX_DOCUMENT_BYTES },
      'documentExtraction: response too large (Content-Length)',
    );
    return true;
  }
  return false;
}

/**
 * Read a response body as text, aborting once accumulated bytes exceed
 * MAX_DOCUMENT_BYTES. Returns null on overflow.
 */
async function readCappedBody(response: Response, url: string): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No stream available (e.g. mocked Response): fall back with a post-hoc cap.
    const text = await response.text();
    return text.length > MAX_DOCUMENT_BYTES ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      reader.cancel().catch(() => {
        /* discard */
      });
      logger.debug(
        { url, max: MAX_DOCUMENT_BYTES },
        'documentExtraction: response exceeded size cap',
      );
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Read a response body as bytes, aborting once accumulated bytes exceed
 * MAX_DOCUMENT_BYTES. Returns null on overflow.
 */
async function readCappedBytes(response: Response, url: string): Promise<ArrayBuffer | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > MAX_DOCUMENT_BYTES ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      reader.cancel().catch(() => {
        /* discard */
      });
      logger.debug(
        { url, max: MAX_DOCUMENT_BYTES },
        'documentExtraction: response exceeded size cap',
      );
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

// ── Text document extraction (legacy path) ─────────────────────────────────

async function extractTextDocument(
  url: string,
  timeoutMs: number,
  warnings: string[],
): Promise<DocumentExtractionResult> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'text/plain, text/markdown, text/csv, application/json, application/xml, */*',
      },
    });

    if (!response.ok) {
      const msg = `HTTP ${String(response.status)} ${response.statusText}`;
      warnings.push(msg);
      logger.warn({ url, status: response.status }, 'documentExtraction: fetch failed');
      return { markdown: '', title: '', success: false, unsupported: false, warnings };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (text.length === 0) {
      warnings.push('Document returned empty content');
      return { markdown: '', title: '', success: false, unsupported: false, warnings };
    }

    const markdown = wrapAsMarkdown(text, url);
    const ext = getExtension(url);
    logger.info(
      { url, contentType, bytes: text.length, ext },
      'documentExtraction: extracted text document',
    );

    return {
      markdown,
      title: '',
      success: markdown.length > 0,
      unsupported: false,
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(msg);
    logger.warn({ url, err: msg }, 'documentExtraction: fetch/convert failed');
    return { markdown: '', title: '', success: false, unsupported: false, warnings };
  }
}

// ── Multimodal visuals append helper ───────────────────────────────────────

/**
 * Append a `### Figures & visuals` section when multimodal vision produced
 * non-empty snippets. Pure and side-effect free so it can be unit-tested in
 * isolation; returns `markdown` unchanged when `snippets` is empty.
 */
export function appendVisualsSection(markdown: string, snippets: string[]): string {
  if (snippets.length === 0) return markdown;
  return `${markdown}\n\n### Figures & visuals\n\n${snippets.join('\n\n')}`;
}

// ── Tiered binary document pipeline (config-gated) ─────────────────────────

async function extractBinaryDocument(
  url: string,
  ext: string,
  timeoutMs: number,
  warnings: string[],
  config: SearchConfig,
): Promise<DocumentExtractionResult> {
  const deadline = Date.now() + timeoutMs;
  const remainingBudget = (): number => Math.max(0, deadline - Date.now());

  // Tier a. HTML-first: try HTML-twin / landing-page candidates.
  // Scan-only image formats have no text twin worth probing, so skip the loop.
  if (!IMAGE_EXTENSIONS.has(ext)) {
    for (const candidate of documentFallbackUrls(url)) {
      if (isBinaryExtension(candidate)) continue; // only HTML-looking candidates
      const html = await tryFetchHtml(candidate, remainingBudget());
      if (html === null) {
        logger.debug({ url, candidate }, 'documentExtraction: HTML fallback candidate unavailable');
        continue;
      }
      const { markdown, title } = htmlToMarkdown(html, candidate);
      if (markdown.length > 0) {
        warnings.push(`Extracted content from HTML fallback: ${candidate}`);
        logger.info({ url, candidate }, 'documentExtraction: extracted via HTML fallback tier');
        return { markdown, title, success: true, unsupported: false, warnings, images: [] };
      }
      logger.debug(
        { url, candidate },
        'documentExtraction: HTML fallback candidate yielded no readable content',
      );
    }
    // Terminal HTML failure: a single user-visible note after all candidates fail.
    warnings.push('HTML fallback yielded no readable content');
  }

  // Tier b. PDF.
  if (ext === '.pdf') {
    const bytes = await tryFetchBytes(url, remainingBudget());
    if (bytes !== null) {
      const parsed = await parsePdf(bytes);
      warnings.push(...parsed.warnings);
      if (parsed.markdown.trim().length > 0) {
        logger.info({ url }, 'documentExtraction: extracted PDF document');
        // Include extracted tables as markdown pipe tables, appended once to
        // avoid duplicating content already emitted by the text tier.
        let markdown = parsed.markdown;
        if (parsed.tables.length > 0) {
          markdown = `${markdown}\n\n${parsed.tables.join('\n\n')}`;
        }
        // Opt-in multimodal tier: describe figures / transcribe complex tables
        // via the configured vision LLM. No-op when multimodal is off.
        if (config.documentParsing.multimodal) {
          const visual = await describeVisuals(parsed, new Uint8Array(bytes), config);
          if (visual.snippets.length > 0) {
            markdown = appendVisualsSection(markdown, visual.snippets);
          } else if (visual.warning !== undefined) {
            warnings.push(visual.warning);
          } else {
            warnings.push(
              'Multimodal figure/table description requested but produced no output ' +
                '(no figures found, or the vision LLM / rasterizer is unavailable).',
            );
          }
        }
        // Attach images (may be an empty array) so the multimodal tier can use them.
        return {
          markdown,
          title: parsed.title,
          success: true,
          unsupported: false,
          warnings,
          images: parsed.images,
        };
      }
    }
  }

  // Tier c. Office.
  if (OFFICE_EXTENSIONS.has(ext)) {
    const bytes = await tryFetchBytes(url, remainingBudget());
    if (bytes !== null) {
      const parsed = await parseOffice(bytes, ext, undefined, { timeoutMs: remainingBudget() });
      warnings.push(...parsed.warnings);
      if (parsed.markdown.trim().length > 0) {
        logger.info({ url, ext }, 'documentExtraction: extracted office document');
        return {
          markdown: parsed.markdown,
          title: parsed.title,
          success: true,
          unsupported: false,
          warnings,
          ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
        };
      }
    }
  }

  // Tier d. Nothing usable — keep the URL unsupported so downstream
  // Crawl4AI/Wayback fallbacks still run.
  warnings.push(`No document content could be extracted from ${url}`);
  return { markdown: '', title: '', success: false, unsupported: true, warnings };
}

// ── Main extraction function ───────────────────────────────────────────────

/**
 * Extract content from a document URL.
 *
 * - Text-like URLs (txt, md, csv, json, xml, yaml, …): fetch and return
 *   content wrapped as markdown.
 * - Binary URLs (pdf, docx, images, …): when `documentParsing.enabled`, run
 *   the tiered in-process pipeline; otherwise return `{ unsupported: true }`
 *   so callers can fall through to other extraction methods.
 * - Non-document URLs (html, etc.): return unsupported (Crawl4AI/webRead
 *   handle these).
 *
 * @param options  Optional timeout and an explicit config. When `config` is
 *   omitted, `loadConfig()` is used (preserving back-compat for callers that
 *   pass only `{ timeoutMs }`).
 */
export async function extractDocumentUrl(
  url: string,
  options?: { timeoutMs?: number; config?: SearchConfig },
): Promise<DocumentExtractionResult> {
  const warnings: string[] = [];

  // Validate URL safety
  try {
    assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url, err: msg }, 'documentExtraction: unsafe URL');
    return { markdown: '', title: '', success: false, unsupported: true, warnings: [msg] };
  }

  const ext = getExtension(url);

  // Non-document (HTML, etc.) — not our responsibility
  if (ext === undefined || (!isTextExtension(url) && !isBinaryExtension(url))) {
    return { markdown: '', title: '', success: false, unsupported: true, warnings };
  }

  // Text document — fetch and convert
  if (isTextExtension(url)) {
    return extractTextDocument(url, options?.timeoutMs ?? 30_000, warnings);
  }

  // Binary document — config-gated tiered pipeline
  const config = options?.config ?? loadConfig();
  if (!config.documentParsing.enabled) {
    logger.debug({ url, ext }, 'documentExtraction: binary format, unsupported');
    return { markdown: '', title: '', success: false, unsupported: true, warnings };
  }

  return extractBinaryDocument(url, ext, options?.timeoutMs ?? 30_000, warnings, config);
}

/**
 * Fetch and Readability-parse an HTML page into markdown. SSRF-guarded by
 * `tryFetchHtml` (which runs `assertSafeUrl`) and bounded by the same size
 * cap. Returns null when the page is unavailable, non-HTML, oversized, or
 * yields no readable article. Never throws.
 */
export async function extractHtmlPage(
  url: string,
  options?: { timeoutMs?: number },
): Promise<{ markdown: string; title: string; rawHtml: string } | null> {
  const html = await tryFetchHtml(url, options?.timeoutMs ?? 30_000);
  if (html === null) return null;
  const { markdown, title } = htmlToMarkdown(html, url);
  if (markdown.trim().length === 0) return null;
  return { markdown: markdown.trim(), title, rawHtml: html };
}
