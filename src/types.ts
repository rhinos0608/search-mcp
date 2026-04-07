import type { RateLimitInfo } from './rateLimit.js';

// ToolResult<T> — every tool handler returns this
export interface ToolResult<T> {
  data: T;
  meta: {
    tool: string;
    durationMs: number;
    timestamp: string; // ISO 8601
    warnings?: string[] | undefined;
    rateLimit?: RateLimitInfo | undefined;
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
  source: 'brave' | 'searxng';
  /** Page age / publication date hint when available (e.g. "2 days ago", ISO date). */
  age: string | null;
  /** Additional snippet text beyond the primary description. */
  extraSnippet: string | null;
  /** Related deep links surfaced by the search backend (e.g. Brave deep_results buttons). */
  deepLinks: { title: string; url: string }[] | null;
}

// ArticleResult — web read
export interface ArticleResult {
  title: string | null;
  content: string; // HTML (Readability) or stripped text wrapped in <p> (fallback)
  textContent: string; // plain text
  byline: string | null;
  siteName: string | null;
  url: string;
  extractionMethod: 'readability' | 'fallback';
  description: string | null;
  publishedDate: string | null;
  image: string | null;
}

// GitHubRepo
export interface GitHubRepo {
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
export interface YouTubeResult {
  videoId: string;
  title: string | null;
  transcript: TranscriptSegment[];
  fullText: string;
}

// RedditPost
export interface RedditPost {
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
  source: 'arxiv' | 'semantic_scholar';
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

export interface StackOverflowQuestion {
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
