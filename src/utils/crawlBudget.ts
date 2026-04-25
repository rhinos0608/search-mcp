export const RESPONSE_CAP_BYTES = 52 * 1024 * 1024;
export const SAFE_BYTES = Math.floor(RESPONSE_CAP_BYTES * 0.8);
export const DEFAULT_AVG_PAGE_BYTES = 1.5 * 1024 * 1024;
export const JS_HEAVY_AVG_PAGE_BYTES = 8 * 1024 * 1024;

type SourceType = 'url' | 'sitemap' | 'search' | 'github' | 'cached';

const KNOWN_HEAVY_HOSTNAMES = new Set([
  'seek.com.au',
  'www.seek.com.au',
  'au.indeed.com',
  'indeed.com',
  'www.indeed.com',
  'au.linkedin.com',
  'www.linkedin.com',
  'linkedin.com',
  'au.jora.com',
  'www.jora.com',
  'jora.com',
]);

// Paths and params that strongly suggest a listing/search page.
const LISTING_PATTERN =
  /[/?&](search|jobs|jobsearch|results|listings|products|catalog|category|marketplace|q|query|keywords|page|sort|filter)\b/i;

/**
 * Conservative pre-crawl heuristic for response-size budgeting.
 * Returns true when the crawl target is likely to produce large per-page payloads.
 *
 * Signal priority:
 *   1. Source type: 'search' is always JS-heavy.
 *   2. Known-heavy hostname: small evidence-driven list of observed offenders.
 *   3. URL listing/search pattern: path or param suggests paginated results.
 *
 * False negatives are acceptable — the in-flight byte accumulator is the authoritative guard.
 */
export function isLikelyJsHeavySite(opts: { sourceType: SourceType; url?: string }): boolean {
  if (opts.sourceType === 'search') return true;

  if (opts.url === undefined) return false;

  try {
    const { hostname } = new URL(opts.url);
    if (KNOWN_HEAVY_HOSTNAMES.has(hostname)) return true;
  } catch {
    return false;
  }

  return LISTING_PATTERN.test(opts.url);
}

export function estimateSerializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
