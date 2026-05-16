/**
 * Lightweight URL preselection for sitemap mode.
 *
 * This intentionally ranks URL paths before crawling, so large sitemaps spend
 * the crawl budget on URLs that are likely to contain the requested topic.
 */

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'official',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function urlTokens(url: string): { path: string; segments: string[]; fileStem: string } | null {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    const segments = path.split('/').filter(Boolean);
    const last = segments.at(-1) ?? '';
    const fileStem = last.replace(/\.[a-z0-9]+$/iu, '');
    return { path, segments, fileStem };
  } catch {
    return null;
  }
}

function scoreUrl(url: string, queryTerms: string[]): number {
  const parts = urlTokens(url);
  if (parts === null) return Number.NEGATIVE_INFINITY;

  let score = 0;
  for (const term of queryTerms) {
    if (parts.path.includes(term)) score += 4;
    if (parts.fileStem.includes(term)) score += 6;
    for (const segment of parts.segments.slice(0, -1)) {
      if (segment.includes(term)) score += 2;
    }
  }

  // Prefer focused docs pages over high-level index/community pages when the
  // query terms are present in both.
  if (/\b(docs?|reference|specification|security|guide|learn)\b/u.test(parts.path)) score += 1;
  if (/\b(blog|community|governance|news|events|authors|tags)\b/u.test(parts.path)) score -= 2;

  score -= parts.segments.length * 0.05;
  return score;
}

export function rankSitemapUrls(urls: string[], query: string): string[] {
  const queryTerms = tokenize(query);
  if (urls.length <= 1 || queryTerms.length === 0) return urls;

  return urls
    .map((url, index) => ({ url, index, score: scoreUrl(url, queryTerms) }))
    .sort((a, b) => {
      const delta = b.score - a.score;
      if (delta !== 0) return delta;
      return a.index - b.index;
    })
    .map((entry) => entry.url);
}
