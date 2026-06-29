/**
 * In-house DocumentExtraction seam.
 *
 * In-house document extraction seam. Handles text-like document URLs (txt, md,
 * csv, json, xml) by fetching and converting to markdown. Binary formats
 * (pdf, office, images) return explicit unsupported so existing fallback
 * chains (Crawl4AI, Readability, Wayback) can continue.
 */

import { assertSafeUrl } from '../httpGuards.js';
import { logger } from '../logger.js';

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

// ── Result types ───────────────────────────────────────────────────────────

export interface DocumentExtractionResult {
  markdown: string;
  title: string;
  success: boolean;
  /** true when the URL is a binary format we cannot extract inline. */
  unsupported: boolean;
  warnings: string[];
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

// ── Main extraction function ───────────────────────────────────────────────

/**
 * Extract content from a document URL.
 *
 * - Text-like URLs (txt, md, csv, json, xml, yaml, …): fetch and return
 *   content wrapped as markdown.
 * - Binary URLs (pdf, docx, images, …): return `{ unsupported: true }` so
 *   callers can fall through to other extraction methods.
 * - Non-document URLs (html, etc.): return unsupported (Crawl4AI/webRead
 *   handle these).
 */
export async function extractDocumentUrl(
  url: string,
  options?: { timeoutMs?: number },
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

  // Binary document — explicit unsupported
  if (ext !== undefined && isBinaryExtension(url)) {
    logger.debug({ url, ext }, 'documentExtraction: binary format, unsupported');
    return { markdown: '', title: '', success: false, unsupported: true, warnings };
  }

  // Non-document (HTML, etc.) — not our responsibility
  if (ext === undefined || (!isTextExtension(url) && !isBinaryExtension(url))) {
    return { markdown: '', title: '', success: false, unsupported: true, warnings };
  }

  // Text document — fetch and convert
  const timeoutMs = options?.timeoutMs ?? 30_000;
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
