import { decodeHtmlEntities } from './html.js';

const SITEMAP_INDEX_RE = /<sitemapindex\b/i;
const LOC_RE = /<loc>([^<]*)<\/loc>/gi;

/** Detect whether XML is a sitemap index (contains sub-sitemaps) vs a urlset. */
export function isSitemapIndex(xml: string): boolean {
  return SITEMAP_INDEX_RE.test(xml);
}

/**
 * Parse a sitemap XML string (either urlset or sitemapindex) and return
 * an array of unique <loc> URLs in document order.
 *
 * Uses regex extraction — the sitemap schema is unambiguous for <loc> tags.
 * Decodes XML entities (e.g. &amp; → &).
 */
export async function parseSitemap(xml: string): Promise<string[]> {
  if (!xml || xml.trim().length === 0) return [];

  const urls: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  LOC_RE.lastIndex = 0;
  while ((match = LOC_RE.exec(xml)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const decoded = decodeHtmlEntities(raw.trim());
    if (decoded && !seen.has(decoded)) {
      seen.add(decoded);
      urls.push(decoded);
    }
  }

  return urls;
}
