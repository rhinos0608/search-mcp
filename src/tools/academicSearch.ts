import { logger } from '../logger.js';
import {
  safeResponseText,
  safeResponseJson,
  assertSafeUrl,
  TRUNCATED_MARKER,
} from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError, timeoutError, parseError } from '../errors.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import type { AcademicPaper } from '../types.js';
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractAcademicSignals } from '../utils/rescore.js';
import { loadConfig } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const SEMANTIC_SCHOLAR_API_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 30_000;
const ABSTRACT_MAX_LENGTH = 2000;

const cache = new ToolCache<AcademicPaper[]>({ maxSize: 100, ttlMs: 2 * 60 * 60 * 1000 });

// ArXiv courtesy throttle: 3 seconds between requests per their API policy
let lastArxivRequestMs = 0;
const ARXIV_MIN_INTERVAL_MS = 3_000;

async function arxivCourtesyWait(): Promise<void> {
  const elapsed = Date.now() - lastArxivRequestMs;
  if (lastArxivRequestMs > 0 && elapsed < ARXIV_MIN_INTERVAL_MS) {
    const waitMs = ARXIV_MIN_INTERVAL_MS - elapsed;
    logger.debug({ waitMs }, 'ArXiv courtesy wait');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
}

// ── Normalization helpers ──────────────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // strip LaTeX commands, keep inner text
    .replace(/\$[^$]*\$/g, '') // strip math mode
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeFirstAuthor(author: string): string {
  const s = author.toLowerCase().trim();
  // "Smith, J. A." → "smith"
  if (s.includes(',')) {
    const commaMatch = /^([^,]+)/.exec(s);
    if (commaMatch?.[1] !== undefined) return commaMatch[1].trim();
  }
  // "J. A. Smith" → "smith" (last word)
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] ?? s;
}

const rescoreWeights = loadConfig().rescoreWeights.academicSearch;

// ── XML helpers (regex-based, no parser dependency) ──────────────────────────

/** Extract the text content of the first occurrence of a given XML tag. */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = re.exec(xml);
  return match?.[1]?.trim() ?? null;
}

/** Extract all text contents of a given XML tag. */
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

/** Extract href attribute from a link tag matching a specific attribute. */
function extractLinkHref(xml: string, attrMatch: string): string | null {
  const re = new RegExp(`<link[^>]*${attrMatch}[^>]*href="([^"]*)"[^>]*/?>`, 'i');
  const match = re.exec(xml);
  if (match?.[1] !== undefined) return match[1];
  // Try reversed attribute order
  const re2 = new RegExp(`<link[^>]*href="([^"]*)"[^>]*${attrMatch}[^>]*/?>`, 'i');
  const match2 = re2.exec(xml);
  return match2?.[1] ?? null;
}

/** Truncate text to a maximum length, appending a marker if truncated. */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + TRUNCATED_MARKER;
}

// ── ArXiv backend ────────────────────────────────────────────────────────────

async function searchArxiv(
  query: string,
  limit: number,
  yearFrom: number | null,
): Promise<AcademicPaper[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(limit),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });

  const url = `${ARXIV_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  await arxivCourtesyWait();

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        lastArxivRequestMs = Date.now();
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/atom+xml',
          },
          signal: controller.signal,
        });

        if (res.status === 429) {
          throw new ToolError('ArXiv API rate limit exceeded (429). Wait before retrying.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'arxiv',
          });
        }

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
          throw timeoutError('ArXiv API request timed out after 30 seconds', {
            backend: 'arxiv',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'arxiv-search', maxAttempts: 2 },
  );

  const xml = await safeResponseText(response, url);

  // Split entries from the Atom feed
  const entryBlocks = xml.split('<entry>').slice(1);
  const papers: AcademicPaper[] = [];

  for (const block of entryBlocks) {
    const entryXml = block.split('</entry>')[0];
    if (entryXml === undefined) continue;

    const title = extractTag(entryXml, 'title');
    if (title === null || title.length === 0) continue;

    const rawAbstract = extractTag(entryXml, 'summary') ?? '';
    const abstract = truncateText(rawAbstract.replace(/\s+/g, ' ').trim(), ABSTRACT_MAX_LENGTH);

    // Extract author names — each author is wrapped in <author><name>...</name></author>
    const authorBlocks = extractAllTags(entryXml, 'author');
    const authors: string[] = [];
    for (const authorXml of authorBlocks) {
      const name = extractTag(authorXml, 'name');
      if (name !== null && name.length > 0) {
        authors.push(name);
      }
    }

    // Published date for year extraction
    const published = extractTag(entryXml, 'published');
    let year: number | null = null;
    if (published !== null) {
      const yearMatch = /^(\d{4})/.exec(published);
      if (yearMatch?.[1] !== undefined) {
        year = parseInt(yearMatch[1], 10);
      }
    }

    // Filter by yearFrom if specified
    if (yearFrom !== null && (year === null || year < yearFrom)) {
      continue;
    }

    // ArXiv ID URL
    const idUrl = extractTag(entryXml, 'id') ?? '';

    // PDF link
    const pdfUrl = extractLinkHref(entryXml, 'title="pdf"');

    papers.push({
      title: title.replace(/\s+/g, ' ').trim(),
      authors,
      abstract,
      url: idUrl,
      year,
      venue: null,
      citationCount: null,
      source: 'arxiv',
      doi: null,
      pdfUrl,
    });
  }

  logger.debug({ count: papers.length }, 'ArXiv search complete');
  return papers;
}

// ── Semantic Scholar backend ─────────────────────────────────────────────────

const SEMANTIC_SCHOLAR_FIELDS = [
  'title',
  'abstract',
  'authors',
  'year',
  'venue',
  'citationCount',
  'externalIds',
  'openAccessPdf',
  'url',
].join(',');

async function searchSemanticScholar(
  query: string,
  limit: number,
  yearFrom: number | null,
): Promise<AcademicPaper[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: SEMANTIC_SCHOLAR_FIELDS,
  });

  if (yearFrom !== null) {
    params.set('year', `${String(yearFrom)}-`);
  }

  const url = `${SEMANTIC_SCHOLAR_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  await assertRateLimitOk('semantic_scholar');

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
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        getTracker('semantic_scholar').update(res.headers);

        if (res.status === 429) {
          getTracker('semantic_scholar').recordLimitHit();
          throw new ToolError('Semantic Scholar API rate limit exceeded (429). Try again later.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'semantic_scholar',
          });
        }

        if (!res.ok) {
          throw unavailableError(
            `Semantic Scholar API returned ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'semantic_scholar' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('Semantic Scholar API request timed out after 30 seconds', {
            backend: 'semantic_scholar',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'semantic-scholar-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw parseError('Unexpected Semantic Scholar API response shape', {
      backend: 'semantic_scholar',
    });
  }

  const body = json as Record<string, unknown>;
  const dataArr = body.data;

  if (!Array.isArray(dataArr)) {
    throw parseError('Semantic Scholar response missing "data" array', {
      backend: 'semantic_scholar',
    });
  }

  const papers: AcademicPaper[] = [];

  for (const item of dataArr as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const paper = item as Record<string, unknown>;

    const title = typeof paper.title === 'string' ? paper.title : '';
    if (title.length === 0) continue;

    const rawAbstract = typeof paper.abstract === 'string' ? paper.abstract : '';
    const abstract = truncateText(rawAbstract.trim(), ABSTRACT_MAX_LENGTH);

    // Authors
    const authors: string[] = [];
    if (Array.isArray(paper.authors)) {
      for (const a of paper.authors as unknown[]) {
        if (typeof a === 'object' && a !== null) {
          const authorObj = a as Record<string, unknown>;
          if (typeof authorObj.name === 'string' && authorObj.name.length > 0) {
            authors.push(authorObj.name);
          }
        }
      }
    }

    const year = typeof paper.year === 'number' ? paper.year : null;
    const venue = typeof paper.venue === 'string' && paper.venue.length > 0 ? paper.venue : null;
    const citationCount = typeof paper.citationCount === 'number' ? paper.citationCount : null;
    const paperUrl = typeof paper.url === 'string' ? paper.url : '';

    // External IDs for DOI
    let doi: string | null = null;
    if (typeof paper.externalIds === 'object' && paper.externalIds !== null) {
      const extIds = paper.externalIds as Record<string, unknown>;
      if (typeof extIds.DOI === 'string' && extIds.DOI.length > 0) {
        doi = extIds.DOI;
      }
    }

    // Open access PDF
    let pdfUrl: string | null = null;
    if (typeof paper.openAccessPdf === 'object' && paper.openAccessPdf !== null) {
      const pdfObj = paper.openAccessPdf as Record<string, unknown>;
      if (typeof pdfObj.url === 'string' && pdfObj.url.length > 0) {
        pdfUrl = pdfObj.url;
      }
    }

    papers.push({
      title,
      authors,
      abstract,
      url: paperUrl,
      year,
      venue,
      citationCount,
      source: 'semantic_scholar',
      doi,
      pdfUrl,
    });
  }

  logger.debug({ count: papers.length }, 'Semantic Scholar search complete');
  return papers;
}

// ── Deduplication & merge ────────────────────────────────────────────────────

function deduplicateByTitle(papers: AcademicPaper[]): AcademicPaper[] {
  const seen = new Map<string, AcademicPaper>();
  for (const paper of papers) {
    const normalizedTitle = paper.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = seen.get(normalizedTitle);
    if (existing === undefined) {
      seen.set(normalizedTitle, paper);
    } else {
      // Prefer the entry with more information (citation count, DOI, venue)
      if (
        (paper.citationCount !== null && existing.citationCount === null) ||
        (paper.doi !== null && existing.doi === null) ||
        (paper.venue !== null && existing.venue === null)
      ) {
        seen.set(normalizedTitle, paper);
      }
    }
  }
  return [...seen.values()];
}

function sortByCitations(papers: AcademicPaper[]): AcademicPaper[] {
  return papers.sort((a, b) => {
    // Nulls last
    if (a.citationCount === null && b.citationCount === null) return 0;
    if (a.citationCount === null) return 1;
    if (b.citationCount === null) return -1;
    return b.citationCount - a.citationCount;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AcademicSearchResult {
  papers: AcademicPaper[];
  warnings: string[];
}

export async function academicSearch(
  query: string,
  source: 'arxiv' | 'semantic_scholar' | 'all' = 'all',
  limit = 20,
  yearFrom: number | null = null,
): Promise<AcademicSearchResult> {
  logger.info({ tool: 'academic_search', source, limit, yearFrom }, 'Searching academic papers');

  const key = cacheKey('academic', query, source, String(limit), String(yearFrom ?? ''));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Academic search cache hit');
    return { papers: cached, warnings: [] };
  }

  let allPapers: AcademicPaper[] = [];
  const warnings: string[] = [];

  if (source === 'arxiv') {
    allPapers = await searchArxiv(query, limit, yearFrom);
  } else if (source === 'semantic_scholar') {
    allPapers = await searchSemanticScholar(query, limit, yearFrom);
  } else {
    const [arxivResult, ssResult] = await Promise.allSettled([
      searchArxiv(query, limit, yearFrom),
      searchSemanticScholar(query, limit, yearFrom),
    ]);

    if (arxivResult.status === 'rejected') {
      const msg = arxivResult.reason instanceof Error ? arxivResult.reason.message : String(arxivResult.reason);
      warnings.push(`ArXiv search failed: ${msg}`);
      logger.warn({ backend: 'arxiv', error: msg }, 'ArXiv search failed');
    }

    if (ssResult.status === 'rejected') {
      const msg = ssResult.reason instanceof Error ? ssResult.reason.message : String(ssResult.reason);
      warnings.push(`Semantic Scholar search failed: ${msg}`);
      logger.warn({ backend: 'semantic_scholar', error: msg }, 'Semantic Scholar search failed');
    }

    const arxivPapers = arxivResult.status === 'fulfilled' ? arxivResult.value : [];
    const ssPapers = ssResult.status === 'fulfilled' ? ssResult.value : [];

    if (arxivPapers.length === 0 && ssPapers.length === 0) {
      throw unavailableError(`Both ArXiv and Semantic Scholar APIs failed. ${warnings.join('. ')}`);
    }

    if (arxivPapers.length === 0 || ssPapers.length === 0) {
      // Only one source succeeded — fall through to existing dedup + sort pipeline
      allPapers = [...arxivPapers, ...ssPapers];
    } else {
      // Both succeeded — RRF merge + multi-signal rescoring
      const merged = rrfMerge([arxivPapers, ssPapers], {
        keyFn: (p) => p.url,
        getId: (p) => {
          if (p.doi) return p.doi.toLowerCase().trim();
          return normalizeTitle(p.title) + '|' + normalizeFirstAuthor(p.authors[0] ?? '');
        },
      });

      const currentYear = new Date().getFullYear();
      const signals = extractAcademicSignals(
        merged.map((m) => m.item),
        currentYear,
      );
      const signaled = merged.map((m, i) => {
        const signal = signals[i];
        if (signal === undefined) {
          throw new Error('Signal extraction returned fewer entries than expected');
        }
        return {
          item: m.item,
          rrfScore: m.rrfScore,
          signals: signal,
        };
      });

      const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
      const results = rescored.map((r) => r.item);

      cache.set(key, results);
      logger.debug({ resultCount: results.length, warnings }, 'Academic search complete');
      return { papers: results, warnings };
    }
  }

  // Deduplicate, sort, and limit
  const deduped = deduplicateByTitle(allPapers);
  const sorted = sortByCitations(deduped);
  const results = sorted.slice(0, limit);

  cache.set(key, results);
  logger.debug({ resultCount: results.length, warnings }, 'Academic search complete');
  return { papers: results, warnings };
}
