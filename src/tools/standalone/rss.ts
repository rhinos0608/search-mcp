import { z } from 'zod/v4';
import Parser from 'rss-parser';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertSafeUrl, safeResponseText } from '../../httpGuards.js';
import { getUserAgent } from '../../version.js';
import { logger } from '../../logger.js';
import { makeResult, errorResponse, successResponse } from '../response.js';

const MAX_FEEDS = 20;
const parser = new Parser();

interface RssEntry {
  title: string;
  link: string | null;
  guid: string | null;
  published: string | null;
  author: string | null;
  categories: string[];
  contentSnippet: string;
}

interface RssFeedResult {
  title: string | null;
  description: string | null;
  link: string | null;
  feedUrl: string;
  entries: RssEntry[];
}

function requireUrl(url: string | undefined): string {
  if (url === undefined || url.trim().length === 0) {
    throw new Error('url is required for rss.parse and rss.search');
  }
  return url.trim();
}

function requireQuery(query: string | undefined): string {
  if (query === undefined || query.trim().length === 0) {
    throw new Error('query is required for rss.search');
  }
  return query.trim();
}

function normalizeCategories(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];
  return categories.filter((category): category is string => typeof category === 'string');
}

function normalizeEntry(item: Parser.Item): RssEntry {
  const contentSnippet = item.contentSnippet ?? item.summary ?? item.content ?? '';
  const extra = item as Parser.Item & { author?: string };
  return {
    title: item.title ?? '',
    link: item.link ?? null,
    guid: item.guid ?? null,
    published: item.isoDate ?? item.pubDate ?? null,
    author: item.creator ?? extra.author ?? null,
    categories: normalizeCategories(item.categories),
    contentSnippet,
  };
}

async function fetchFeed(url: string, limit: number): Promise<RssFeedResult> {
  assertSafeUrl(url);
  const res = await fetch(url, {
    headers: {
      Accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'User-Agent': getUserAgent('rss'),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Feed fetch failed with HTTP ${String(res.status)}`);
  }
  const text = await safeResponseText(res, url);
  const feed = await parser.parseString(text);
  return {
    title: feed.title ?? null,
    description: feed.description ?? null,
    link: feed.link ?? null,
    feedUrl: url,
    entries: feed.items.slice(0, limit).map(normalizeEntry),
  };
}

function entryMatches(entry: RssEntry, query: string): boolean {
  const needle = query.toLowerCase();
  const haystack = [
    entry.title,
    entry.link ?? '',
    entry.guid ?? '',
    entry.author ?? '',
    entry.contentSnippet,
    entry.categories.join(' '),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function parseSince(since: string | undefined): number {
  if (since === undefined || since.trim().length === 0) return 0;
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) {
    throw new Error('since must be an ISO date or any Date.parse-compatible timestamp');
  }
  return timestamp;
}

function entryTime(entry: RssEntry): number {
  if (entry.published === null) return 0;
  const timestamp = Date.parse(entry.published);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function registerRssTool(server: McpServer): void {
  server.registerTool(
    'rss',
    {
      description:
        'Parse RSS/Atom feeds, search feed entries, or monitor multiple feeds for entries newer than a timestamp. Free, no API key required.',
      inputSchema: {
        action: z
          .enum(['parse', 'search', 'monitor'])
          .describe(
            'parse: read one feed; search: filter one feed by query; monitor: read multiple feeds and return entries newer than since',
          ),
        url: z.url().optional().describe('Feed URL for parse/search'),
        urls: z.array(z.url()).min(1).max(MAX_FEEDS).optional().describe('Feed URLs for monitor'),
        query: z.string().optional().describe('Keyword filter for search or monitor'),
        since: z.string().optional().describe('Return monitor entries after this timestamp'),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ action, url, urls, query, since, limit }) => {
      logger.info({ tool: 'rss', action, limit }, 'Tool invoked');
      const start = Date.now();
      try {
        if (action === 'parse') {
          const feed = await fetchFeed(requireUrl(url), limit);
          return successResponse(makeResult('rss', feed, Date.now() - start));
        }

        if (action === 'search') {
          const searchQuery = requireQuery(query);
          const feed = await fetchFeed(requireUrl(url), limit);
          const result = {
            ...feed,
            entries: feed.entries.filter((entry) => entryMatches(entry, searchQuery)),
            query: searchQuery,
          };
          return successResponse(makeResult('rss', result, Date.now() - start));
        }

        const feedUrls = urls;
        if (feedUrls === undefined || feedUrls.length === 0) {
          throw new Error('urls is required for rss.monitor');
        }
        const sinceTime = parseSince(since);
        const feeds = await Promise.all(feedUrls.map((feedUrl) => fetchFeed(feedUrl, limit)));
        const searchQuery = query?.trim();
        const entries = feeds.flatMap((feed) =>
          feed.entries
            .filter((entry) => entryTime(entry) > sinceTime)
            .filter(
              (entry) =>
                searchQuery === undefined ||
                searchQuery.length === 0 ||
                entryMatches(entry, searchQuery),
            )
            .map((entry) => ({ ...entry, feedTitle: feed.title, feedUrl: feed.feedUrl })),
        );
        entries.sort((a, b) => entryTime(b) - entryTime(a));
        const result = {
          since: since ?? null,
          query: searchQuery ?? null,
          feeds: feeds.map((feed) => ({
            title: feed.title,
            feedUrl: feed.feedUrl,
            link: feed.link,
          })),
          entries: entries.slice(0, limit),
        };
        return successResponse(makeResult('rss', result, Date.now() - start));
      } catch (err: unknown) {
        logger.error({ err, tool: 'rss', action }, 'Tool failed');
        return errorResponse(err, 'rss');
      }
    },
  );
}
