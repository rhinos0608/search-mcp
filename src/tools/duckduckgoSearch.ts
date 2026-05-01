/**
 * DuckDuckGo search provider using the lite HTML endpoint.
 *
 * DuckDuckGo Lite (https://lite.duckduckgo.com/lite/) returns a simple HTML
 * table with results — no API key needed, no JavaScript required.
 *
 * This is an experimental, zero-key fallback. It may break if DuckDuckGo
 * changes its HTML structure or deploys bot challenges.
 */

import { logger } from '../logger.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface DuckDuckGoConfig {
  region: string;
  safeSearch: string;
}

/**
 * Parse a DuckDuckGo Lite HTML response into SearchResult items.
 *
 * The Lite response is a simple HTML table:
 *   <table class="result">
 *     <tr class="result-header">
 *       <td><a rel="nofollow" href="URL">TITLE</a></td>
 *     </tr>
 *     <tr class="result-snippet">
 *       <td>DESCRIPTION</td>
 *     </tr>
 *     <tr class="result-url">
 *       <td>DISPLAY_URL</td>
 *     </tr>
 *   </table>
 */
function parseLiteHtml(html: string, startPosition: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Split into result tables first
  const tables = html.split('<table class="result"');
  // First element is any content before the first result table — ignore it
  for (let t = 1; t < tables.length; t++) {
    const tableContent = tables[t] ?? '';

    // Extract URL and title from result-header
    const headerRe = /<a[^>]*href="([^"]*)"[^>]*rel="nofollow"[^>]*>([\s\S]*?)<\/a>/i;
    const headerMatch = headerRe.exec(tableContent);
    if (!headerMatch) continue;

    const rawUrl = headerMatch[1] ?? '';
    const rawTitle = headerMatch[2] ?? '';

    // Clean up title: remove <b> tags and trim whitespace
    const title = rawTitle.replace(/<\/?b>/gi, '').trim();

    // Extract snippet from result-snippet
    const snippetRe = /<tr class="result-snippet">[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i;
    const snippetMatch = snippetRe.exec(tableContent);
    const description = snippetMatch ? (snippetMatch[1] ?? '').replace(/<\/?b>/gi, '').trim() : '';

    // Extract display URL from result-url
    const urlRe = /<tr class="result-url">[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i;
    const urlMatch = urlRe.exec(tableContent);
    const displayUrl = urlMatch ? (urlMatch[1] ?? '').trim() : '';

    // The href in the link is the actual URL — guard against empty fields
    const url = rawUrl || (displayUrl ? `https://${displayUrl}` : '');
    if (url.length === 0) continue;

    // Extract domain
    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch {
      domain = displayUrl;
    }

    results.push({
      title,
      url,
      description,
      position: startPosition + results.length + 1,
      domain,
      source: 'duckduckgo' as const,
      age: null,
      extraSnippet: null,
      deepLinks: null,
    });
  }

  return results;
}

/**
 * Detect if the HTML response is a bot challenge page.
 */
function isBotChallengePage(html: string): boolean {
  const lower = html.toLowerCase();
  // DuckDuckGo challenge indicators
  if (lower.includes('verify your identity') || lower.includes('captcha')) return true;
  if (lower.includes('challenge-platform') || lower.includes('cf-challenge')) return true;
  // No result table found — likely a block/challenge page
  if (!html.includes('<table class="result"') && html.length > 500) {
    // Check if the page has any search-like content at all
    if (!lower.includes('duckduckgo')) return false; // not even a DDG page
    if (html.includes('please try again') || html.includes('try a different search')) return true;
  }
  return false;
}

export async function duckduckgoSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
  config: DuckDuckGoConfig,
): Promise<SearchResult[]> {
  // Resolve safesearch: explicit arg trumps config, config trumps default
  const effectiveSafeSearch = safeSearch !== 'moderate' ? safeSearch : (config.safeSearch as 'strict' | 'moderate' | 'off' | undefined) ?? 'moderate';
  logger.info({ limit, safeSearch: effectiveSafeSearch, region: config.region }, 'Running DuckDuckGo search (experimental)');

  const key = cacheKey('duckduckgo', query, String(limit), effectiveSafeSearch, config.region);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'DuckDuckGo search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    q: query,
  });

  // DuckDuckGo Lite doesn't support safesearch param in the same way.
  // We pass it anyway — it may be ignored.
  if (effectiveSafeSearch === 'strict') {
    params.set('kp', '1');
  }

  // Region: DDG Lite uses the 'kl' parameter for locale (e.g., us-en, de-de)
  if (config.region.length > 0) {
    params.set('kl', config.region);
  }

  const url = `${DUCKDUCKGO_LITE_URL}?${params.toString()}`;

  const html = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; SearchMCP/1.0; +https://github.com/rhinesharar/search-mcp)',
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw unavailableError(`DuckDuckGo returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'duckduckgo',
        });
      }

      return await res.text();
    },
    { label: 'duckduckgo-search', maxAttempts: 2, initialDelayMs: 1000 },
  );

  // Check for bot challenge pages
  if (isBotChallengePage(html)) {
    logger.warn({ query }, 'DuckDuckGo returned a bot challenge page');
    throw unavailableError(
      'DuckDuckGo returned a bot challenge page. The backend is temporarily unavailable.',
      { backend: 'duckduckgo', retryable: true },
    );
  }

  const parsed = parseLiteHtml(html, 0);

  if (parsed.length === 0) {
    logger.debug({ query, htmlPreview: html.slice(0, 300) }, 'DuckDuckGo returned no results');
  }

  const mapped = parsed.slice(0, limit).map((r, i) => ({
    ...r,
    position: i + 1,
  }));

  cache.set(key, mapped);
  logger.info(
    { count: mapped.length, backend: 'duckduckgo', experimental: true },
    'DuckDuckGo search complete',
  );
  return mapped;
}
