import { canonicalizeRedditPermalink } from './redditPermalink.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asListingChildren(value: unknown): unknown[] {
  const listing = asRecord(value);
  const data = asRecord(listing?.data);
  return Array.isArray(data?.children) ? data.children : [];
}

function isAllowedRedditHostname(hostname: string): boolean {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com');
}

function assertValidPathSegment(
  value: string,
  kind: 'subreddit' | 'article' | 'comment',
  pattern: RegExp,
): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid Reddit thread ${kind}: "${value}"`);
  }
}

function assertIntInRange(
  value: number,
  kind: 'context' | 'depth' | 'limit',
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${kind} must be an integer between ${String(min)} and ${String(max)}`);
  }
}

function toStringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toNumberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

type RedditThreadSource = 'url' | 'permalink' | 'subreddit_article';
type RedditThreadSort = 'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa';

export interface RedditThreadLocatorInput {
  url?: string;
  permalink?: string;
  subreddit?: string;
  article?: string;
  comment?: string;
  context?: number;
  sort?: RedditThreadSort;
  depth?: number;
  limit?: number;
  showMore?: boolean;
}

export interface ParsedRedditThreadRequest {
  source: RedditThreadSource;
  subreddit: string;
  article: string;
  comment: string | undefined;
  sort: RedditThreadSort;
  depth: number | undefined;
  limit: number | undefined;
  context: number | undefined;
  showMore: boolean;
  usedOAuth: boolean;
  permalink: string;
  url: string;
}

export interface NormalizedRedditMore {
  id: string;
  parentId: string;
  depth: number;
  count: number;
  children: string[];
}

export interface NormalizedRedditComment {
  id: string;
  fullname: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  permalink: string;
  parentId: string;
  depth: number;
  replies: (NormalizedRedditComment | NormalizedRedditMore)[];
  distinguished: string | null;
  stickied: boolean;
  collapsed: boolean;
}

interface ParsedRedditPath {
  subreddit: string;
  article: string;
  slug: string | undefined;
  comment: string | undefined;
  permalink: string;
}

function parseRedditPath(inputPath: string): ParsedRedditPath {
  const cleanPath = inputPath.replace(/\.json$/u, '');
  const segments = cleanPath.split('/').filter((segment) => segment.length > 0);

  if (segments.length < 4 || segments.length > 6) {
    throw new Error(`Unsupported Reddit thread path: "${inputPath}"`);
  }

  if (segments[0] !== 'r' || segments[2] !== 'comments') {
    throw new Error(`Unsupported Reddit thread path: "${inputPath}"`);
  }

  const subreddit = segments[1];
  const article = segments[3];
  const slug = segments[4];
  if (subreddit === undefined || article === undefined) {
    throw new Error(`Unsupported Reddit thread path: "${inputPath}"`);
  }

  const comment = segments[5];
  return {
    subreddit,
    article,
    slug,
    comment,
    permalink: cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`,
  };
}

function parseLocatorFromUrl(url: string): ParsedRedditPath {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid Reddit thread URL scheme: "${parsed.protocol}"`);
  }
  if (!isAllowedRedditHostname(parsed.hostname.toLowerCase())) {
    throw new Error(`Invalid Reddit thread URL host: "${parsed.hostname}"`);
  }
  return parseRedditPath(parsed.pathname);
}

function buildRedditThreadPermalink(
  subreddit: string,
  article: string,
  slug: string | undefined,
  comment: string | undefined,
): string {
  const basePath =
    slug === undefined
      ? `/r/${subreddit}/comments/${article}/`
      : `/r/${subreddit}/comments/${article}/${slug}/`;
  if (comment === undefined) {
    return basePath;
  }

  const effectiveSlug = slug ?? '_';
  return `/r/${subreddit}/comments/${article}/${effectiveSlug}/${comment}/`;
}

export function parseRedditThreadLocator(
  input: RedditThreadLocatorInput,
): ParsedRedditThreadRequest {
  const hasUrl = input.url !== undefined;
  const hasPermalink = input.permalink !== undefined;
  const hasSubredditArticle = input.subreddit !== undefined || input.article !== undefined;
  const locatorCount = [hasUrl, hasPermalink, hasSubredditArticle].filter(Boolean).length;

  if (locatorCount !== 1) {
    throw new Error('Exactly one Reddit thread locator form is required');
  }
  if (input.comment !== undefined) {
    assertValidPathSegment(input.comment, 'comment', /^[A-Za-z0-9]+$/);
  }
  if (input.context !== undefined) {
    if (input.comment === undefined) {
      throw new Error('context is only valid when comment is provided');
    }
    assertIntInRange(input.context, 'context', 0, 8);
  }
  if (input.depth !== undefined) {
    assertIntInRange(input.depth, 'depth', 1, 10);
  }
  if (input.limit !== undefined) {
    assertIntInRange(input.limit, 'limit', 1, 100);
  }

  let source: RedditThreadSource;
  let parsed: ParsedRedditPath;

  if (input.url !== undefined) {
    source = 'url';
    parsed = parseLocatorFromUrl(input.url);
  } else if (input.permalink !== undefined) {
    source = 'permalink';
    parsed = parseRedditPath(input.permalink);
  } else {
    if (input.subreddit === undefined || input.article === undefined) {
      throw new Error('subreddit and article are both required together');
    }
    assertValidPathSegment(input.subreddit, 'subreddit', /^[A-Za-z0-9_]{1,21}$/);
    assertValidPathSegment(input.article, 'article', /^[A-Za-z0-9]+$/);
    source = 'subreddit_article';
    parsed = {
      subreddit: input.subreddit,
      article: input.article,
      slug: undefined,
      comment: undefined,
      permalink: `/r/${input.subreddit}/comments/${input.article}/`,
    };
  }

  const effectiveComment = input.comment ?? parsed.comment;
  const resolvedPermalink = buildRedditThreadPermalink(
    parsed.subreddit,
    parsed.article,
    parsed.slug,
    effectiveComment,
  );

  return {
    source,
    subreddit: parsed.subreddit,
    article: parsed.article,
    comment: effectiveComment,
    sort: input.sort ?? 'confidence',
    depth: input.depth,
    limit: input.limit,
    context: input.context,
    showMore: input.showMore ?? false,
    usedOAuth: false,
    permalink: resolvedPermalink,
    url: canonicalizeRedditPermalink(resolvedPermalink),
  };
}

function normalizeMoreNode(data: Record<string, unknown>): NormalizedRedditMore {
  return {
    id: toStringOr(data.id),
    parentId: toStringOr(data.parent_id),
    depth: toNumberOr(data.depth),
    count: toNumberOr(data.count),
    children: Array.isArray(data.children)
      ? data.children.filter((child): child is string => typeof child === 'string')
      : [],
  };
}

const MAX_NORMALIZE_DEPTH = 64;

function normalizeCommentNode(
  data: Record<string, unknown>,
  showMore: boolean,
  omittedMore: NormalizedRedditMore[],
  depth = 0,
): NormalizedRedditComment {
  const base = {
    id: toStringOr(data.id),
    fullname: toStringOr(data.name),
    author: toStringOr(data.author),
    body: toStringOr(data.body),
    score: toNumberOr(data.score),
    createdUtc: toNumberOr(data.created_utc),
    permalink: canonicalizeRedditPermalink(toStringOr(data.permalink)),
    parentId: toStringOr(data.parent_id),
    depth: toNumberOr(data.depth),
    distinguished: typeof data.distinguished === 'string' ? data.distinguished : null,
    stickied: data.stickied === true,
    collapsed: data.collapsed === true,
  };

  if (depth > MAX_NORMALIZE_DEPTH) {
    return { ...base, replies: [] };
  }

  const replies = asRecord(data.replies);
  const nestedReplies: (NormalizedRedditComment | NormalizedRedditMore)[] = [];

  for (const child of asListingChildren(replies)) {
    const childRecord = asRecord(child);
    const kind = toStringOr(childRecord?.kind);
    const childData = asRecord(childRecord?.data);
    if (!childData) continue;

    if (kind === 'more') {
      const more = normalizeMoreNode(childData);
      if (showMore) {
        nestedReplies.push(more);
      } else {
        omittedMore.push(more);
      }
      continue;
    }

    if (kind === 't1') {
      nestedReplies.push(normalizeCommentNode(childData, showMore, omittedMore, depth + 1));
    }
  }

  return { ...base, replies: nestedReplies };
}

export function normalizeRedditThreadResponse(
  response: unknown,
  request: ParsedRedditThreadRequest,
): {
  post: {
    id: string;
    fullname: string;
    title: string;
    selftext: string;
    author: string;
    subreddit: string;
    score: number;
    numComments: number;
    createdUtc: number;
    permalink: string;
    url: string;
    isVideo: boolean;
  };
  comments: (NormalizedRedditComment | NormalizedRedditMore)[];
  more: NormalizedRedditMore[];
  request: ParsedRedditThreadRequest;
} {
  if (!Array.isArray(response) || response.length < 2) {
    throw new Error('Unexpected Reddit thread response shape');
  }

  const listings: unknown[] = response;
  const postListing = listings[0];
  const commentListing = listings[1];
  const postChildren = asListingChildren(postListing);
  const postChild = asRecord(postChildren[0]);
  const postData = asRecord(postChild?.data);
  if (!postData) {
    throw new Error('Unexpected Reddit thread response shape');
  }

  const omittedMore: NormalizedRedditMore[] = [];
  const comments: (NormalizedRedditComment | NormalizedRedditMore)[] = [];

  for (const child of asListingChildren(commentListing)) {
    const childRecord = asRecord(child);
    const kind = toStringOr(childRecord?.kind);
    const childData = asRecord(childRecord?.data);
    if (!childData) continue;

    if (kind === 'more') {
      const more = normalizeMoreNode(childData);
      if (request.showMore) {
        comments.push(more);
      } else {
        omittedMore.push(more);
      }
      continue;
    }

    if (kind === 't1') {
      comments.push(normalizeCommentNode(childData, request.showMore, omittedMore));
    }
  }

  return {
    post: {
      id: toStringOr(postData.id),
      fullname: toStringOr(postData.name),
      title: toStringOr(postData.title),
      selftext: toStringOr(postData.selftext),
      author: toStringOr(postData.author),
      subreddit: toStringOr(postData.subreddit),
      score: toNumberOr(postData.score),
      numComments: toNumberOr(postData.num_comments),
      createdUtc: toNumberOr(postData.created_utc),
      permalink: canonicalizeRedditPermalink(toStringOr(postData.permalink)),
      url: toStringOr(postData.url),
      isVideo: postData.is_video === true,
    },
    comments,
    more: omittedMore,
    request,
  };
}
