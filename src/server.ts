import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from './semanticLimits.js';
import { compactSemanticResponse } from './utils/semanticResponse.js';
import { webSearch } from './tools/webSearch.js';
import { getGitHubRepo } from './tools/githubRepo.js';
import { getGitHubTrending } from './tools/githubTrending.js';
import { getGitHubRepoTree } from './tools/githubRepoTree.js';
import { getGitHubRepoFile } from './tools/githubRepoFile.js';
import { getGitHubRepoSearch } from './tools/githubRepoSearch.js';
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
import { webCrawl } from './tools/webCrawl.js';
import { webRead } from './tools/webRead.js';
import { semanticCrawl } from './tools/semanticCrawl.js';
import { semanticYoutube } from './tools/semanticYoutube.js';
import { semanticReddit } from './tools/semanticReddit.js';
import { semanticJobs } from './tools/semanticJobs.js';
import { isToolError } from './errors.js';
import type { RateLimitInfo } from './rateLimit.js';
import type { ToolResult } from './types.js';
import { configHealth, getGatedTools, runHealthProbes } from './health.js';
import {
  extractionConfigSchema,
  validateExtractionConfig,
  type ExtractionConfig,
} from './utils/extractionConfig.js';
import type { LlmConfig } from './config.js';

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

/** Build llmFallback config for Crawl4AI extraction when LLM strategy is used. */
function buildLlmFallback(
  extractionConfig: ExtractionConfig | undefined,
  llm: LlmConfig,
): { provider: string; apiToken: string; baseUrl?: string } | undefined {
  if (extractionConfig?.type !== 'llm') return undefined;
  return {
    provider: extractionConfig.llmProvider ?? llm.provider,
    apiToken: llm.apiToken,
    ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
  };
}

/** Build extraction warnings: pages that succeeded but returned no extractedData. */
function extractionWarnings(data: {
  pages: { url: string; success: boolean; extractedData?: unknown }[];
}): string[] {
  const warnings: string[] = [];
  for (const page of data.pages) {
    if (page.success && !page.extractedData) {
      warnings.push(`Extraction produced no data for ${page.url}`);
    }
  }
  return warnings;
}

/** Normalize a Readability article into the WebCrawlResult shape. */
function readabilityFallbackResult(
  url: string,
  article: import('./types.js').ArticleResult,
  strategy: 'bfs' | 'dfs',
  maxDepth: number,
  maxPages: number,
): import('./types.js').WebCrawlResult {
  return {
    seedUrl: url,
    strategy,
    maxDepth,
    maxPages,
    totalPages: 1,
    successfulPages: 1,
    pages: [
      {
        url,
        success: true,
        markdown: article.textContent,
        title: article.title ?? '',
        description: article.description ?? '',
        links: [],
        statusCode: null,
        errorMessage: null,
        ...(article.elements !== undefined &&
          article.elements.length > 0 && { elements: article.elements }),
        ...(article.truncatedElements !== undefined && {
          truncatedElements: article.truncatedElements,
        }),
        ...(article.originalElementCount !== undefined && {
          originalElementCount: article.originalElementCount,
        }),
        ...(article.omittedElementCount !== undefined && {
          omittedElementCount: article.omittedElementCount,
        }),
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

  // ── web_read (crawl4ai) ────────────────────────────────────────────────────
  server.registerTool(
    'web_read',
    {
      description:
        'Fetch and parse a web page via crawl4ai headless browser. Handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. Returns clean LLM-ready Markdown with title, description, and extracted links. [DEPRECATED] Use web_crawl for deep crawling support.',
      inputSchema: {
        url: z
          .url()
          .describe('The fully-qualified URL of the page to read (must include https://)'),
        strategy: z
          .enum(['bfs', 'dfs'])
          .optional()
          .default('bfs')
          .describe('Crawl strategy (default bfs)'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1)
          .describe('Max link depth to follow (1–5, default 1 = single page)'),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(1)
          .describe('Max pages to crawl (1–100, default 1)'),
        includeExternalLinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow external domain links (default false)'),
        extractionConfig: extractionConfigSchema
          .optional()
          .describe(
            'Optional structured data extraction config. Only works when crawl4ai is configured; ignored in Readability fallback.',
          ),
      },
    },
    async ({ url, strategy, maxDepth, maxPages, includeExternalLinks, extractionConfig }) => {
      logger.info({ tool: 'web_read' }, 'Tool invoked');
      const start = Date.now();
      try {
        if (extractionConfig) {
          validateExtractionConfig(extractionConfig, cfg.llm);
        }

        let data: import('./types.js').WebCrawlResult;
        const warnings: string[] = [];

        if (cfg.crawl4ai.baseUrl) {
          const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
          data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            ...(extractionConfig ? { extractionConfig } : {}),
            ...(llmFallback ? { llmFallback } : {}),
          });
          warnings.push(...extractionWarnings(data));
        } else {
          if (extractionConfig) {
            warnings.push(
              'extractionConfig is ignored when crawl4ai is not configured (Readability fallback does not support structured extraction)',
            );
          }
          logger.debug('crawl4ai not configured — falling back to webRead (Readability)');
          const article = await webRead(url);
          data = readabilityFallbackResult(url, article, strategy, maxDepth, maxPages);
        }

        const result = makeResult('web_read', data, Date.now() - start, { warnings });
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

  // ── github_repo_tree ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_tree',
    {
      description:
        'List the directory structure of a GitHub repository. Supports recursive tree listing and path-based browsing.',
      inputSchema: {
        owner: z
          .string()
          .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
          .describe('GitHub username or organisation'),
        repo: z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,100}$/)
          .describe('Repository name'),
        path: z.string().optional().default('').describe('Directory path within the repo'),
        branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
        recursive: z.boolean().optional().default(false).describe('Return full recursive tree'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe('Max items to return (1–500)'),
      },
    },
    async ({ owner, repo, path, branch, recursive, limit }) => {
      logger.info({ tool: 'github_repo_tree', owner, repo, path, recursive }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepoTree(owner, repo, path, branch, recursive, limit);
        const opts = data.warnings && data.warnings.length > 0 ? { warnings: data.warnings } : {};
        const result = makeResult('github_repo_tree', data, Date.now() - start, opts);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_tree' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_repo_file ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_file',
    {
      description:
        'Read the raw content of a specific file in a GitHub repository. Supports UTF-8 text and base64 output. Handles binary detection, submodules, and symlinks. For large files, use offset/limit to read specific line ranges, or byteOffset/byteLimit for byte-level slicing.',
      inputSchema: {
        owner: z
          .string()
          .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
          .describe('GitHub username or organisation'),
        repo: z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,100}$/)
          .describe('Repository name'),
        path: z.string().describe('File path within the repo'),
        branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
        raw: z
          .boolean()
          .optional()
          .default(true)
          .describe('true = decoded UTF-8 text; false = base64'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Line offset (0-based). Read from this line number. Requires raw=true.'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of lines to return. Requires raw=true.'),
        byteOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Byte offset (0-based). Read from this byte position via raw.githubusercontent.com Range header. Requires raw=true.',
          ),
        byteLimit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of bytes to return. Requires raw=true.'),
      },
    },
    async ({ owner, repo, path, branch, raw, offset, limit, byteOffset, byteLimit }) => {
      logger.info(
        { tool: 'github_repo_file', owner, repo, path, offset, limit, byteOffset, byteLimit },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        const data = await getGitHubRepoFile(
          owner,
          repo,
          path,
          branch,
          raw,
          offset,
          limit,
          byteOffset,
          byteLimit,
        );
        const result = makeResult('github_repo_file', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_file' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_repo_search ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_search',
    {
      description:
        'Search code across GitHub using the GitHub Search API. Supports repo-scoped, language, and path filtering. Results include code snippets with highlight positions.',
      inputSchema: {
        query: z.string().describe('Search term (GitHub code-search syntax)'),
        owner: z.string().optional().describe('Narrow to a specific user or org'),
        repo: z.string().optional().describe('Narrow to a specific repo (requires owner)'),
        language: z.string().optional().describe('Filter by language (e.g. "typescript")'),
        path: z.string().optional().describe('Filter to files under this path'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(30)
          .describe('Max results (1–1000)'),
      },
    },
    async ({ query, owner, repo, language, path, limit }) => {
      logger.info({ tool: 'github_repo_search', query, owner, repo }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepoSearch(query, owner, repo, language, path, limit);
        const result = makeResult('github_repo_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_search' }, 'Tool failed');
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

  // ── semantic_youtube ─────────────────────────────────────────────────────
  if (!gated.has('semantic_youtube'))
    server.registerTool(
      'semantic_youtube',
      {
        description:
          'Search YouTube for videos, fetch their transcripts, and return the most semantically relevant transcript passages for a specific query. ' +
          'Uses the same RAG pipeline as semantic_crawl: embed → BM25 → RRF fusion → top-K trim. ' +
          'Requires YOUTUBE_API_KEY and EMBEDDING_SIDECAR_BASE_URL.',
        inputSchema: {
          query: z.string().describe('The semantic search query — what are you looking for?'),
          maxVideos: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe('Maximum number of videos to search (1–50, default 20)'),
          channel: z
            .string()
            .optional()
            .describe(
              'Filter results to videos from channels whose name contains this string (case-insensitive)',
            ),
          sort: z
            .enum(['relevance', 'date', 'viewCount'])
            .optional()
            .default('relevance')
            .describe('Sort order for video search: relevance | date | viewCount'),
          transcriptLanguage: z
            .string()
            .optional()
            .default('en')
            .describe('BCP-47 language code for transcript captions (default "en")'),
          profile: z
            .enum(['balanced', 'fast', 'precision', 'recall'])
            .optional()
            .default('balanced')
            .describe('Retrieval profile: balanced | fast | precision | recall'),
          topK: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Number of most-relevant transcript passages to return (1–50, default 10)'),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(DEFAULT_SEMANTIC_MAX_BYTES)
            .optional()
            .default(DEFAULT_SEMANTIC_MAX_BYTES)
            .describe('Maximum total bytes of transcript chunks to embed (1–250MB, default 250MB)'),
        },
      },
      async ({ query, maxVideos, channel, sort, transcriptLanguage, profile, topK, maxBytes }) => {
        logger.info({ tool: 'semantic_youtube', query, maxVideos, maxBytes }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await semanticYoutube({
            query,
            apiKey: cfg.youtube.apiKey,
            embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
            embeddingApiToken: cfg.embeddingSidecar.apiToken || undefined,
            embeddingDimensions: cfg.embeddingSidecar.dimensions,
            maxVideos,
            channel: channel !== '' ? channel : undefined,
            sort,
            transcriptLanguage,
            profile,
            topK,
            maxBytes,
          });
          const result = makeResult(
            'semantic_youtube',
            compactSemanticResponse(data),
            Date.now() - start,
            {
              ...(data.warnings && data.warnings.length > 0 ? { warnings: data.warnings } : {}),
            },
          );
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'semantic_youtube' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── semantic_reddit ──────────────────────────────────────────────────────
  if (!gated.has('semantic_reddit'))
    server.registerTool(
      'semantic_reddit',
      {
        description:
          'Search Reddit for posts, fetch their comment threads, and return the most semantically relevant comments for a specific query. ' +
          'Uses the same RAG pipeline as semantic_crawl: embed → BM25 → RRF fusion → top-K trim. ' +
          'Deleted and removed comments are automatically filtered. Requires EMBEDDING_SIDECAR_BASE_URL.',
        inputSchema: {
          query: z.string().describe('The semantic search query — what are you looking for?'),
          subreddit: z
            .string()
            .optional()
            .default('')
            .describe(
              'Restrict search to this subreddit (without r/ prefix). Leave empty to search all of Reddit.',
            ),
          sort: z
            .enum(['relevance', 'hot', 'new', 'top'])
            .optional()
            .default('relevance')
            .describe('Sort order for post search: relevance | hot | new | top'),
          timeframe: z
            .enum(['hour', 'day', 'week', 'month', 'year', 'all'])
            .optional()
            .default('year')
            .describe('Time window for results: hour | day | week | month | year | all'),
          maxPosts: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .default(10)
            .describe('Maximum number of posts to fetch comments for (1–25, default 10)'),
          commentLimit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .default(100)
            .describe('Maximum comments to fetch per post (1–500, default 100)'),
          profile: z
            .enum(['balanced', 'fast', 'precision', 'recall'])
            .optional()
            .default('balanced')
            .describe('Retrieval profile: balanced | fast | precision | recall'),
          topK: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Number of most-relevant comment passages to return (1–50, default 10)'),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(DEFAULT_SEMANTIC_MAX_BYTES)
            .optional()
            .default(DEFAULT_SEMANTIC_MAX_BYTES)
            .describe('Maximum total bytes of comment chunks to embed (1–250MB, default 250MB)'),
        },
      },
      async ({
        query,
        subreddit,
        sort,
        timeframe,
        maxPosts,
        commentLimit,
        profile,
        topK,
        maxBytes,
      }) => {
        logger.info({ tool: 'semantic_reddit', query, maxPosts, maxBytes }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await semanticReddit({
            query,
            subreddit: subreddit || undefined,
            sort,
            timeframe,
            maxPosts,
            commentLimit,
            embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
            embeddingApiToken: cfg.embeddingSidecar.apiToken || undefined,
            embeddingDimensions: cfg.embeddingSidecar.dimensions,
            profile,
            topK,
            maxBytes,
          });
          const result = makeResult(
            'semantic_reddit',
            compactSemanticResponse(data),
            Date.now() - start,
            {
              ...(data.warnings && data.warnings.length > 0 ? { warnings: data.warnings } : {}),
            },
          );
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'semantic_reddit' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── semantic_jobs ────────────────────────────────────────────────────────
  if (!gated.has('semantic_jobs'))
    server.registerTool(
      'semantic_jobs',
      {
        description:
          'Search for job listings across job boards (SEEK, Indeed, Jora), extract structured fields (title, company, location, salary, work mode), ' +
          'apply constraint filters, rank with weighted composite scoring, and return structured job results. ' +
          'Uses web search + crawl for discovery, then extracts structured data from listing pages. ' +
          'Requires EMBEDDING_SIDECAR_BASE_URL for semantic ranking. Falls back to constraint-only ranking without it.',
        inputSchema: {
          query: z
            .string()
            .describe('The job search query (e.g. "frontend developer", "data entry admin")'),
          location: z
            .array(z.string())
            .optional()
            .describe(
              'Preferred locations (e.g. ["Sydney", "Melbourne"]). Used for ranking boost, not hard filter.',
            ),
          workMode: z
            .array(z.enum(['remote', 'hybrid', 'onsite']))
            .optional()
            .describe('Preferred work modes. Used for ranking boost, not hard filter.'),
          maxSalary: z
            .number()
            .positive()
            .optional()
            .describe(
              'Maximum annual salary. Listings with parseable salary exceeding this are filtered out.',
            ),
          excludeTitles: z
            .array(z.string())
            .optional()
            .describe('Title keywords to exclude (e.g. ["senior", "principal", "manager"])'),
          maxPages: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe('Maximum number of job listing pages to crawl (1–50, default 20)'),
          topK: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Number of top-ranked job listings to return (1–50, default 10)'),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(DEFAULT_SEMANTIC_MAX_BYTES)
            .optional()
            .default(DEFAULT_SEMANTIC_MAX_BYTES)
            .describe('Maximum total bytes of listing text to embed (1–250MB, default 250MB)'),
        },
      },
      async ({ query, location, workMode, maxSalary, excludeTitles, maxPages, topK, maxBytes }) => {
        logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await semanticJobs({
            query,
            embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
            ...(cfg.embeddingSidecar.apiToken
              ? { embeddingApiToken: cfg.embeddingSidecar.apiToken }
              : {}),
            embeddingDimensions: cfg.embeddingSidecar.dimensions,
            ...(location?.length ? { location } : {}),
            ...(workMode?.length ? { workMode } : {}),
            ...(maxSalary !== undefined ? { maxSalary } : {}),
            ...(excludeTitles?.length ? { excludeTitles } : {}),
            maxPages,
            topK,
            maxBytes,
          });
          const elapsed = Date.now() - start;
          const result = makeResult(
            'semantic_jobs',
            {
              results: data.results.map((scored, index) => ({
                rank: index + 1,
                overallScore: Math.round(scored.overallScore * 1000) / 1000,
                matchedConstraints: scored.matchedConstraints,
                caveats: scored.caveats,
                listing: {
                  title: scored.listing.title,
                  company: scored.listing.company,
                  location: scored.listing.location,
                  workMode: scored.listing.workMode,
                  salaryRaw: scored.listing.salaryRaw,
                  source: scored.listing.source,
                  sourceUrl: scored.listing.sourceUrl,
                  confidence: scored.listing.confidence,
                  verificationStatus: scored.listing.verificationStatus,
                },
              })),
              corpusStatus: data.corpusStatus,
            },
            elapsed,
            {
              ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
            },
          );
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'semantic_jobs' }, 'Tool failed');
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

  // ── web_crawl ────────────────────────────────────────────────────────────
  if (!gated.has('web_crawl'))
    server.registerTool(
      'web_crawl',
      {
        description:
          'Crawl a URL using a headless Playwright browser (via a crawl4ai sidecar). ' +
          'Unlike web_read, this handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. ' +
          'Returns clean LLM-ready Markdown with title, description, and extracted links for each crawled page. ' +
          'Supports deep crawling across multiple pages. Requires CRAWL4AI_BASE_URL env var (self-hosted Docker sidecar).',
        inputSchema: {
          url: z.url().describe('Seed URL to start crawling from'),
          strategy: z
            .enum(['bfs', 'dfs'])
            .optional()
            .default('bfs')
            .describe(
              'Crawl strategy: bfs (breadth-first, good for shallow wide coverage) | ' +
                'dfs (depth-first, good for deeply nested docs)',
            ),
          maxDepth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .default(1)
            .describe(
              'Maximum link depth to follow from seed URL (1–5, default 1 = single page only)',
            ),
          maxPages: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(1)
            .describe('Maximum number of pages to crawl (1–100, default 1)'),
          includeExternalLinks: z
            .boolean()
            .optional()
            .default(false)
            .describe('Follow links to external domains (default false — stays on seed domain)'),
          extractionConfig: extractionConfigSchema
            .optional()
            .describe(
              'Optional structured data extraction config. Supports css_schema, xpath_schema, regex, and llm strategies. ' +
                'Requires Crawl4AI sidecar v0.8.x or later.',
            ),
          waitFor: z
            .string()
            .optional()
            .describe(
              'Wait for a CSS selector (css:.selector) or JS expression (js:() => boolean) before extracting content. Useful for SPAs and dynamic content.',
            ),
          delayBeforeReturnHtml: z
            .number()
            .min(0)
            .max(30)
            .optional()
            .default(0.1)
            .describe(
              'Extra seconds to wait after page load for dynamic content to settle (0–30, default 0.1)',
            ),
          pageTimeout: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .default(60000)
            .describe('Page operation timeout in milliseconds (1000–300000, default 60000)'),
          jsCode: z
            .string()
            .optional()
            .describe(
              'Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More"). Runs after wait_for completes.',
            ),
        },
      },
      async ({
        url,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        extractionConfig,
        waitFor,
        delayBeforeReturnHtml,
        pageTimeout,
        jsCode,
      }) => {
        logger.info({ tool: 'web_crawl', url, strategy, maxDepth, maxPages }, 'Tool invoked');
        const start = Date.now();
        try {
          if (extractionConfig) {
            validateExtractionConfig(extractionConfig, cfg.llm);
          }

          const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);

          const data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            waitFor,
            delayBeforeReturnHtml,
            pageTimeout,
            jsCode,
            ...(extractionConfig ? { extractionConfig } : {}),
            ...(llmFallback ? { llmFallback } : {}),
          });

          const warnings = [...extractionWarnings(data), ...(data.warnings ?? [])];
          const result = makeResult('web_crawl', data, Date.now() - start, { warnings });
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'web_crawl' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );

  // ── semantic_crawl ──────────────────────────────────────────────────────
  if (!gated.has('semantic_crawl'))
    server.registerTool(
      'semantic_crawl',
      {
        description:
          'Crawl an information space and return the most semantically relevant passages for a specific query. ' +
          'Uses EmbeddingGemma (300M, local) to chunk, embed, and rank content by similarity.\n\n' +
          'USE THIS TOOL when you need to:\n' +
          '- Find specific information within a large documentation site, codebase reference, or multi-page resource\n' +
          '- Answer "how does X handle Y" or "where does X explain Z" against a known URL\n' +
          '- Research a specific topic across an entire domain without reading every page\n\n' +
          'PREFER web_crawl instead when you need full page content or are summarising an entire site.\n' +
          "PREFER web_search when you don't have a target URL.",
        inputSchema: {
          source: z
            .discriminatedUnion('type', [
              z.object({
                type: z.literal('url'),
                url: z.url().describe('Seed URL to start crawling from'),
                urls: z
                  .array(z.url())
                  .optional()
                  .describe('Additional seed URLs to crawl in the same corpus'),
              }),
              z.object({
                type: z.literal('sitemap'),
                url: z.url().describe('URL of a sitemap.xml to parse for seed URLs'),
              }),
              z.object({
                type: z.literal('search'),
                query: z
                  .string()
                  .describe('Web search query to discover seed URLs, then crawl them'),
                maxSeedUrls: z
                  .number()
                  .int()
                  .min(1)
                  .max(20)
                  .optional()
                  .default(10)
                  .describe('Max URLs to collect from web search (1–20, default 10)'),
              }),
              z.object({
                type: z.literal('github'),
                owner: z.string().describe('GitHub repository owner'),
                repo: z.string().describe('GitHub repository name'),
                branch: z.string().optional().describe('Git branch (default: repo default branch)'),
                extensions: z.array(z.string()).optional().describe('File extensions to include'),
                query: z
                  .string()
                  .optional()
                  .describe('Optional code search query to pre-filter files'),
              }),
              z.object({
                type: z.literal('cached'),
                corpusId: z
                  .string()
                  .describe(
                    'Corpus ID returned by a previous semantic_crawl call. Skip re-crawl and re-embed.',
                  ),
              }),
            ])
            .describe('Source of the corpus to crawl'),
          query: z.string().describe('The semantic search query — what are you looking for?'),
          topK: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe('Number of most-relevant chunks to return (1–50, default 10)'),
          strategy: z
            .enum(['bfs', 'dfs'])
            .optional()
            .default('bfs')
            .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
          maxDepth: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .default(2)
            .describe(
              'Maximum link depth (0–5, default 2). Set 0 for single-page / sitemap / search modes.',
            ),
          maxPages: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(20)
            .describe('Maximum pages to crawl (1–100, default 20). Divided across seeds.'),
          includeExternalLinks: z
            .boolean()
            .optional()
            .default(false)
            .describe('Follow external domain links (default false)'),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(DEFAULT_SEMANTIC_MAX_BYTES)
            .optional()
            .default(DEFAULT_SEMANTIC_MAX_BYTES)
            .describe('Maximum total bytes to crawl (1–250MB, default 250MB)'),
          useReranker: z
            .boolean()
            .optional()
            .default(false)
            .describe('Apply cross-encoder re-ranking to top candidates (default false)'),
          allowPathDrift: z
            .boolean()
            .optional()
            .default(false)
            .describe('Allow crawler to follow links outside the seed URL path (default false)'),
          extractionConfig: extractionConfigSchema
            .optional()
            .describe(
              'Optional structured data extraction config. Ignored when using cached source. Not merged into chunk embeddings.',
            ),
          waitFor: z
            .string()
            .optional()
            .describe(
              'Wait for a CSS selector (css:.selector) or JS expression (js:() => boolean) before extracting content. Useful for SPAs and dynamic content.',
            ),
          delayBeforeReturnHtml: z
            .number()
            .min(0)
            .max(30)
            .optional()
            .default(0.1)
            .describe(
              'Extra seconds to wait after page load for dynamic content to settle (0–30, default 0.1)',
            ),
          pageTimeout: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .default(60000)
            .describe('Page operation timeout in milliseconds (1000–300000, default 60000)'),
          jsCode: z
            .string()
            .optional()
            .describe(
              'Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More"). Runs after wait_for completes.',
            ),
        },
      },
      async ({
        source,
        query,
        topK,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        maxBytes,
        useReranker,
        allowPathDrift,
        extractionConfig,
        waitFor,
        delayBeforeReturnHtml,
        pageTimeout,
        jsCode,
      }) => {
        logger.info(
          { tool: 'semantic_crawl', sourceType: source.type, query, topK },
          'Tool invoked',
        );
        const start = Date.now();
        try {
          if (extractionConfig) {
            validateExtractionConfig(extractionConfig, cfg.llm);
          }

          const warnings: string[] = [];
          if (source.type === 'cached' && extractionConfig) {
            warnings.push(
              'extractionConfig is ignored when using cached source (cached sources skip crawling)',
            );
          }

          const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);

          const effectiveMaxBytes = maxBytes;
          const data = await semanticCrawl(
            {
              source,
              query,
              topK,
              strategy,
              maxDepth,
              maxPages,
              includeExternalLinks,
              maxBytes: effectiveMaxBytes,
              useReranker,
              allowPathDrift,
              waitFor,
              delayBeforeReturnHtml,
              pageTimeout,
              jsCode,
              ...(extractionConfig ? { extractionConfig } : {}),
              ...(llmFallback ? { llmFallback } : {}),
            },
            cfg.crawl4ai,
            cfg.embeddingSidecar.baseUrl,
            cfg.embeddingSidecar.apiToken,
            cfg.embeddingSidecar.dimensions,
          );
          const result = makeResult('semantic_crawl', data, Date.now() - start, {
            warnings: [...warnings, ...(data.warnings ?? [])],
          });
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'semantic_crawl' }, 'Tool failed');
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
