/**
 * Last-resort Reddit search fallback using SearXNG + Crawl4AI.
 *
 * 1. SearXNG searches `site:reddit.com/r/{subreddit} {query}`
 * 2. Crawl4AI crawls found Reddit URLs
 * 3. Markdown parsed into structured Reddit post data
 * 4. Results wrapped in Reddit-native Listing format
 *
 * Never throws — returns empty Listing on failure.
 */

import { logger } from '../logger.js';
import { ToolError } from '../errors.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  engines?: string[];
  score?: number;
}

interface SearxResponse {
  results?: SearxResult[];
}

interface Crawl4aiRawPage {
  url?: string;
  success?: boolean;
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  metadata?: {
    title?: string;
    description?: string;
    status_code?: number;
  } | null;
  error_message?: string | null;
}

interface Crawl4aiRawResponse {
  results?: Crawl4aiRawPage[];
  result?: Crawl4aiRawPage;
  success?: boolean;
  error?: string;
}

/** Structured post extracted from crawled markdown. */
interface ExtractedPost {
  title: string;
  url: string;
  selftext: string;
  score: number;
  num_comments: number;
  subreddit: string;
  author: string;
  created_utc: number;
  permalink: string;
  is_video: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SEARXNG_TIMEOUT_MS = 15_000;
const CRAWL4AI_TIMEOUT_MS = 30_000;
const USER_AGENT = 'search-mcp/7.0 (searxng-reddit-fallback)';

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Search Reddit via SearXNG + Crawl4AI fallback.
 * Returns Listing format compatible with parseRedditSearchListing.
 */
export async function searxngRedditSearch(
  query: string,
  subreddit: string,
  sort?: string,
  limit?: number,
  timeframe?: string,
  searxngBaseUrl?: string,
  crawl4aiBaseUrl?: string,
  crawl4aiApiToken?: string,
): Promise<unknown> {
  const resultLimit = Math.min(limit ?? 10, 25);

  // Phase 1: SearXNG search
  const searchResults = await searxngSearchReddit(query, subreddit, resultLimit, searxngBaseUrl);

  if (searchResults.length === 0) {
    logger.debug(
      { tool: 'searxng_reddit_search', subreddit },
      'SearXNG returned no Reddit results',
    );
    return emptyListing();
  }

  // Phase 2: Crawl4AI extraction for each URL
  const posts: ExtractedPost[] = [];
  for (const sr of searchResults) {
    if (!sr.url) continue;
    try {
      const markdown = await crawlRedditUrl(sr.url, crawl4aiBaseUrl, crawl4aiApiToken);
      if (markdown) {
        const extracted = extractPostFromMarkdown(markdown, sr.url, subreddit);
        posts.push(extracted);
      }
    } catch (err) {
      logger.warn(
        { err, url: sr.url, tool: 'searxng_reddit_search' },
        'Crawl4AI extraction failed for Reddit URL, skipping',
      );
    }
  }

  if (posts.length === 0) {
    logger.debug({ tool: 'searxng_reddit_search', subreddit }, 'All Crawl4AI extractions failed');
    return emptyListing();
  }

  // Phase 3b: Post-filter by timeframe
  let filteredPosts = posts;
  if (timeframe && timeframe !== 'all') {
    const cutoff = timeframeToUnixCutoff(timeframe);
    if (cutoff > 0) {
      filteredPosts = posts.filter((p) => p.created_utc >= cutoff);
    }
  }

  // Phase 3c: Sort by requested sort order
  const sortedPosts = sortPosts(filteredPosts, sort);

  // Phase 4: Wrap in Listing format
  return {
    kind: 'Listing',
    data: {
      children: sortedPosts.map((p) => ({ kind: 't3', data: p })),
    },
  };
}

// ── Phase 1: SearXNG search ────────────────────────────────────────────────

async function searxngSearchReddit(
  query: string,
  subreddit: string,
  limit: number,
  searxngBaseUrl?: string,
): Promise<SearxResult[]> {
  if (!searxngBaseUrl) {
    logger.warn({ tool: 'searxng_reddit_search' }, 'SearXNG base URL not configured');
    return [];
  }

  const searchQuery = `site:reddit.com/r/${subreddit} ${query}`;
  const base = searxngBaseUrl.replace(/\/+$/, '');
  const url = `${base}/search?format=json&q=${encodeURIComponent(searchQuery)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, tool: 'searxng_reddit_search' },
        'SearXNG search returned non-OK status',
      );
      throw new ToolError(
        `SearXNG returned HTTP ${String(response.status)} for Reddit search query`,
        { code: 'UNAVAILABLE', retryable: true, backend: 'searxng' },
      );
    }

    const body = (await response.json()) as SearxResponse;
    const results = body.results ?? [];

    // Filter to only Reddit comment pages matching the target subreddit
    const subTokens = subreddit
      .split('+')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return results
      .filter((r) => {
        if (!r.url) return false;
        try {
          const parsed = new URL(r.url);
          return (
            (parsed.hostname === 'www.reddit.com' ||
              parsed.hostname === 'reddit.com' ||
              parsed.hostname === 'old.reddit.com') &&
            subTokens.some((token) =>
              parsed.pathname.toLowerCase().startsWith(`/r/${token}/comments/`),
            )
          );
        } catch {
          return false;
        }
      })
      .slice(0, limit);
  } catch (err) {
    logger.warn({ err, tool: 'searxng_reddit_search' }, 'SearXNG search failed');
    throw new ToolError(
      `SearXNG search failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'UNAVAILABLE',
        retryable: true,
        backend: 'searxng',
        cause: err instanceof Error ? err : undefined,
      },
    );
  }
}

// ── Phase 2: Crawl4AI ──────────────────────────────────────────────────────

async function crawlRedditUrl(
  url: string,
  crawl4aiBaseUrl?: string,
  crawl4aiApiToken?: string,
): Promise<string | null> {
  if (!crawl4aiBaseUrl) {
    logger.warn({ tool: 'searxng_reddit_search' }, 'Crawl4AI base URL not configured');
    return null;
  }

  const endpoint = `${crawl4aiBaseUrl.replace(/\/+$/, '')}/crawl`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (crawl4aiApiToken) {
    headers.Authorization = `Bearer ${crawl4aiApiToken}`;
  }

  const body = {
    urls: [url],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        deep_crawl_strategy: {
          type: 'BFSDeepCrawlStrategy',
          params: {
            max_depth: 0,
            max_pages: 1,
            include_external: false,
          },
        },
      },
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CRAWL4AI_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, url, tool: 'searxng_reddit_search' },
        'Crawl4AI returned non-OK status',
      );
      return null;
    }

    const data = (await response.json()) as Crawl4aiRawResponse;
    const page = getPageFromResponse(data);
    if (!page) {
      logger.warn({ url, tool: 'searxng_reddit_search' }, 'Crawl4AI returned empty response');
      return null;
    }

    if (page.success === false) {
      logger.warn(
        { url, error: page.error_message, tool: 'searxng_reddit_search' },
        'Crawl4AI page crawl failed',
      );
      return null;
    }

    const markdown = extractMarkdown(page.markdown);
    if (!markdown || markdown.trim().length === 0) {
      logger.warn({ url, tool: 'searxng_reddit_search' }, 'Crawl4AI returned empty markdown');
      return null;
    }

    return markdown;
  } catch (err) {
    logger.warn({ err, url, tool: 'searxng_reddit_search' }, 'Crawl4AI request failed');
    return null;
  }
}

/** Get the first successful page from a Crawl4AI response. */
function getPageFromResponse(data: Crawl4aiRawResponse): Crawl4aiRawPage | null {
  if (Array.isArray(data.results) && data.results.length > 0) {
    return data.results[0] ?? null;
  }
  if (data.result) {
    return data.result;
  }
  return null;
}

/** Extract markdown string from Crawl4AI's flexible markdown field. */
function extractMarkdown(raw: Crawl4aiRawPage['markdown']): string {
  if (typeof raw === 'string') return raw;
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    const fit = raw.fit_markdown?.trim();
    if (fit) return fit;
    const rawMarkdown = raw.raw_markdown?.trim();
    if (rawMarkdown) return rawMarkdown;
    return '';
  }
  return '';
}

// ── Phase 3: Markdown extraction ───────────────────────────────────────────

/**
 * Extract structured Reddit post fields from Crawl4AI markdown.
 * Uses regex-based extraction with sensible defaults for missing fields.
 */
function extractPostFromMarkdown(markdown: string, url: string, subreddit: string): ExtractedPost {
  // Extract post ID from URL: /r/{subreddit}/comments/{id}/
  const postIdMatch = /\/comments\/([a-z0-9]+)/i.exec(url);
  const postId = postIdMatch?.[1] ?? '';

  // Title: first h1 heading
  let title = '';
  const h1Match = /^#\s+(.+)$/m.exec(markdown);
  if (h1Match?.[1]) {
    title = h1Match[1].trim();
  }

  // Fallback title: text before "r/{subreddit}" pattern
  if (!title) {
    const beforeSubMatch = new RegExp(`(.+?)\\s*r/${escapeRegex(subreddit)}`, 'i').exec(markdown);
    if (beforeSubMatch?.[1]) {
      title = beforeSubMatch[1].trim();
    }
  }

  // Author: Posted by u/username
  let author = '[deleted]';
  const authorMatch = /[Pp]osted\s+by\s+u[/\\]?([\w-]+)/.exec(markdown);
  if (authorMatch?.[1]) {
    author = authorMatch[1];
  } else {
    const uMatch = /u[/\\]([\w-]+)/.exec(markdown);
    if (uMatch?.[1]) {
      author = uMatch[1];
    }
  }

  // Score: "X points" or "X upvotes"
  let score = 0;
  const scoreMatch = /([\d,]+)\s+(?:points?|upvotes?|votes?)/i.exec(markdown);
  if (scoreMatch?.[1]) {
    score = parseNumber(scoreMatch[1]);
  }

  // Num comments: "X comments"
  let numComments = 0;
  const commentsMatch = /([\d,]+)\s+comments?(?:\s+(?:sort|share|save|hide|report))?/i.exec(
    markdown,
  );
  if (commentsMatch?.[1]) {
    numComments = parseNumber(commentsMatch[1]);
  }

  // Created UTC: ISO date or "submitted X ago"
  let createdUtc = 0;
  const isoMatch = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(
    markdown,
  );
  if (isoMatch?.[1]) {
    const ts = Date.parse(isoMatch[1]);
    if (!isNaN(ts)) {
      createdUtc = Math.floor(ts / 1000);
    }
  }

  // Fallback: "submitted X ago" or relative time
  if (createdUtc === 0) {
    const agoMatch =
      /([Ss]ubmitted|[Pp]osted)\s+(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i.exec(
        markdown,
      );
    if (agoMatch?.[2] !== undefined && agoMatch[3] !== undefined) {
      const amount = parseInt(agoMatch[2], 10);
      const unit = agoMatch[3].toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      const offsets: Record<string, number> = {
        minute: 60,
        hour: 3600,
        day: 86400,
        week: 604800,
        month: 2592000,
        year: 31536000,
      };
      const offset = offsets[unit] ?? 0;
      createdUtc = now - amount * offset;
    }
  }

  // Selftext: content between title/author area and comment section
  const selftext = extractSelftext(markdown, subreddit);

  // Permalink derivation
  const permalink = postId ? `/r/${subreddit}/comments/${postId}/` : `/r/${subreddit}/comments/_/`;

  return {
    title,
    url,
    selftext,
    score,
    num_comments: numComments,
    subreddit,
    author,
    created_utc: createdUtc,
    permalink,
    is_video: false,
  };
}

/**
 * Extract selftext from the markdown between the post header area
 * and the comment section.
 */
function extractSelftext(markdown: string, subreddit: string): string {
  // Split on common comment/action section markers
  const commentMarkers = [
    /\n[-]{3,}\s*\n/, // horizontal rule
    /\n\s*comments?\s*(?:for|on)\b/i, // "comments for" / "comments on"
    /\n\s*sort\s+by\b/i, // "sort by"
    /\n\s*view\s+all\s+comments/i, // "view all comments"
    /\n\s*load\s+more\s+comments/i,
    /\n#+\s*comments?\s*$/im, // "## Comments" heading
    /\n##\s+comment\s+section/i,
  ];

  // Find first marker after the start of content
  let textEnd = markdown.length;
  for (const marker of commentMarkers) {
    const match = markdown.match(marker);
    if (match?.index !== undefined && match.index < textEnd) {
      textEnd = match.index;
    }
  }

  // Extract content area, skipping title/header lines
  const candidate = markdown.slice(0, textEnd).trim();

  // Remove leading title/h1 lines
  const cleaned = candidate.replace(/^#\s+.*$/m, '').trim();

  // Remove leading metadata lines like "r/subreddit • X points • Y comments"
  const metadataLess = cleaned
    .replace(new RegExp(`^r/${escapeRegex(subreddit)}\\s*[•·].*?$`, 'im'), '')
    .trim();

  // Remove author line
  const authorLess = metadataLess.replace(/^[Pp]osted\s+by\s+u[/\\]?[\w-]+.*$/m, '').trim();

  return authorLess.length > 0 ? authorLess : '';
}

// ── Utilities ──────────────────────────────────────────────────────────────

function emptyListing(): unknown {
  return {
    kind: 'Listing',
    data: {
      children: [],
    },
  };
}

/** Convert Reddit timeframe string to unix timestamp cutoff. */
function timeframeToUnixCutoff(timeframe: string): number {
  const now = Math.floor(Date.now() / 1000);
  switch (timeframe) {
    case 'hour':
      return now - 3600;
    case 'day':
      return now - 86_400;
    case 'week':
      return now - 604_800;
    case 'month':
      return now - 2_592_000;
    case 'year':
      return now - 31_536_000;
    default:
      return 0;
  }
}

/** Sort extracted posts according to Reddit sort type. */
function sortPosts(posts: ExtractedPost[], sort?: string): ExtractedPost[] {
  switch (sort) {
    case 'new':
      return [...posts].sort((a, b) => b.created_utc - a.created_utc);
    case 'top':
      return [...posts].sort((a, b) => b.score - a.score);
    case 'comments':
      return [...posts].sort((a, b) => b.num_comments - a.num_comments);
    case 'relevance':
    default:
      // Keep original order from SearXNG (ranked by relevance)
      return posts;
  }
}

/** Parse a string like "1,234" to number 1234. */
function parseNumber(input: string): number {
  return parseInt(input.replace(/,/g, ''), 10) || 0;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
