import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { webSearch } from './tools/webSearch.js';
import { webRead } from './tools/webRead.js';
import { getGitHubRepo } from './tools/githubRepo.js';
import { getGitHubTrending } from './tools/githubTrending.js';
import { getYouTubeTranscript } from './tools/youtubeTranscript.js';
import { redditSearch } from './tools/redditSearch.js';
import { redditComments } from './tools/redditComments.js';
import { twitterSearch } from './tools/twitterSearch.js';
import { producthuntSearch } from './tools/producthuntSearch.js';
import { patentSearch } from './tools/patentSearch.js';
import { podcastSearch } from './tools/podcastSearch.js';
import { academicSearch } from './tools/academicSearch.js';
import { hackernewsSearch } from './tools/hackernewsSearch.js';
import { youtubeSearch } from './tools/youtubeSearch.js';
import { arxivSearch } from './tools/arxivSearch.js';
import { stackoverflowSearch } from './tools/stackoverflowSearch.js';
import { npmSearch } from './tools/npmSearch.js';
import { pypiSearch } from './tools/pypiSearch.js';
import { newsSearch } from './tools/newsSearch.js';
import { isToolError } from './errors.js';
import type { RateLimitInfo } from './rateLimit.js';
import type { ToolResult } from './types.js';
import { configHealth, getGatedTools, runHealthProbes } from './health.js';

interface MakeResultOpts {
  warnings?: string[];
  rateLimit?: RateLimitInfo;
}

function makeResult<T>(
  tool: string,
  data: T,
  durationMs: number,
  opts?: MakeResultOpts,
): ToolResult<T> {
  return {
    data,
    meta: {
      tool,
      durationMs,
      timestamp: new Date().toISOString(),
      ...(opts?.warnings && opts.warnings.length > 0 ? { warnings: opts.warnings } : {}),
      ...(opts?.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    },
  };
}

function sanitizeErrorMessage(err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  // Strip stack traces — only return the first line (the message)
  return error.message.split('\n')[0] ?? 'Unknown error';
}

function errorResponse(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const payload: Record<string, unknown> = { error: sanitizeErrorMessage(err) };
  if (isToolError(err)) {
    payload.code = err.code;
    payload.retryable = err.retryable;
    if (err.statusCode !== undefined) payload.statusCode = err.statusCode;
    if (err.backend !== undefined) payload.backend = err.backend;
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}

function successResponse<T>(result: ToolResult<T>): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
      },
    ],
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  logger.info({ backend: cfg.searchBackend }, 'Primary search backend');

  const gated = getGatedTools(cfg);
  if (gated.size > 0) {
    const startupHealth = configHealth(cfg);
    for (const tool of gated) {
      const h = startupHealth[tool];
      logger.info({ tool, remediation: h?.remediation }, 'Tool not registered (unconfigured)');
    }
  }

  const server = new McpServer({
    name: 'search-mcp',
    version: '1.0.0',
  });

  // ── web_search ────────────────────────────────────────────────────────────
  server.registerTool(
    'web_search',
    {
      description:
        'Search the web and return a ranked list of results with titles, URLs, descriptions, and citation metadata (position, domain, source backend, age). Uses the configured search backend (Brave or SearXNG) with automatic fallback.',
      inputSchema: {
        query: z.string().describe('The search query string'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe('Maximum number of results to return (1–50, default 10)'),
        safeSearch: z
          .enum(['strict', 'moderate', 'off'])
          .optional()
          .default('moderate')
          .describe('Safe-search level: strict | moderate | off'),
      },
    },
    async ({ query, limit, safeSearch }) => {
      logger.info({ tool: 'web_search', limit, safeSearch }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await webSearch(query, limit, safeSearch);
        const result = makeResult('web_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── web_read ──────────────────────────────────────────────────────────────
  server.registerTool(
    'web_read',
    {
      description:
        'Fetch and parse a web page, extracting its article content as both HTML and plain text. Uses Mozilla Readability with automatic fallback to raw DOM text extraction. Returns metadata (title, description, image, published date) when available.',
      inputSchema: {
        url: z
          .url()
          .describe('The fully-qualified URL of the page to read (must include https://)'),
      },
    },
    async ({ url }) => {
      logger.info({ tool: 'web_read' }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await webRead(url);
        const result = makeResult('web_read', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_read' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_repo ───────────────────────────────────────────────────────────
  server.registerTool(
    'github_repo',
    {
      description:
        'Fetch metadata for a GitHub repository, including stars, forks, license, topics, latest release, and optionally the README.',
      inputSchema: {
        owner: z
          .string()
          .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
          .describe('GitHub username or organisation that owns the repository'),
        repo: z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,100}$/)
          .describe('Repository name (without the owner prefix)'),
        includeReadme: z
          .boolean()
          .optional()
          .default(true)
          .describe('Fetch and include the raw README content (default true)'),
      },
    },
    async ({ owner, repo, includeReadme }) => {
      logger.info({ tool: 'github_repo', owner, repo, includeReadme }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepo(owner, repo, includeReadme);
        const result = makeResult('github_repo', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo', owner, repo }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_trending ───────────────────────────────────────────────────────
  server.registerTool(
    'github_trending',
    {
      description:
        'Scrape the GitHub Trending page and return the current list of trending repositories, optionally filtered by language and time range.',
      inputSchema: {
        language: z
          .string()
          .optional()
          .default('')
          .describe(
            'Programming language slug to filter by (e.g. "typescript", "python"). Leave empty for all languages.',
          ),
        since: z
          .enum(['daily', 'weekly', 'monthly'])
          .optional()
          .default('daily')
          .describe('Time window for trending calculation: daily | weekly | monthly'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(25)
          .describe('Maximum number of trending repos to return (1–50, default 25)'),
      },
    },
    async ({ language, since, limit }) => {
      logger.info({ tool: 'github_trending', language, since, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const { repos, warnings } = await getGitHubTrending(language, since, limit);
        const result = makeResult('github_trending', repos, Date.now() - start, { warnings });
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_trending' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── youtube_transcript ────────────────────────────────────────────────────
  server.registerTool(
    'youtube_transcript',
    {
      description:
        'Retrieve the transcript (captions) for a YouTube video, returned as timestamped segments and a single concatenated full-text string.',
      inputSchema: {
        videoId: z
          .string()
          .describe(
            'YouTube video ID (the part after ?v= in the URL, e.g. "dQw4w9WgXcQ"). Full URLs are also accepted.',
          ),
        language: z
          .string()
          .optional()
          .default('en')
          .describe('BCP-47 language code for the desired caption track (default "en")'),
      },
    },
    async ({ videoId, language }) => {
      logger.info({ tool: 'youtube_transcript', videoId, language }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getYouTubeTranscript(videoId, language);
        const result = makeResult('youtube_transcript', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'youtube_transcript' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── reddit_search ─────────────────────────────────────────────────────────
  server.registerTool(
    'reddit_search',
    {
      description:
        'Search Reddit posts via the public JSON API. IMPORTANT: For topic-specific queries, ALWAYS provide a subreddit (e.g. "LocalLLaMA" for LLM topics, "webdev" for web dev). Without a subreddit, Reddit global search has poor relevance — results are dominated by popular posts that loosely match keywords. When no subreddit is given, the tool automatically uses sort=new with a short timeframe to mitigate this. Subreddit-scoped search is excellent and should be the default usage pattern.',
      inputSchema: {
        query: z.string().describe('Search query string'),
        subreddit: z
          .string()
          .optional()
          .default('')
          .describe(
            'Restrict search to this subreddit (without the r/ prefix). Leave empty to search all of Reddit.',
          ),
        sort: z
          .enum(['relevance', 'hot', 'top', 'new', 'comments'])
          .optional()
          .default('relevance')
          .describe('Sort order for results: relevance | hot | top | new | comments'),
        timeframe: z
          .enum(['hour', 'day', 'week', 'month', 'year', 'all'])
          .optional()
          .default('year')
          .describe(
            'Time window for the top/relevance sort: hour | day | week | month | year | all (default: year — use "all" only when you specifically need all-time results)',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(25)
          .describe('Maximum number of posts to return (1–100, default 25)'),
      },
    },
    async ({ query, subreddit, sort, timeframe, limit }) => {
      logger.info({ tool: 'reddit_search', subreddit, sort, timeframe, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await redditSearch(query, subreddit, sort, timeframe, limit);
        const result = makeResult('reddit_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'reddit_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── reddit_comments ───────────────────────────────────────────────────────
  server.registerTool(
    'reddit_comments',
    {
      description:
        'Fetch a Reddit post and its comment tree via the public JSON API. Accepts exactly one locator form: `url` (full Reddit post URL), `permalink` (relative /r/{sub}/comments/{id} path), or `subreddit`+`article` (subreddit name plus post id without t3_ prefix). Optionally focus on a subthread via `comment` (id without t1_ prefix) with `context` parent depth (0–8, only valid with `comment`). Controls: `sort` (confidence|top|new|controversial|old|qa), `depth` (1–10), `limit` (1–100). When `showMore=false` (default), Reddit `more` placeholders are omitted from `comments` and surfaced in the top-level `more` metadata; set true to preserve them inline. Returns normalized post metadata plus a nested comment tree.',
      inputSchema: {
        url: z
          .url()
          .optional()
          .describe('Full Reddit post URL (https://www.reddit.com/r/{sub}/comments/{id}/...)'),
        permalink: z
          .string()
          .optional()
          .describe('Relative Reddit permalink starting with /r/{sub}/comments/{id}'),
        subreddit: z
          .string()
          .regex(/^[A-Za-z0-9_]{1,21}$/)
          .optional()
          .describe('Subreddit name (without r/). Required together with `article`.'),
        article: z
          .string()
          .regex(/^[A-Za-z0-9]+$/)
          .optional()
          .describe('Reddit post id without the t3_ prefix. Required together with `subreddit`.'),
        comment: z
          .string()
          .regex(/^[A-Za-z0-9]+$/)
          .optional()
          .describe('Comment id (no t1_ prefix) to focus a subthread.'),
        context: z
          .number()
          .int()
          .min(0)
          .max(8)
          .optional()
          .describe(
            'Number of parent comments to include around `comment` (0–8). Only valid when `comment` is provided.',
          ),
        sort: z
          .enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa'])
          .optional()
          .default('confidence')
          .describe('Comment sort: confidence | top | new | controversial | old | qa'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum tree depth (1–10). Reddit default is 10.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of comment nodes (1–100).'),
        showMore: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Include `more` placeholders inline in `comments` when true; otherwise omit them and surface them in `more` summary metadata.',
          ),
      },
    },
    async ({
      url,
      permalink,
      subreddit,
      article,
      comment,
      context,
      sort,
      depth,
      limit,
      showMore,
    }) => {
      logger.info(
        {
          tool: 'reddit_comments',
          hasUrl: url !== undefined,
          hasPermalink: permalink !== undefined,
          subreddit,
          article,
          comment,
          sort,
          depth,
          limit,
          showMore,
        },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        const data = await redditComments({
          ...(url !== undefined ? { url } : {}),
          ...(permalink !== undefined ? { permalink } : {}),
          ...(subreddit !== undefined ? { subreddit } : {}),
          ...(article !== undefined ? { article } : {}),
          ...(comment !== undefined ? { comment } : {}),
          ...(context !== undefined ? { context } : {}),
          sort,
          ...(depth !== undefined ? { depth } : {}),
          ...(limit !== undefined ? { limit } : {}),
          showMore,
        });
        const result = makeResult('reddit_comments', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'reddit_comments' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── twitter_search ──────────────────────────────────────────────────────
  if (!gated.has('twitter_search'))
    server.registerTool(
      'twitter_search',
      {
        description:
          'Search Twitter/X posts via a Nitter instance. Returns tweets with author, content, engagement metrics (likes, retweets, replies), and timestamps. Requires a Nitter instance URL configured via NITTER_BASE_URL.',
        inputSchema: {
          query: z.string().describe('Search query string'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe('Maximum number of tweets to return (1–50, default 20)'),
        },
      },
      async ({ query, limit }) => {
        logger.info({ tool: 'twitter_search', limit }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await twitterSearch(query, cfg.nitter.baseUrl, limit);
          const result = makeResult('twitter_search', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'twitter_search' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── producthunt_search ─────────────────────────────────────────────────
  if (!gated.has('producthunt_search'))
    server.registerTool(
      'producthunt_search',
      {
        description:
          'Search Product Hunt for product launches, tools, and apps. Returns products with name, tagline, vote/comment counts, topics, and launch dates. Uses the GraphQL API if a token is configured (PRODUCTHUNT_API_TOKEN), otherwise scrapes the public leaderboard.',
        inputSchema: {
          query: z.string().describe('Search query string'),
          sort: z
            .enum(['popularity', 'newest', 'votes'])
            .optional()
            .default('popularity')
            .describe('Sort order: popularity | newest | votes'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe('Maximum number of products to return (1–50, default 20)'),
        },
      },
      async ({ query, sort, limit }) => {
        logger.info({ tool: 'producthunt_search', sort, limit }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await producthuntSearch(query, cfg.producthunt.apiToken, sort, limit);
          const result = makeResult('producthunt_search', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'producthunt_search' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── patent_search ──────────────────────────────────────────────────────
  if (!gated.has('patent_search'))
    server.registerTool(
      'patent_search',
      {
        description:
          'Search US patents via the USPTO PatentsView API. Returns patent number, title, abstract, inventors, assignees, filing/grant dates, and a Google Patents link. Requires PATENTSVIEW_API_KEY env var (free registration at patentsview.org).',
        inputSchema: {
          query: z.string().describe('Patent search query (searches abstracts)'),
          assignee: z
            .string()
            .optional()
            .default('')
            .describe(
              'Filter by assignee/company name (e.g. "Google", "Apple"). Leave empty for no filter.',
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(25)
            .describe('Maximum number of patents to return (1–100, default 25)'),
        },
      },
      async ({ query, assignee, limit }) => {
        logger.info({ tool: 'patent_search', assignee, limit }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await patentSearch(query, cfg.patentsview.apiKey, assignee, limit);
          const result = makeResult('patent_search', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'patent_search' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── podcast_search ─────────────────────────────────────────────────────
  if (!gated.has('podcast_search'))
    server.registerTool(
      'podcast_search',
      {
        description:
          'Search podcast episodes via the ListenNotes API. Returns episode title, description, podcast name, publisher, audio URL, duration, and published date. Requires LISTENNOTES_API_KEY env var.',
        inputSchema: {
          query: z.string().describe('Search query string'),
          sort: z
            .enum(['relevance', 'date'])
            .optional()
            .default('relevance')
            .describe('Sort order: relevance | date'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe('Maximum number of episodes to return (1–50, default 20)'),
        },
      },
      async ({ query, sort, limit }) => {
        logger.info({ tool: 'podcast_search', sort, limit }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await podcastSearch(query, cfg.listennotes.apiKey, sort, limit);
          const result = makeResult('podcast_search', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'podcast_search' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── academic_search ────────────────────────────────────────────────────
  server.registerTool(
    'academic_search',
    {
      description:
        'Search academic papers via ArXiv and Semantic Scholar APIs (free, no API keys required). Returns paper title, authors, abstract, year, venue, citation count, DOI, and PDF link. Supports searching ArXiv only, Semantic Scholar only, or both with merged/deduplicated results.',
      inputSchema: {
        query: z.string().describe('Academic search query'),
        source: z
          .enum(['arxiv', 'semantic_scholar', 'all'])
          .optional()
          .default('all')
          .describe(
            'Which backend to search: arxiv | semantic_scholar | all (default: all — searches both and merges results)',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe('Maximum number of papers to return (1–50, default 20)'),
        yearFrom: z
          .number()
          .int()
          .min(1900)
          .max(2100)
          .optional()
          .describe(
            'Filter papers published from this year onwards (e.g. 2020). Only applies to Semantic Scholar backend.',
          ),
      },
    },
    async ({ query, source, limit, yearFrom }) => {
      logger.info({ tool: 'academic_search', source, limit, yearFrom }, 'Tool invoked');
      const start = Date.now();
      try {
        const { papers, warnings } = await academicSearch(query, source, limit, yearFrom ?? null);
        const opts = warnings.length > 0 ? { warnings } : {};
        const result = makeResult('academic_search', papers, Date.now() - start, opts);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'academic_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── hackernews_search ──────────────────────────────────────────────────
  server.registerTool(
    'hackernews_search',
    {
      description:
        'Search Hacker News via the Algolia API. Returns stories, comments, or all items with title, URL, author, points, comment count, and timestamps. Supports filtering by type, sorting by relevance or date, and date range filtering. Free, no API key required.',
      inputSchema: {
        query: z.string().describe('Search query string'),
        type: z
          .enum(['story', 'comment', 'all'])
          .optional()
          .default('story')
          .describe('Item type filter: story | comment | all (default: story)'),
        sort: z
          .enum(['relevance', 'date'])
          .optional()
          .default('relevance')
          .describe('Sort order: relevance | date (chronological, newest first)'),
        dateFrom: z
          .string()
          .optional()
          .describe('Start date for filtering (ISO 8601 format, e.g. "2025-01-01")'),
        dateTo: z
          .string()
          .optional()
          .describe('End date for filtering (ISO 8601 format, e.g. "2025-12-31")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe('Maximum number of items to return (1–50, default 20)'),
      },
    },
    async ({ query, type, sort, dateFrom, dateTo, limit }) => {
      logger.info({ tool: 'hackernews_search', type, sort, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const dateRange =
          dateFrom !== undefined || dateTo !== undefined
            ? {
                ...(dateFrom !== undefined ? { from: dateFrom } : {}),
                ...(dateTo !== undefined ? { to: dateTo } : {}),
              }
            : null;
        const data = await hackernewsSearch(query, type, sort, dateRange, limit);
        const result = makeResult('hackernews_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'hackernews_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── youtube_search ──────────────────────────────────────────────────────
  if (!gated.has('youtube_search'))
    server.registerTool(
      'youtube_search',
      {
        description:
          'Search YouTube for videos by query. Returns video IDs, titles, descriptions, channel names, publish dates, and thumbnail URLs. Requires YOUTUBE_API_KEY env var (Google Cloud Console). Use with youtube_transcript to get full video content.',
        inputSchema: {
          query: z.string().describe('Search query string'),
          order: z
            .enum(['relevance', 'date', 'viewCount', 'rating'])
            .optional()
            .default('relevance')
            .describe('Sort order: relevance | date | viewCount | rating'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Maximum number of videos to return (1–50, default 10)'),
        },
      },
      async ({ query, order, limit }) => {
        logger.info({ tool: 'youtube_search', order, limit }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await youtubeSearch(query, cfg.youtube.apiKey, order, limit);
          const result = makeResult('youtube_search', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'youtube_search' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── arxiv_search ────────────────────────────────────────────────────────
  server.registerTool(
    'arxiv_search',
    {
      description:
        'Fast, direct search of ArXiv papers with full date range filtering. Returns title, authors, abstract, categories, published/updated dates, PDF link, and DOI. Free, no API key required. Faster than academic_search for ArXiv-only queries. Supports filtering by ArXiv category and date range (submittedDate).',
      inputSchema: {
        query: z.string().describe('Search query string'),
        category: z
          .string()
          .optional()
          .describe(
            'ArXiv category filter (e.g. "cs.AI", "cs.LG", "math.CO", "physics.hep-th"). Leave empty for all categories.',
          ),
        sortBy: z
          .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
          .optional()
          .default('relevance')
          .describe('Sort order: relevance | lastUpdatedDate | submittedDate'),
        dateFrom: z
          .string()
          .optional()
          .describe(
            'Start date (YYYY-MM-DD format, e.g. "2025-01-01"). Filters by submission date.',
          ),
        dateTo: z
          .string()
          .optional()
          .describe('End date (YYYY-MM-DD format, e.g. "2025-12-31"). Filters by submission date.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe('Maximum number of papers to return (1–50, default 20)'),
      },
    },
    async ({ query, category, sortBy, dateFrom, dateTo, limit }) => {
      logger.info(
        { tool: 'arxiv_search', category, sortBy, dateFrom, dateTo, limit },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        const data = await arxivSearch(
          query,
          category ?? null,
          sortBy,
          dateFrom ?? null,
          dateTo ?? null,
          limit,
        );
        const result = makeResult('arxiv_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'arxiv_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── stackoverflow_search ────────────────────────────────────────────────
  server.registerTool(
    'stackoverflow_search',
    {
      description:
        'Search Stack Overflow questions via the Stack Exchange API. Returns questions with title, body, score, answer count, tags, and author. Supports filtering by tags and accepted-answer status. RATE LIMIT WARNING: Without a STACKEXCHANGE_API_KEY env var, the limit is only 300 requests/day (shared IP quota) — results may be empty or degraded. Set STACKEXCHANGE_API_KEY (free, register at stackapps.com) for 10,000 requests/day.',
      inputSchema: {
        query: z.string().describe('Search query string'),
        sort: z
          .enum(['relevance', 'votes', 'creation', 'activity'])
          .optional()
          .default('relevance')
          .describe('Sort order: relevance | votes | creation | activity'),
        tagged: z
          .string()
          .optional()
          .default('')
          .describe(
            'Semicolon-separated tags to filter by (e.g. "javascript;react"). Leave empty for no tag filter.',
          ),
        accepted: z
          .boolean()
          .optional()
          .default(false)
          .describe('Only return questions with accepted answers (default false)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum number of questions to return (1–100, default 20)'),
      },
    },
    async ({ query, sort, tagged, accepted, limit }) => {
      logger.info({ tool: 'stackoverflow_search', sort, tagged, accepted, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await stackoverflowSearch(
          query,
          cfg.stackexchange.apiKey,
          sort,
          tagged,
          accepted,
          limit,
        );
        const result = makeResult('stackoverflow_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'stackoverflow_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── npm_search ──────────────────────────────────────────────────────────
  server.registerTool(
    'npm_search',
    {
      description:
        'Search the npm package registry. Returns package name, version, description, keywords, author, repository link, publish date, and quality score. Free, no API key required.',
      inputSchema: {
        query: z.string().describe('Search query string (e.g. "react state management")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Maximum number of packages to return (1–250, default 20)'),
      },
    },
    async ({ query, limit }) => {
      logger.info({ tool: 'npm_search', limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await npmSearch(query, limit);
        const result = makeResult('npm_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'npm_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── pypi_search ─────────────────────────────────────────────────────────
  server.registerTool(
    'pypi_search',
    {
      description:
        'Search the Python Package Index (PyPI). Returns package name, version, description, author, and release date. Free, no API key required. Top results are enriched with author info from the PyPI JSON API. NOTE: PyPI search relevance is limited — it matches keywords against package names/descriptions rather than semantic intent. For broad queries (e.g. "machine learning framework"), prefer npm_search-style exact package names or use web_search to find package recommendations first.',
      inputSchema: {
        query: z.string().describe('Search query string (e.g. "machine learning framework")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe('Maximum number of packages to return (1–50, default 20)'),
      },
    },
    async ({ query, limit }) => {
      logger.info({ tool: 'pypi_search', limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await pypiSearch(query, limit);
        const result = makeResult('pypi_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'pypi_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── news_search ─────────────────────────────────────────────────────────
  server.registerTool(
    'news_search',
    {
      description:
        'Search recent news articles via the GDELT Global Knowledge Graph. Returns article title, URL, source, domain, publish date, language, and image URL. Supports date range filtering and language selection. Free, no API key required. Excellent for "last 24 hours" or "this week" news queries.',
      inputSchema: {
        query: z.string().describe('News search query string'),
        dateFrom: z
          .string()
          .optional()
          .describe('Start date (YYYY-MM-DD format, e.g. "2025-03-01")'),
        dateTo: z.string().optional().describe('End date (YYYY-MM-DD format, e.g. "2025-03-29")'),
        language: z
          .string()
          .optional()
          .default('english')
          .describe(
            'Source language filter (e.g. "english", "spanish", "french", "german"). Default: english.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Maximum number of articles to return (1–250, default 20)'),
      },
    },
    async ({ query, dateFrom, dateTo, language, limit }) => {
      logger.info({ tool: 'news_search', dateFrom, dateTo, language, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await newsSearch(query, dateFrom ?? null, dateTo ?? null, language, limit);
        const result = makeResult('news_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'news_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── health_check ──────────────────────────────────────────────────────
  server.registerTool(
    'health_check',
    {
      description:
        'Run a live health check across all search tools. Returns per-tool status (healthy, degraded, unconfigured, rate_limited, unreachable) with remediation hints, plus an overall server status. No caching — always reflects current state. Use this to diagnose failures or verify configuration before relying on a tool.',
      inputSchema: {},
    },
    async () => {
      logger.info({ tool: 'health_check' }, 'Tool invoked');
      const start = Date.now();
      try {
        const report = await runHealthProbes(cfg);
        const result = makeResult('health_check', report, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'health_check' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  return server;
}
