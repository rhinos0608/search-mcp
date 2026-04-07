import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import { safeResponseText, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, parseError, timeoutError } from '../errors.js';
import type { TwitterPost } from '../types.js';

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new ToolCache<TwitterPost[]>({
  ttlMs: 5 * 60 * 1000, // 5 minutes
  maxSize: 50,
});

// ── Multi-selector strategy ──────────────────────────────────────────────────

interface SelectorSet {
  tweetItem: string[];
  tweetContent: string[];
  tweetDate: string[];
  username: string[];
  fullname: string[];
  likes: string[];
  retweets: string[];
  replies: string[];
  tweetLink: string[];
}

const SELECTORS: SelectorSet = {
  tweetItem: ['.timeline-item', '.tweet-body', '.tweet-item', '.post'],
  tweetContent: ['.tweet-content', '.tweet-text', '.content'],
  tweetDate: ['.tweet-date a', '.tweet-date', 'time', '.timestamp'],
  username: ['.username', '.tweet-header .username', '.handle'],
  fullname: ['.fullname', '.tweet-header .fullname', '.display-name'],
  likes: ['.icon-heart', '.tweet-stat .icon-heart', '.likes'],
  retweets: ['.icon-retweet', '.tweet-stat .icon-retweet', '.retweets'],
  replies: ['.icon-comment', '.tweet-stat .icon-comment', '.replies'],
  tweetLink: ['.tweet-link', '.tweet-date a', 'a.tweet-link'],
};

/** Cheerio selection type. */
type CheerioSelection = ReturnType<cheerio.CheerioAPI>;

/**
 * Try primary selector first, then fallbacks. Returns the cheerio selection
 * and logs a warning if a fallback was used.
 */
function resolveSelector(
  $parent: CheerioSelection,
  selectorName: keyof SelectorSet,
  warnings: string[],
): CheerioSelection {
  const candidates = SELECTORS[selectorName];
  const primary = candidates[0] ?? '';
  for (let i = 0; i < candidates.length; i++) {
    const sel = candidates[i];
    if (sel === undefined) continue;
    const result = $parent.find(sel);
    if (result.length > 0) {
      if (i > 0) {
        const msg = `Selector "${selectorName}": primary "${primary}" failed, using fallback "${sel}"`;
        logger.debug({ selectorName, fallback: sel }, msg);
        warnings.push(msg);
      }
      return result;
    }
  }
  // None matched — return empty selection from first candidate
  return $parent.find(primary);
}

// ── Numeric parsing ──────────────────────────────────────────────────────────

/**
 * Parse a human-readable numeric string (e.g. "1,234", "12.5K") into a number.
 * Returns 0 if unparseable.
 */
function safeParseInt(raw: string): number {
  const cleaned = raw.replace(/,/g, '').trim();
  const match = /[\d.]+/.exec(cleaned);
  if (!match) return 0;
  const numStr = match[0];

  // Handle K/M suffixes (e.g. "1.2K", "3M")
  const matchEnd = match.index + numStr.length;
  const suffix = cleaned.slice(matchEnd, matchEnd + 1).toUpperCase();
  const base = parseFloat(numStr);
  if (isNaN(base)) return 0;

  if (suffix === 'K') return Math.round(base * 1000);
  if (suffix === 'M') return Math.round(base * 1_000_000);

  const parsed = parseInt(numStr, 10);
  return isNaN(parsed) ? 0 : parsed;
}

// ── Content truncation ───────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 1000;

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + TRUNCATED_MARKER;
}

// ── Main function ────────────────────────────────────────────────────────────

export async function twitterSearch(
  query: string,
  nitterBaseUrl: string,
  limit = 20,
): Promise<TwitterPost[]> {
  // Nitter instance is required
  if (!nitterBaseUrl) {
    throw unavailableError(
      'Twitter search requires a Nitter instance URL. Set NITTER_BASE_URL env var.',
    );
  }

  // Check cache first
  const key = cacheKey('twitter', query, nitterBaseUrl, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Twitter search cache hit');
    return cached;
  }

  const url = `${nitterBaseUrl}/search?f=tweets&q=${encodeURIComponent(query)}`;

  // Validate the URL is safe (SSRF protection)
  assertSafeUrl(url);

  logger.info(
    { tool: 'twitter_search', query, nitterBaseUrl, limit },
    'Searching Twitter via Nitter',
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 30_000);

  let html: string;
  try {
    html = await retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'search-mcp/1.0' },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw unavailableError(
            `Nitter search returned HTTP ${String(response.status)}: ${response.statusText}`,
            { statusCode: response.status, backend: 'nitter' },
          );
        }

        return safeResponseText(response, url);
      },
      { label: 'twitter-search', maxAttempts: 2 },
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === 'AbortError') {
      throw timeoutError('Nitter search request timed out after 30 seconds', {
        backend: 'nitter',
        cause: err,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const $ = cheerio.load(html);
  const warnings: string[] = [];

  // Resolve tweet item selector (top-level, so search from root)
  const tweetItemCandidates = SELECTORS.tweetItem;
  const tweetItemPrimary = tweetItemCandidates[0] ?? '';
  let tweetItems: CheerioSelection | null = null;
  for (let i = 0; i < tweetItemCandidates.length; i++) {
    const sel = tweetItemCandidates[i];
    if (sel === undefined) continue;
    const found = $(sel);
    if (found.length > 0) {
      if (i > 0) {
        const msg = `Selector "tweetItem": primary "${tweetItemPrimary}" failed, using fallback "${sel}"`;
        logger.debug({ selectorName: 'tweetItem', fallback: sel }, msg);
        warnings.push(msg);
      }
      tweetItems = found;
      break;
    }
  }

  if (!tweetItems || tweetItems.length === 0) {
    throw parseError(
      'No tweet items found on Nitter search page — DOM structure may have changed or no results for this query',
      { backend: 'nitter' },
    );
  }

  const results: TwitterPost[] = [];

  tweetItems.each((_index, element) => {
    if (results.length >= limit) return;

    try {
      const item = $(element);

      // Tweet content
      const contentEl = resolveSelector(item, 'tweetContent', warnings);
      const rawContent = contentEl.text().trim();
      if (!rawContent) return; // skip empty tweets

      const content = truncateContent(rawContent);

      // Author info
      const fullnameEl = resolveSelector(item, 'fullname', warnings);
      const author = fullnameEl.first().text().trim();

      const usernameEl = resolveSelector(item, 'username', warnings);
      const handle = usernameEl.first().text().trim();

      // Tweet date / timestamp
      const dateEl = resolveSelector(item, 'tweetDate', warnings);
      const rawTimestamp = dateEl.attr('title') ?? dateEl.text().trim();
      const timestamp = rawTimestamp || null;

      // Tweet URL — try to extract from the tweet link or date anchor
      const linkEl = resolveSelector(item, 'tweetLink', warnings);
      const href = linkEl.attr('href') ?? '';
      const tweetUrl = href
        ? href.startsWith('http')
          ? href
          : `${nitterBaseUrl}${href.startsWith('/') ? '' : '/'}${href}`
        : '';

      // Stats — Nitter puts stats as siblings of the icon elements
      const likesEl = resolveSelector(item, 'likes', warnings);
      const likesRaw = likesEl.parent().text().trim();
      const likes = safeParseInt(likesRaw);

      const retweetsEl = resolveSelector(item, 'retweets', warnings);
      const retweetsRaw = retweetsEl.parent().text().trim();
      const retweets = safeParseInt(retweetsRaw);

      const repliesEl = resolveSelector(item, 'replies', warnings);
      const repliesRaw = repliesEl.parent().text().trim();
      const replies = safeParseInt(repliesRaw);

      results.push({
        author,
        handle,
        content,
        url: tweetUrl,
        timestamp,
        likes,
        retweets,
        replies,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg }, 'Skipping tweet item due to extraction error');
    }
  });

  if (warnings.length > 0) {
    logger.debug({ warnings }, 'Twitter search completed with selector warnings');
  }

  const limited = results.slice(0, limit);

  // Cache the results
  cache.set(key, limited);

  logger.debug({ resultCount: limited.length }, 'Twitter search complete');

  return limited;
}
