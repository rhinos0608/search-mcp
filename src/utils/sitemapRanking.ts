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

const LOCALE_RE = /^[a-z]{2}(?:-[a-z]{2})?$/u;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function normalizeLocale(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/gu, '-');
  return LOCALE_RE.test(normalized) ? normalized : undefined;
}

function extractLocaleFromUrl(parsed: URL): string | undefined {
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const firstSegment = normalizeLocale(pathSegments[0]);
  if (firstSegment !== undefined) return firstSegment;

  const localeParams = ['lang', 'locale', 'hl'];
  for (const param of localeParams) {
    const value = normalizeLocale(parsed.searchParams.get(param) ?? undefined);
    if (value !== undefined) return value;
  }

  const hostPrefix = parsed.hostname.split('.')[0];
  // Skip known non-locale subdomain tokens
  if (hostPrefix && ['www', 'api', 'cdn', 'static', 'assets'].includes(hostPrefix)) {
    return undefined;
  }
  return hostPrefix ? normalizeLocale(hostPrefix) : undefined;
}

function stripLocaleFromUrl(parsed: URL): string {
  const next = new URL(parsed.toString());
  const segments = next.pathname.split('/').filter(Boolean);
  if (segments.length > 0 && normalizeLocale(segments[0]) !== undefined) {
    segments.shift();
    next.pathname = '/' + segments.join('/');
  }
  for (const key of ['lang', 'locale', 'hl']) {
    next.searchParams.delete(key);
  }
  return next.origin.toLowerCase() + next.pathname.replace(/\/+$/u, '') + next.search + next.hash;
}

function localePreferenceScore(locale: string | undefined, preferredLocale: string | undefined): number {
  if (locale === undefined) return preferredLocale === undefined ? 1 : 0;
  if (preferredLocale !== undefined) {
    if (locale === preferredLocale) return 4;
    const preferredBase = preferredLocale.split('-')[0];
    const localeBase = locale.split('-')[0];
    if (preferredBase !== undefined && preferredBase === localeBase) return 3;
  }
  if (locale === 'en' || locale.startsWith('en-')) return 2;
  return 1;
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

export function collapseSitemapLocaleDuplicates(
  urls: string[],
  preferredLocale?: string,
): { urls: string[]; collapsedCount: number } {
  const normalizedPreferred = normalizeLocale(preferredLocale);
  const bestByCanonical = new Map<
    string,
    { url: string; locale?: string; originalIndex: number; preference: number }
  >();

  urls.forEach((url, originalIndex) => {
    try {
      const parsed = new URL(url);
      const locale = extractLocaleFromUrl(parsed);
      const canonical = stripLocaleFromUrl(parsed);
      const preference = localePreferenceScore(locale, normalizedPreferred);
      const current = bestByCanonical.get(canonical);
      if (
        current === undefined ||
        preference > current.preference ||
        (preference === current.preference && originalIndex < current.originalIndex)
      ) {
        bestByCanonical.set(canonical, {
          url,
          ...(locale !== undefined ? { locale } : {}),
          originalIndex,
          preference,
        });
      }
    } catch {
      const fallbackKey = `${url}#${String(originalIndex)}`;
      bestByCanonical.set(fallbackKey, {
        url,
        originalIndex,
        preference: 0,
      });
    }
  });

  const deduped = [...bestByCanonical.values()]
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((entry) => entry.url);

  return {
    urls: deduped,
    collapsedCount: Math.max(0, urls.length - deduped.length),
  };
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
