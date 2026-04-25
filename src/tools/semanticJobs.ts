import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  DEFAULT_SEMANTIC_MAX_BYTES,
  applySemanticByteBudget,
  formatSemanticBytes,
} from '../semanticLimits.js';
import { webSearch } from './webSearch.js';
import { webCrawl } from './webCrawl.js';
import { extractJobListingsFromHtml, documentsFromJobListings } from '../rag/adapters/job.js';
import { dedupJobListings } from '../rag/jobDedup.js';
import { applyHardFilters, rankJobListings, type JobScore } from '../rag/jobRanking.js';
import { embedTexts, embedTextsBatched } from '../rag/embedding.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import type { JobListingMvp, JobSearchConstraints } from '../rag/types/job.js';
import type { SearchResult } from '../types.js';

const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES = 50;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

export interface SemanticJobsOptions {
  query: string;
  embeddingBaseUrl: string;
  embeddingApiToken?: string;
  embeddingDimensions: number;
  location?: string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  maxSalary?: number;
  excludeTitles?: string[];
  maxPages?: number;
  topK?: number;
  maxBytes?: number;
  debug?: boolean;
}

export interface SemanticJobsCrawledPage {
  url: string;
  html?: string;
  success: boolean;
  error?: string;
}

export interface SemanticJobsResult {
  results: JobScore[];
  corpusStatus: {
    requested: number;
    fetched: number;
    failed: number;
    deduplicated: number;
  };
  warnings: string[];
}

export interface SemanticJobsDeps {
  search?: (query: string, limit: number) => Promise<SearchResult[]>;
  crawl?: (urls: string[]) => Promise<SemanticJobsCrawledPage[]>;
}

export async function semanticJobs(
  opts: SemanticJobsOptions,
  deps: SemanticJobsDeps = {},
): Promise<SemanticJobsResult> {
  const maxPages = Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES);
  const topK = Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
  const constraints = buildConstraints(opts);
  const query = buildSearchQuery(opts.query, constraints);

  logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Starting semantic job search');

  const searchFn = deps.search ?? defaultSearch;
  const crawlFn = deps.crawl ?? defaultCrawl;

  const searchResults = await searchFn(query, maxPages);
  const seedUrls = dedupUrls(searchResults.map((result) => result.url));

  if (seedUrls.length === 0) {
    return {
      results: [],
      corpusStatus: { requested: 0, fetched: 0, failed: 0, deduplicated: 0 },
      warnings: [],
    };
  }

  const crawledPages = await crawlFn(seedUrls);
  return processJobSearchResults(
    crawledPages,
    opts.query,
    constraints,
    opts.embeddingBaseUrl,
    opts.embeddingApiToken,
    opts.embeddingDimensions,
    topK,
    opts.maxBytes,
  );
}

export async function processJobSearchResults(
  crawledPages: SemanticJobsCrawledPage[],
  query: string,
  constraints: JobSearchConstraints = {},
  embeddingBaseUrl?: string,
  embeddingApiToken?: string,
  embeddingDimensions?: number,
  topK = DEFAULT_TOP_K,
  maxBytes = DEFAULT_SEMANTIC_MAX_BYTES,
): Promise<SemanticJobsResult> {
  const warnings: string[] = [];
  const successfulPages = crawledPages.filter(
    (page) => page.success && (page.html ?? '').trim().length > 0,
  );
  const failedPages = crawledPages.length - successfulPages.length;

  for (const page of crawledPages) {
    if (!page.success) {
      warnings.push(`Crawl failed for "${page.url}": ${page.error ?? 'unknown crawl failure'}`);
      logger.warn({ url: page.url, err: page.error }, 'semantic_jobs crawl failed');
    }
  }

  const extractedListings: JobListingMvp[] = [];
  for (const page of successfulPages) {
    extractedListings.push(...extractJobListingsFromHtml(page.html ?? '', page.url));
  }

  const dedupedListings = dedupJobListings(extractedListings);
  const deduplicatedCount = extractedListings.length - dedupedListings.length;
  const filteredListings = applyHardFilters(dedupedListings, constraints);

  const corpusStatus = {
    requested: crawledPages.length,
    fetched: successfulPages.length,
    failed: failedPages,
    deduplicated: deduplicatedCount,
  };

  if (filteredListings.length === 0) {
    return {
      results: [],
      corpusStatus,
      warnings,
    };
  }

  const semantic = await buildSemanticScores(
    filteredListings,
    query,
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
    topK,
    maxBytes,
    warnings,
  );

  const ranked = rankJobListings(filteredListings, query, constraints, semantic);
  return {
    results: ranked.slice(0, topK),
    corpusStatus,
    warnings,
  };
}

async function buildSemanticScores(
  listings: JobListingMvp[],
  query: string,
  embeddingBaseUrl: string | undefined,
  embeddingApiToken: string | undefined,
  embeddingDimensions: number | undefined,
  topK: number,
  maxBytes: number,
  warnings: string[],
): Promise<Map<string, number> | undefined> {
  if (!embeddingBaseUrl || embeddingDimensions === undefined) {
    return undefined;
  }

  const documents = documentsFromJobListings(listings);
  const budgeted = applySemanticByteBudget(documents, maxBytes);
  if (budgeted.truncated) {
    warnings.push(
      `Job corpus budget capped at ${formatSemanticBytes(maxBytes)}; ${String(budgeted.droppedCount)} documents omitted`,
    );
  }

  if (budgeted.items.length === 0) {
    const corpus = prepareCorpus({ adapter: 'search', documents: [] });
    const response = retrieveCorpus(corpus, {
      query,
      topK,
    });
    return mapSemanticScores(response.results);
  }

  const docTexts = budgeted.items.map((document) => document.text);
  const docTitles = budgeted.items.map((document) => document.title ?? document.id);

  const [docEmbed, queryEmbed] = await Promise.all([
    embedTextsBatched({
      baseUrl: embeddingBaseUrl,
      apiToken: embeddingApiToken,
      texts: docTexts,
      mode: 'document',
      dimensions: embeddingDimensions,
      titles: docTitles,
    }),
    embedTexts({
      baseUrl: embeddingBaseUrl,
      apiToken: embeddingApiToken,
      texts: [query],
      mode: 'query',
      dimensions: embeddingDimensions,
    }),
  ]);

  const queryEmbedding = queryEmbed.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  const corpus = prepareCorpus({
    adapter: 'search',
    documents: budgeted.items,
    embeddings: docEmbed.embeddings,
    model: docEmbed.model,
    dimensions: docEmbed.dimensions,
  });

  const response = retrieveCorpus(corpus, {
    query,
    queryEmbedding,
    topK,
  });

  return mapSemanticScores(response.results);
}

function mapSemanticScores(
  results: { item: { url: string }; score: { fused: number } }[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const result of results) {
    scores.set(result.item.url, result.score.fused);
  }
  return scores;
}

function buildConstraints(opts: SemanticJobsOptions): JobSearchConstraints {
  return {
    ...(opts.location !== undefined ? { location: opts.location } : {}),
    ...(opts.workMode !== undefined ? { workMode: opts.workMode } : {}),
    ...(opts.maxSalary !== undefined ? { maxSalary: opts.maxSalary } : {}),
    ...(opts.excludeTitles !== undefined ? { excludeTitles: opts.excludeTitles } : {}),
  };
}

function buildSearchQuery(query: string, constraints: JobSearchConstraints): string {
  const parts = [query.trim()];
  if (constraints.location !== undefined) {
    parts.push(
      ...constraints.location.map((term) => term.trim()).filter((term) => term.length > 0),
    );
  }
  if (constraints.workMode !== undefined) {
    parts.push(
      ...constraints.workMode.map((mode) => mode.trim()).filter((term) => term.length > 0),
    );
  }
  parts.push('jobs');
  return parts.filter((part) => part.length > 0).join(' ');
}

function dedupUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    deduped.push(url);
  }
  return deduped;
}

async function defaultSearch(query: string, limit: number): Promise<SearchResult[]> {
  return webSearch(query, limit);
}

async function defaultCrawl(urls: string[]): Promise<SemanticJobsCrawledPage[]> {
  const cfg = loadConfig();
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
        strategy: 'bfs',
        maxDepth: 1,
        maxPages: 1,
        includeExternalLinks: false,
      });
      const page = result.pages[0];
      return {
        url,
        html: page?.markdown ?? '',
        success: page?.success ?? false,
        ...(page?.errorMessage !== null && page?.errorMessage !== undefined
          ? { error: page.errorMessage }
          : {}),
      } satisfies SemanticJobsCrawledPage;
    }),
  );

  const pages: SemanticJobsCrawledPage[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const url = urls[index] ?? 'unknown';
    if (outcome === undefined) {
      continue;
    }

    if (outcome.status === 'fulfilled') {
      pages.push(outcome.value);
      continue;
    }

    const reason =
      outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    pages.push({
      url,
      html: '',
      success: false,
      error: reason,
    });
  }

  return pages;
}
