/** Max appended PDF results across the whole enrichment pass. */
const MAX_APPENDED_PDFS = 2;

/** Regex matching an HTML `<a href="...">` whose target ends in `.pdf`. */
const HTML_PDF_LINK_RE = /<a\s[^>]*href\s*=\s*["']([^"']+\.pdf)["'][^>]*>/gi;

/** Regex matching a markdown link whose target ends in `.pdf`. */
const MARKDOWN_PDF_LINK_RE = /\[([^\]]*)\]\(([^)]+\.pdf)\)/gi;

/** Regex matching a bare URL ending in `.pdf` (not inside a markdown link). */
const BARE_PDF_URL_RE = /\b(https?:\/\/[^\s<>"')\]]+\.pdf)\b/gi;

/**
 * Two hostnames are considered same-site when one is a suffix of the other
 * (after stripping a leading `www.`). This handles `cdn.openai.com` ↔
 * `openai.com` without needing a full public-suffix list.
 */
function sameSite(a: string, b: string): boolean {
  const na = a.replace(/^www\./, '');
  const nb = b.replace(/^www\./, '');
  return na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`) || na === nb;
}

/**
 * Discover same-site `.pdf` links in extracted markdown.
 * Returns deduplicated absolute URLs, at most `maxLinks`.
 */
export function discoverPdfLinks(raw: string, parentUrl: string, maxLinks: number): string[] {
  const parentHost = (() => {
    try {
      return new URL(parentUrl).hostname;
    } catch {
      return null;
    }
  })();
  if (parentHost === null) return [];

  const seen = new Set<string>();
  const candidates: string[] = [];

  const addCandidate = (raw: string) => {
    let url: string;
    let host: string;
    try {
      const parsed = new URL(raw, parentUrl);
      url = parsed.href;
      host = parsed.hostname;
    } catch {
      return;
    }
    if (!url.startsWith('https:') && !url.startsWith('http:')) return;
    if (!sameSite(host, parentHost)) return;
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push(url);
  };

  for (const match of raw.matchAll(HTML_PDF_LINK_RE)) {
    if (candidates.length >= maxLinks) break;
    const href = match[1];
    if (href !== undefined) addCandidate(href);
  }
  if (candidates.length < maxLinks) {
    for (const match of raw.matchAll(MARKDOWN_PDF_LINK_RE)) {
      if (candidates.length >= maxLinks) break;
      const href = match[2];
      if (href !== undefined) addCandidate(href);
    }
  }
  if (candidates.length < maxLinks) {
    for (const match of raw.matchAll(BARE_PDF_URL_RE)) {
      if (candidates.length >= maxLinks) break;
      const href = match[1];
      if (href !== undefined) addCandidate(href);
    }
  }
  return candidates;
} /**
 * Auto-enrich thin document-snippet search results (trigger A, capped).
 *
 * After `web_search` ranks results, this module fetches + parses the full
 * document for the top-ranked results whose URL points at a document file
 * (PDF/office/text) and whose `contentKind` is a thin snippet. The parsed
 * markdown replaces the snippet `description`, and the result is marked
 * `contentKind: 'full'`.
 *
 * Gated by `cfg.documentParsing.enabled` — when disabled this is a cheap no-op
 * that returns the input array untouched (never issues a fetch). Enrichment is
 * bounded by `cfg.documentParsing.maxEnrich`, only touches results already
 * within the user-visible `limit` window, runs the fetches in parallel, and
 * isolates per-result failures (a failing/unsupported extraction leaves the
 * original snippet intact; this function never throws).
 */

import { extractDocumentUrl, extractHtmlPage } from '../utils/documentExtraction.js';
import { isDocumentUrl } from '../utils/documentUtils.js';
import { logger } from '../logger.js';
import type { SearchConfig } from '../config.js';
import type { SearchResult } from '../types.js';

/** Max characters for a single enriched document description before trimming. */
export const ENRICH_DESCRIPTION_CHAR_CAP = 8000;
/** Thin HTML snippets below this description length get full-page enrichment. */
export const THIN_SNIPPET_CHAR_THRESHOLD = 200;
const ELLIPSIS = '…';
/** Per-page fetch bound for thin-HTML enrichment. Kept short: this runs on the
 * interactive search path, and a slow page simply retains its original snippet
 * (failures are isolated) rather than stalling the whole response. */
const HTML_EXTRACT_TIMEOUT_MS = 8_000;

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isThinHtml(result: SearchResult): boolean {
  const combinedLength = (result.description + (result.extraSnippet ?? '')).trim().length;
  return (
    result.contentKind === 'snippet' &&
    combinedLength < THIN_SNIPPET_CHAR_THRESHOLD &&
    !isDocumentUrl(result.url) &&
    isHttpUrl(result.url)
  );
}

/**
 * Cap a parsed document's markdown to a sane character bound. When trimmed,
 * cut on the last word boundary within the budget and append an ellipsis note
 * so consumers know the inline description is not the full document.
 */
function trimDescription(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let head = text.slice(0, cap);
  const space = head.lastIndexOf(' ');
  if (space > 0) head = head.slice(0, space);
  return `${head}${ELLIPSIS}\n\n[truncated: full document exceeds inline budget]`;
}

export async function enrichDocumentSnippets(
  results: SearchResult[],
  cfg: SearchConfig,
  limit: number,
): Promise<SearchResult[]> {
  // Disabled → identical behavior (no fetches).
  if (!cfg.documentParsing.enabled) return results;

  const window = results.slice(0, limit);
  const cap = Math.max(0, cfg.documentParsing.maxEnrich);

  // Select the top-ranked qualifying results (document URLs OR thin HTML
  // snippets), bounded by maxEnrich. Only results the user will actually see
  // (first `limit`) are considered.
  const selected: { index: number; result: SearchResult; isDoc: boolean }[] = [];
  for (let i = 0; i < window.length && selected.length < cap; i += 1) {
    const result = window[i];
    if (result === undefined) continue;
    const isDoc = isDocumentUrl(result.url);
    if (!isDoc && !isThinHtml(result)) continue;
    // Only thin snippets are enriched; full/summary content is left alone.
    if (result.contentKind === 'full' || result.contentKind === 'summary') continue;
    selected.push({ index: i, result, isDoc });
  }

  if (selected.length === 0) return results;

  // Run fetches in parallel; per-result failures are isolated and never throw.
  const enriched: {
    index: number;
    updated: SearchResult | null;
    rawHtml?: string | undefined;
  }[] = await Promise.all(
    selected.map(async ({ index, result, isDoc }) => {
      try {
        let markdown: string;
        let rawHtml: string | undefined;
        if (isDoc) {
          const parsed = await extractDocumentUrl(result.url, { config: cfg });
          if (!(parsed.success && parsed.markdown.trim().length > 0)) {
            return { index, updated: null };
          }
          markdown = parsed.markdown;
        } else {
          const page = await extractHtmlPage(result.url, { timeoutMs: HTML_EXTRACT_TIMEOUT_MS });
          if (page === null) return { index, updated: null };
          markdown = page.markdown;
          rawHtml = page.rawHtml;
        }
        return {
          index,
          updated: {
            ...result,
            description: trimDescription(markdown.trim(), ENRICH_DESCRIPTION_CHAR_CAP),
            contentKind: 'full' as const,
          },
          rawHtml,
        };
      } catch (err) {
        logger.warn({ err, url: result.url }, 'webSearchDocEnrich: enrichment failed (isolated)');
      }
      return { index, updated: null };
    }),
  );

  const output = [...results];
  for (const { index, updated } of enriched) {
    if (updated !== null) output[index] = updated;
  }

  // ── PDF discovery: scan enriched HTML for same-site .pdf links ──────
  const existingUrls = new Set(output.map((r) => r.url));
  const appended: SearchResult[] = [];
  for (const { index, updated, rawHtml } of enriched) {
    if (appended.length >= MAX_APPENDED_PDFS) break;
    if (updated === null || rawHtml === undefined) continue;
    const parent = results[index];
    if (parent === undefined) continue;
    const pdfUrls = discoverPdfLinks(rawHtml, parent.url, MAX_APPENDED_PDFS - appended.length);
    for (const pdfUrl of pdfUrls) {
      if (appended.length >= MAX_APPENDED_PDFS) break;
      if (existingUrls.has(pdfUrl)) continue;
      try {
        const parsed = await extractDocumentUrl(pdfUrl, { config: cfg });
        if (!(parsed.success && parsed.markdown.trim().length > 0)) continue;
        existingUrls.add(pdfUrl);
        appended.push({
          title: `[PDF] ${parent.title}`,
          url: pdfUrl,
          description: trimDescription(parsed.markdown.trim(), ENRICH_DESCRIPTION_CHAR_CAP),
          position: 0, // reassigned by the caller
          domain: new URL(pdfUrl).hostname,
          source: parent.source,
          engines: parent.engines,
          age: parent.age,
          extraSnippet: null,
          deepLinks: null,
          contentKind: 'full' as const,
        });
      } catch (err) {
        logger.warn({ err, url: pdfUrl }, 'webSearchDocEnrich: PDF discovery failed (isolated)');
      }
    }
  }
  if (appended.length > 0) {
    output.push(...appended);
  }

  return output;
}
