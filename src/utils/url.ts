import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { CrawlPageResult } from '../types.js';

/** Known tracking / attribution query params that don't affect page content. */
export const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'ref',
  'source',
  'mc_cid',
  'mc_eid',
]);

/** Normalize a URL for dedup: lowercase hostname, strip default ports,
 *  trailing slash, fragments, and tracking query params. */
export function normalizeUrl(raw: string): string {
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Malformed URL — do best-effort normalization without URL parser
    logger.debug({ url: raw }, 'web_crawl dedup: malformed URL, using raw form');
    return raw.replace(/\/+$/, '').toLowerCase();
  }

  u.hostname = u.hostname.toLowerCase();

  // Strip www. prefix
  if (u.hostname.startsWith('www.')) {
    u.hostname = u.hostname.slice(4);
  }

  // Remove default ports
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  // Strip trailing slash (but keep root "/")
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  // Strip fragments — same page content regardless of anchor
  u.hash = '';

  // Strip known tracking params, keep everything else
  const toDelete: string[] = [];
  u.searchParams.forEach((_val, key) => {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) {
    u.searchParams.delete(key);
  }

  return u.toString();
}

/**
 * Deduplicate pages by normalized URL, keeping the first occurrence.
 * Call before `dedupPagesByContent` for two-pass dedup (URL then content).
 */
export function dedupPages(pages: CrawlPageResult[]): CrawlPageResult[] {
  const seen = new Set<string>();
  const out: CrawlPageResult[] = [];
  for (const page of pages) {
    const key = normalizeUrl(page.url);
    // Skip empty-URL pages from dedup set (e.g. failed pages with no URL)
    if (key === '') {
      out.push(page);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(page);
    }
  }
  return out;
}

/**
 * Deduplicate pages by SHA-256 content hash, keeping the first occurrence.
 * Empty-markdown pages (error pages) are always kept — they're not deduplicated.
 * Call this *after* `dedupPages` so URL-level dedup is already done.
 */
export function dedupPagesByContent(pages: CrawlPageResult[]): CrawlPageResult[] {
  const seen = new Set<string>();
  const out: CrawlPageResult[] = [];
  for (const page of pages) {
    // Skip empty-markdown pages (error pages) — keep them all
    if (page.markdown === '') {
      out.push(page);
      continue;
    }
    const hash = createHash('sha256').update(page.markdown).digest('hex');
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(page);
    }
  }
  return out;
}
