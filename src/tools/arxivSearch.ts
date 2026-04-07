import { logger } from '../logger.js';
import { safeResponseText, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError } from '../errors.js';
import type { ArXivPaper } from '../types.js';

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 20_000;
const ABSTRACT_MAX_LENGTH = 2000;

const cache = new ToolCache<ArXivPaper[]>({ maxSize: 100, ttlMs: 15 * 60 * 1000 });

// ── XML helpers (regex-based, no parser dependency) ──────────────────────────

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = re.exec(xml);
  return match?.[1]?.trim() ?? null;
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const val = match[1]?.trim();
    if (val !== undefined && val.length > 0) {
      results.push(val);
    }
  }
  return results;
}

function extractLinkHref(xml: string, attrMatch: string): string | null {
  const re = new RegExp(`<link[^>]*${attrMatch}[^>]*href="([^"]*)"[^>]*/?>`, 'i');
  const match = re.exec(xml);
  if (match?.[1] !== undefined) return match[1];
  const re2 = new RegExp(`<link[^>]*href="([^"]*)"[^>]*${attrMatch}[^>]*/?>`, 'i');
  const match2 = re2.exec(xml);
  return match2?.[1] ?? null;
}

function extractAllAttributes(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const val = match[1]?.trim();
    if (val !== undefined && val.length > 0) {
      results.push(val);
    }
  }
  return results;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + TRUNCATED_MARKER;
}

export async function arxivSearch(
  query: string,
  category: string | null = null,
  sortBy: 'relevance' | 'lastUpdatedDate' | 'submittedDate' = 'relevance',
  dateFrom: string | null = null,
  dateTo: string | null = null,
  limit = 20,
): Promise<ArXivPaper[]> {
  const key = cacheKey(
    'arxiv',
    query,
    category ?? '',
    sortBy,
    dateFrom ?? '',
    dateTo ?? '',
    String(limit),
  );
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'ArXiv search cache hit');
    return cached;
  }

  // Build ArXiv search query
  let searchQuery = `all:${query}`;

  // Add category filter
  if (category) {
    searchQuery = `cat:${category} AND all:${query}`;
  }

  // Add date range filter via submittedDate
  if (dateFrom ?? dateTo) {
    const from = dateFrom ? dateFrom.replace(/-/g, '') + '0000' : '*';
    const to = dateTo ? dateTo.replace(/-/g, '') + '2359' : '*';
    searchQuery += ` AND submittedDate:[${from} TO ${to}]`;
  }

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(Math.min(limit, 50)),
    sortBy,
    sortOrder: 'descending',
  });

  const url = `${ARXIV_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info(
    { tool: 'arxiv_search', category, sortBy, dateFrom, dateTo, limit },
    'Searching ArXiv',
  );

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/atom+xml',
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(`ArXiv API returned ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'arxiv',
          });
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('ArXiv API request timed out after 20 seconds', {
            backend: 'arxiv',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'arxiv-direct-search', maxAttempts: 2 },
  );

  const xml = await safeResponseText(response, url);

  const entryBlocks = xml.split('<entry>').slice(1);
  const papers: ArXivPaper[] = [];

  for (const block of entryBlocks) {
    const entryXml = block.split('</entry>')[0];
    if (entryXml === undefined) continue;

    const title = extractTag(entryXml, 'title');
    if (title === null || title.length === 0) continue;

    const rawAbstract = extractTag(entryXml, 'summary') ?? '';
    const abstract = truncateText(rawAbstract.replace(/\s+/g, ' ').trim(), ABSTRACT_MAX_LENGTH);

    // Extract author names
    const authorBlocks = extractAllTags(entryXml, 'author');
    const authors: string[] = [];
    for (const authorXml of authorBlocks) {
      const name = extractTag(authorXml, 'name');
      if (name !== null && name.length > 0) {
        authors.push(name);
      }
    }

    const publishedDate = extractTag(entryXml, 'published');
    const updatedDate = extractTag(entryXml, 'updated');

    // ArXiv ID URL
    const idUrl = extractTag(entryXml, 'id') ?? '';

    // PDF link
    const pdfUrl = extractLinkHref(entryXml, 'title="pdf"');

    // Categories
    const categories = extractAllAttributes(entryXml, 'category', 'term');

    // DOI if present
    const doi = extractTag(entryXml, 'arxiv:doi');

    papers.push({
      title: title.replace(/\s+/g, ' ').trim(),
      authors,
      abstract,
      url: idUrl,
      publishedDate: publishedDate ?? null,
      updatedDate: updatedDate ?? null,
      categories,
      pdfUrl,
      doi: doi ?? null,
    });
  }

  cache.set(key, papers);
  logger.debug({ resultCount: papers.length }, 'ArXiv direct search complete');

  return papers;
}
