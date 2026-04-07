import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, parseError, timeoutError } from '../errors.js';
import type { ProductHuntProduct } from '../types.js';

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new ToolCache<ProductHuntProduct[]>({
  maxSize: 100,
  ttlMs: 10 * 60 * 1000, // 10 minutes
});

// ── Constants ────────────────────────────────────────────────────────────────

const USER_AGENT = 'search-mcp/1.0';
const TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_LENGTH = 500;

const GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';

const GRAPHQL_QUERY = `
query SearchPosts($query: String!, $first: Int!) {
  posts(search: $query, first: $first, order: VOTES) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        votesCount
        commentsCount
        topics { edges { node { name } } }
        thumbnail { url }
        makers { name }
        createdAt
      }
    }
  }
}
`;

// ── Sort mapping for GraphQL ─────────────────────────────────────────────────

const SORT_MAP: Record<'popularity' | 'newest' | 'votes', string> = {
  popularity: 'RANKING',
  newest: 'NEWEST',
  votes: 'VOTES',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateDescription(text: string): string {
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    return text.slice(0, MAX_DESCRIPTION_LENGTH) + TRUNCATED_MARKER;
  }
  return text;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

// ── GraphQL API ──────────────────────────────────────────────────────────────

async function fetchViaGraphQL(
  query: string,
  apiToken: string,
  sort: 'popularity' | 'newest' | 'votes',
  limit: number,
): Promise<ProductHuntProduct[]> {
  assertSafeUrl(GRAPHQL_URL);

  // Build the query with the correct order parameter
  const orderValue = SORT_MAP[sort];
  const graphqlQuery = GRAPHQL_QUERY.replace('order: VOTES', `order: ${orderValue}`);

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, TIMEOUT_MS);

      try {
        const res = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({
            query: graphqlQuery,
            variables: { query, first: limit },
          }),
          signal: controller.signal,
        });

        if (res.status === 401) {
          throw unavailableError(
            'Product Hunt API returned 401 Unauthorized. The API token may be invalid or expired.',
            { statusCode: 401, backend: 'producthunt' },
          );
        }

        if (res.status === 429) {
          throw unavailableError('Product Hunt API rate limit exceeded. Try again later.', {
            statusCode: 429,
            backend: 'producthunt',
          });
        }

        if (!res.ok) {
          throw unavailableError(
            `Product Hunt API error ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'producthunt' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('Product Hunt API request timed out after 30 seconds', {
            backend: 'producthunt',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'producthunt-graphql', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, GRAPHQL_URL);

  // Safely navigate the nested GraphQL response
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw parseError('Unexpected Product Hunt API response shape', { backend: 'producthunt' });
  }

  const root = json as Record<string, unknown>;

  // Check for GraphQL errors
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const firstError = root.errors[0] as Record<string, unknown> | undefined;
    const errorMessage = firstError ? safeString(firstError.message) : 'Unknown GraphQL error';
    throw parseError(`Product Hunt GraphQL error: ${errorMessage}`, { backend: 'producthunt' });
  }

  const data = root.data;
  if (typeof data !== 'object' || data === null) {
    throw parseError('Missing "data" in Product Hunt API response', { backend: 'producthunt' });
  }

  const dataObj = data as Record<string, unknown>;
  const posts = dataObj.posts;
  if (typeof posts !== 'object' || posts === null) {
    throw parseError('Missing "posts" in Product Hunt API response', { backend: 'producthunt' });
  }

  const postsObj = posts as Record<string, unknown>;
  const edges = postsObj.edges;
  if (!Array.isArray(edges)) {
    throw parseError('Missing "edges" in Product Hunt API response', { backend: 'producthunt' });
  }

  const results: ProductHuntProduct[] = [];

  for (const edge of edges as unknown[]) {
    if (typeof edge !== 'object' || edge === null) continue;
    const edgeObj = edge as Record<string, unknown>;
    const node = edgeObj.node;
    if (typeof node !== 'object' || node === null) continue;
    const post = node as Record<string, unknown>;

    // Extract topics
    const topics: string[] = [];
    const topicsField = post.topics;
    if (typeof topicsField === 'object' && topicsField !== null) {
      const topicsObj = topicsField as Record<string, unknown>;
      const topicEdges = topicsObj.edges;
      if (Array.isArray(topicEdges)) {
        for (const te of topicEdges as unknown[]) {
          if (typeof te !== 'object' || te === null) continue;
          const teObj = te as Record<string, unknown>;
          const teNode = teObj.node;
          if (typeof teNode !== 'object' || teNode === null) continue;
          const topicNode = teNode as Record<string, unknown>;
          const topicName = safeString(topicNode.name);
          if (topicName) topics.push(topicName);
        }
      }
    }

    // Extract thumbnail
    let thumbnail: string | null = null;
    const thumbnailField = post.thumbnail;
    if (typeof thumbnailField === 'object' && thumbnailField !== null) {
      const thumbObj = thumbnailField as Record<string, unknown>;
      const thumbUrl = safeString(thumbObj.url);
      if (thumbUrl) thumbnail = thumbUrl;
    }

    // Extract first maker
    let maker: string | null = null;
    const makersField = post.makers;
    if (Array.isArray(makersField) && makersField.length > 0) {
      const firstMaker = makersField[0] as Record<string, unknown> | undefined;
      if (firstMaker) {
        const makerName = safeString(firstMaker.name);
        if (makerName) maker = makerName;
      }
    }

    const rawDescription = safeString(post.description);

    results.push({
      name: safeString(post.name),
      tagline: safeString(post.tagline),
      description: truncateDescription(rawDescription),
      url: safeString(post.url),
      votesCount: safeNumber(post.votesCount),
      commentsCount: safeNumber(post.commentsCount),
      rank: results.length + 1,
      topics,
      thumbnail,
      maker,
      launchDate: safeString(post.createdAt) || null,
    });
  }

  return results.filter((p) => Boolean(p.name)).slice(0, limit);
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function producthuntSearch(
  query: string,
  apiToken: string,
  sort: 'popularity' | 'newest' | 'votes' = 'popularity',
  limit = 20,
): Promise<ProductHuntProduct[]> {
  if (!apiToken) {
    throw unavailableError(
      'Product Hunt search requires an API token. Product Hunt uses JavaScript rendering with anti-bot detection, so scraping is not reliable. Get a token at https://www.producthunt.com/v2/oauth/applications and set PRODUCTHUNT_API_TOKEN env var.',
      { backend: 'producthunt' },
    );
  }

  const key = cacheKey('producthunt', query, sort, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Product Hunt search cache hit');
    return cached;
  }

  logger.info({ tool: 'producthunt_search', query, sort, limit }, 'Searching Product Hunt');

  const results = await fetchViaGraphQL(query, apiToken, sort, limit);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Product Hunt search complete');

  return results;
}
