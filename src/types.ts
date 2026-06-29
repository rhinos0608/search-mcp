import type { RateLimitInfo } from './rateLimit.js';

// ── Fuzzy correction metadata ────────────────────────────────────────────────

export interface QueryCorrection {
  original: string;
  corrected: string;
  changes: {
    original: string;
    corrected: string;
    distance: number;
  }[];
}

export interface ToolProvenance {
  usedBackend?: string;
  servedBackends?: string[];
  usedFallback?: boolean;
  fallbackReason?: string;
  autoRoute?: {
    selectedAction: string;
    routeHint: string;
    skippedCandidates: string[];
    unavailableCandidates?: string[];
    fallbackAction?: string;
  };
}

// ToolResult<T> — every tool handler returns this
export interface ToolResult<T> {
  data: T;
  meta: {
    tool: string;
    durationMs: number;
    timestamp: string; // ISO 8601
    warnings?: string[] | undefined;
    rateLimit?: RateLimitInfo | undefined;
    correction?: QueryCorrection | undefined;
    /** Intent-driven filter metadata when the tool supports result filtering. */
    intentFilter?:
      | {
          filtered: boolean;
          totalResults: number;
          filteredCount: number;
          searchableTerms: string[];
          bytesBefore: number;
          bytesAfter: number;
        }
      | undefined;
    /** Which backend served the result and whether fallback occurred. */
    provenance?: ToolProvenance | undefined;
    /** Retry recommendation when the caller could get a richer result on re-request. */
    retry?:
      | {
          recommended: boolean;
          reason?: string;
          minimalCall?: Record<string, unknown>;
        }
      | undefined;
    /** Input normalization metadata (alias resolution, default application, ignored fields). */
    normalized?:
      | {
          aliases?: Record<string, string>;
          defaults?: Record<string, unknown>;
          ignoredFields?: string[];
        }
      | undefined;
    /** True when the result is a partial/subset (budget limit, truncation, etc.). */
    partial?: boolean | undefined;
  };
}

// SearchResult — web search item with citation metadata
export interface SearchResult {
  title: string;
  url: string;
  description: string;
  /** 1-based position in the result list (citation index). */
  position: number;
  /** Domain extracted from the result URL (e.g. "example.com"). */
  domain: string;
  /** Which search backend produced this result. */
  source: 'brave' | 'searxng' | 'exa' | 'duckduckgo' | 'ollama-search' | 'tavily';
  /** Which backends reported this result (when cross-backend merging is active). */
  engines?: string[] | undefined;
  /** Page age / publication date hint when available (e.g. "2 days ago", ISO date). */
  age: string | null;
  /** Additional snippet text beyond the primary description. */
  extraSnippet: string | null;
  /** Related deep links surfaced by the search backend (e.g. Brave deep_results buttons). */
  deepLinks: { title: string; url: string }[] | null;
}

// ── Structured Content Elements ──────────────────────────────────────────────

export interface StructuredContent {
  elements?: ContentElement[];
  truncatedElements?: true;
  originalElementCount?: number;
  omittedElementCount?: number;
}

// ArticleResult — web read
export interface ArticleResult extends StructuredContent {
  title: string | null;
  content: string; // HTML (Readability) or stripped text wrapped in <p> (fallback)
  textContent: string; // plain text
  byline: string | null;
  siteName: string | null;
  url: string;
  extractionMethod: 'readability' | 'fallback' | 'document';
  description: string | null;
  publishedDate: string | null;
  image: string | null;
}

export interface HeadingElement {
  type: 'heading';
  level: number;
  text: string;
  id: string | null;
}

export interface TextElement {
  type: 'text';
  text: string;
  truncated?: true;
  originalLength?: number;
}

export interface TableElement {
  type: 'table';
  markdown: string;
  caption: string | null;
  rows: number;
  cols: number;
  truncated?: true;
  originalLength?: number;
}

export interface ImageElement {
  type: 'image';
  src: string | null;
  alt: string;
  title: string | null;
}

export interface CodeElement {
  type: 'code';
  language: string | null;
  content: string;
  truncated?: true;
  originalLength?: number;
}

export interface ListElement {
  type: 'list';
  ordered: boolean;
  items: string[];
}

export type ContentElement =
  | HeadingElement
  | TextElement
  | TableElement
  | ImageElement
  | CodeElement
  | ListElement;

// GitHubRepo
export interface GitHubRepo extends StructuredContent {
  name: string;
  fullName: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
  topics: string[];
  defaultBranch: string;
  homepage: string | null;
  pushedAt: string;
  createdAt: string;
  latestRelease: GitHubRelease | null;
  readme: string | null;
  /** Non-null when README was requested but could not be fetched (e.g. rate limit, network error). */
  readmeError: string | null;
}

export interface GitHubRelease {
  tagName: string;
  name: string | null;
  body: string | null;
  publishedAt: string;
}

// TrendingRepo
export interface TrendingRepo {
  rank: number;
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  language: string;
  stars: number;
  todayStars: number;
  forks: number;
  url: string;
}

export interface TrendingResult {
  repos: TrendingRepo[];
  warnings: string[];
}

// TranscriptSegment
export interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
}

// YouTubeResult
export interface YouTubeResult extends StructuredContent {
  videoId: string;
  title: string | null;
  transcript: TranscriptSegment[];
  fullText: string;
}

// RedditPost
export interface RedditPost extends StructuredContent {
  title: string;
  url: string;
  selftext: string;
  score: number;
  numComments: number;
  subreddit: string;
  author: string;
  createdUtc: number;
  permalink: string;
  isVideo: boolean;
}

// ── Twitter / X ─────────────────────────────────────────────────────────────

export interface TwitterPost {
  author: string;
  handle: string;
  content: string;
  url: string;
  timestamp: string | null;
  likes: number;
  retweets: number;
  replies: number;
}

// ── Product Hunt ────────────────────────────────────────────────────────────

export interface ProductHuntProduct {
  name: string;
  tagline: string;
  description: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  rank: number;
  topics: string[];
  thumbnail: string | null;
  maker: string | null;
  launchDate: string | null;
}

// ── Patent ──────────────────────────────────────────────────────────────────

export interface PatentResult {
  patentNumber: string;
  title: string;
  abstract: string;
  inventors: string[];
  assignees: string[];
  filingDate: string | null;
  grantDate: string | null;
  url: string;
  citations: number | null;
}

// ── Podcast ─────────────────────────────────────────────────────────────────

export interface PodcastResult {
  title: string;
  description: string;
  podcast: string;
  publisher: string;
  url: string;
  audioUrl: string | null;
  duration: number;
  publishedDate: string | null;
}

// ── Academic Research ────────────────────────────────────────────────────────

export interface AcademicPaper {
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  year: number | null;
  venue: string | null;
  citationCount: number | null;
  source:
    | 'arxiv'
    | 'semantic_scholar'
    | 'openalex'
    | 'crossref'
    | 'pubmed'
    | 'wikipedia'
    | 'hackernews'
    | 'stackoverflow'
    | 'datacite'
    | 'ror'
    | 'gdelt'
    | 'wikidata';
  doi: string | null;
  pdfUrl: string | null;
}

// ── Hacker News ────────────────────────────────────────────────────────────

export interface HackerNewsItem {
  id: number;
  title: string;
  url: string | null;
  author: string;
  points: number;
  numComments: number;
  createdAt: string;
  storyText: string | null;
  type: string;
  objectId: string;
}

// ── YouTube Search ─────────────────────────────────────────────────────────

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string;
}

// ── ArXiv (fast direct path) ───────────────────────────────────────────────

export interface ArXivPaper {
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  publishedDate: string | null;
  updatedDate: string | null;
  categories: string[];
  pdfUrl: string | null;
  doi: string | null;
}

// ── Stack Overflow ─────────────────────────────────────────────────────────

export interface StackOverflowQuestion extends StructuredContent {
  questionId: number;
  title: string;
  body: string;
  link: string;
  score: number;
  answerCount: number;
  isAnswered: boolean;
  acceptedAnswerId: number | null;
  tags: string[];
  creationDate: number;
  author: string;
  viewCount: number;
}

// ── npm Package ────────────────────────────────────────────────────────────

export interface NpmPackage {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  author: string | null;
  publisher: string | null;
  url: string;
  repository: string | null;
  date: string | null;
  score: number | null;
}

// ── PyPI Package ───────────────────────────────────────────────────────────

export interface PypiPackage {
  name: string;
  version: string;
  description: string;
  url: string;
  author: string | null;
  releaseDate: string | null;
}

// ── News ───────────────────────────────────────────────────────────────────

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  domain: string;
  publishedDate: string | null;
  language: string | null;
  imageUrl: string | null;
}

// ── GitHub Repo Exploration ───────────────────────────────────────────────────

export interface GitHubTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  sha?: string;
  htmlUrl: string;
  apiUrl: string;
}

export interface MonorepoPackage {
  /** Package name (from package.json `name` field, or directory name as fallback). */
  name: string;
  /** Relative path from repo root to the package directory. */
  path: string;
  /** Description from package.json, if available. */
  description: string | null;
  /** Version from package.json, if available. */
  version: string | null;
}

export interface MonorepoDetectResult {
  /** Whether monorepo markers were found. */
  detected: boolean;
  /** Inferred monorepo tool/type. */
  type: 'pnpm' | 'npm' | 'yarn' | 'lerna' | 'turborepo' | 'nx' | 'unknown';
  /** Best-guess package manager. */
  packageManager: string | null;
  /** Monorepo config files found at root (e.g. pnpm-workspace.yaml, lerna.json). */
  configFiles: string[];
  /** Workspace patterns (e.g. ["packages/*", "apps/*"]) resolved from config. */
  workspacePatterns: string[];
  /** Workspace packages (populated when fetchDetails is true). */
  packages: MonorepoPackage[];
  /** Whether package.json exists at repo root. */
  hasPackageJsonRoot: boolean;
  /** Compact textual overview of the monorepo structure. */
  packageOverview?: string;
}

export interface GitHubTreeResult {
  entries: GitHubTreeEntry[];
  truncated: boolean;
  warnings?: string[];
  /** Monorepo detection result, present when scanning root of a monorepo. */
  monorepo?: MonorepoDetectResult;
}

export interface GitHubFileResult extends StructuredContent {
  name: string;
  path: string;
  size: number;
  sha: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  htmlUrl: string;
  apiUrl: string;
  truncated: boolean;
  isBinary: boolean;
  /** Total number of lines in the file (text only). */
  totalLines: number;
  /** 0-based line offset of this chunk. */
  lineOffset: number;
  /** Max lines requested, or null when not specified. */
  lineLimit: number | null;
  /** True when there are more lines/bytes after this chunk. */
  hasMore: boolean;
  /** 0-based byte offset of this chunk, or null. */
  byteOffset: number | null;
  /** Max bytes requested, or null. */
  byteLimit: number | null;
}

export interface GitHubCodeResult {
  url: string;
  htmlUrl: string;
  repo: string;
  path: string;
  name: string;
  score: number;
  textMatches?: {
    fragment: string;
    matches: { text: string; indices: [number, number][] }[];
  }[];
}

export interface GitHubCodeSearchResult {
  totalCount: number;
  results: GitHubCodeResult[];
}

// ── Multi-type GitHub search ─────────────────────────────────────────────────

export type GitHubSearchType = 'code' | 'repositories' | 'issues' | 'commits' | 'users';

/** Normalized repository search result from /search/repositories */
export interface GitHubRepoSearchItem {
  fullName: string;
  htmlUrl: string;
  description: string;
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  updatedAt: string;
}

/** Normalized issue/PR search result from /search/issues */
export interface GitHubIssueSearchItem {
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  repoFullName: string;
  userLogin: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
}

/** Normalized user search result from /search/users */
export interface GitHubUserSearchItem {
  login: string;
  htmlUrl: string;
  type: string;
}

/** Normalized commit search result from /search/commits */
export interface GitHubCommitSearchItem {
  sha: string;
  message: string;
  htmlUrl: string;
  repoFullName: string;
  authorName: string;
  authorLogin: string | null;
  authoredAt: string;
}

export type GitHubSearchItem =
  | GitHubCodeResult
  | GitHubRepoSearchItem
  | GitHubIssueSearchItem
  | GitHubUserSearchItem
  | GitHubCommitSearchItem;

export interface GitHubMultiSearchResult {
  searchType: GitHubSearchType;
  totalCount: number;
  results: GitHubSearchItem[];
}

export interface GitHubCommitParent {
  sha: string;
  url: string;
  htmlUrl: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorEmail: string | null;
  authoredAt: string | null;
  committerName: string | null;
  committerEmail: string | null;
  committedAt: string | null;
  authorLogin: string | null;
  committerLogin: string | null;
  htmlUrl: string;
  apiUrl: string;
  commentsUrl: string;
  parents: GitHubCommitParent[];
}

export interface GitHubCommitHistoryResult {
  repository: string;
  ref: string | null;
  path: string | null;
  author: string | null;
  since: string | null;
  until: string | null;
  page: number;
  limit: number;
  hasNextPage: boolean;
  commits: GitHubCommit[];
}

export interface GitHubRefObject {
  sha: string;
  type: string;
  url: string;
}

export interface GitHubRef {
  ref: string;
  name: string;
  nodeId: string;
  url: string;
  htmlUrl: string;
  object: GitHubRefObject;
}

export interface GitHubRefsResult {
  repository: string;
  type: 'branches' | 'tags' | 'all';
  filter: string | null;
  refs: GitHubRef[];
  truncated: boolean;
}

// ── Crawl4AI ───────────────────────────────────────────────────────────────

export interface CrawlPageResult extends StructuredContent {
  url: string;
  success: boolean;
  markdown: string;
  html?: string;
  title: string | null;
  description: string | null;
  links: { href: string; text: string }[];
  statusCode: number | null;
  errorMessage: string | null;
  extractedData?: Record<string, unknown>[];
  /** Source of recovered content when the primary crawl failed. */
  recoverySource?: 'wayback' | 'google-cache' | 'aggressive-render';
}

export interface WebCrawlResult {
  seedUrl: string;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  pages: CrawlPageResult[];
  totalPages: number;
  successfulPages: number;
  warnings?: string[];
  /** Number of pages filtered out because they were detected as challenge/blocker pages (Cloudflare, CAPTCHA, etc.). */
  filteredChallenges?: number;
}

// ── Semantic Crawl ────────────────────────────────────────────────────────

export interface ScoreDetail {
  raw: number;
  normalized: number;
  corpusMin: number;
  corpusMax: number;
  median: number;
}

export interface RerankScoreDetail extends ScoreDetail {
  medianDelta: number;
  rank: number;
}

export interface SemanticCrawlChunk {
  text: string;
  url: string;
  section: string;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
  scores: {
    biEncoder: ScoreDetail;
    bm25: ScoreDetail;
    rrf: ScoreDetail;
    rerank?: RerankScoreDetail;
  };
}

export interface SemanticCrawlPageMetadata {
  url: string;
  statusCode: number | null;
  contentBytes: number;
  chunksProduced: number;
  topChunkCount: number;
  topChunkBestRank: number | null;
  paywallSuspected: boolean;
  loginWallSuspected: boolean;
  truncatedSuspected: boolean;
  consentWallSuspected: boolean;
  errorMessage: string | null;
  recoverySource?: 'wayback' | 'google-cache' | 'aggressive-render';
}

export type SemanticCrawlWarning =
  | {
      code: 'SEMANTIC_CRAWL_RESPONSE_SIZE_GUARD';
      message: string;
      requestedMaxPages: number;
      cappedMaxPages: number;
      estimatedBytes: number;
      safeBytes: number;
      avgPageBytes: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_RESPONSE_SIZE_LIMIT_APPROACHED';
      message: string;
      requestedMaxPages: number;
      pagesReturned: number;
      safeBytes: number;
      accumulatedBytes: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_CACHED_SOURCE_LIMITATION';
      message: string;
    }
  | {
      code: 'SEMANTIC_CRAWL_BUDGET_DIVISION';
      message: string;
      seedCount: number;
      requestedMaxPages: number;
      pagesPerSeed: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_SITEMAP_REORDERED';
      message: string;
      urlsFound: number;
      urlsSelected: number;
      selectedUrls: string[];
    }
  | {
      code: 'SEMANTIC_CRAWL_GITHUB_FILE_SELECTION';
      message: string;
      selectedPaths: string[];
      preFilterByContent?: boolean;
      prefilteredCandidates?: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_RANKING_FILTER';
      message: string;
      pipeline: {
        beforeCoherence: number;
        afterCoherence: number;
        afterLexical: number;
        afterRerank: number;
        requestedTopK: number;
      };
    }
  | {
      code: 'SEMANTIC_CRAWL_DOCUMENT_FALLBACK';
      message: string;
      originalUrl: string;
      fallbackUrl: string;
    }
  | {
      code: 'SEMANTIC_CRAWL_TOPK_UNMET';
      message: string;
      requestedTopK: number;
      deliveredTopK: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_SITEMAP_LOCALE_COLLAPSED';
      message: string;
      urlsBefore: number;
      urlsAfter: number;
      collapsedCount: number;
      selectedUrls: string[];
    }
  | {
      code: 'SEMANTIC_CRAWL_PATH_DRIFT_FILTERED';
      message: string;
      seedUrl: string;
      droppedCount: number;
      droppedUrls: string[];
    }
  | {
      code: 'SEMANTIC_CRAWL_PAGE_QUALITY';
      message: string;
      affectedUrls: string[];
      paywalledCount: number;
      loginWallCount: number;
      truncatedCount: number;
    }
  | {
      code: 'SEMANTIC_CRAWL_MIN_SCORE_FILTER';
      message: string;
      minScore: number;
      removedCount: number;
    };

export interface SemanticCrawlResult extends StructuredContent {
  seedUrl: string;
  query: string;
  /** Total pages attempted in the crawl (includes failed pages). */
  pagesCrawled: number;
  totalChunks: number;
  successfulPages: number;
  /** Deterministic corpus ID — pass as `source: { type: 'cached', corpusId }` to skip re-crawl. */
  corpusId: string;
  topKRequested: number;
  topKDelivered: number;
  chunks: SemanticCrawlChunk[];
  pageMetadata?: SemanticCrawlPageMetadata[];
  extractedData?: Record<string, Record<string, unknown>[]>;
  warnings?: string[];
  structuredWarnings?: SemanticCrawlWarning[];
  omittedPages?: { url: string; reason: string; estimatedBytes?: number }[];
}

export interface SemanticCrawlBatchQueryResult {
  query: string;
  topKRequested: number;
  topKDelivered: number;
  chunks: SemanticCrawlChunk[];
}

export interface SemanticCrawlBatchResult {
  seedUrl: string;
  corpusId: string;
  totalChunks: number;
  topKRequested: number;
  results: SemanticCrawlBatchQueryResult[];
  warnings?: string[];
  structuredWarnings?: SemanticCrawlWarning[];
}

// ── Semantic Crawl Sources ────────────────────────────────────────────────

export type SemanticCrawlSourceType = SemanticCrawlSource['type'];

export interface UrlSource {
  type: 'url';
  url: string;
  /** Additional seed URLs to crawl in the same corpus. */
  urls?: string[] | undefined;
}

export interface SitemapSource {
  type: 'sitemap';
  url: string;
  preferLocale?: string | undefined;
}

export interface SearchSeedSource {
  type: 'search';
  query: string;
  /** Max URLs to collect from web search (1–20, default 10). */
  maxSeedUrls?: number | undefined;
}

export interface GitHubSource {
  type: 'github';
  owner: string;
  repo: string;
  branch?: string | undefined;
  /** File extensions to include. Default: ['.md', '.mdx', '.rst', '.txt', '.py', '.ts', '.js', '.go', '.rs', '.java'] */
  extensions?: string[] | undefined;
  /** Optional code search query to pre-filter and rank files. */
  query?: string | undefined;
  /** Only include files whose path contains one of these substrings. */
  includePaths?: string[] | undefined;
  /** Exclude files whose path contains one of these substrings. */
  excludePaths?: string[] | undefined;
  /** Run a lightweight content-based prefilter before downloading full files. */
  preFilterByContent?: boolean | undefined;
}

export interface CachedSource {
  type: 'cached';
  corpusId: string;
}

export type SemanticCrawlSource =
  | UrlSource
  | SitemapSource
  | SearchSeedSource
  | GitHubSource
  | CachedSource;

// ── Corpus Chunk (adapter output, before embed+rank) ───────────────────────

export interface CorpusChunk {
  text: string;
  /** Optional alternate text used for embeddings while preserving `text` for display. */
  embedText?: string;
  url: string;
  section: string;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
}
