/**
 * Consolidated semantic_crawl tool family.
 *
 * Exposes semantic crawling, cached corpus listing, and corpus inspection
 * as a single MCP tool with a discriminated `action` field.
 *
 * Actions:
 *   crawl          — Crawl an information space and return semantically relevant passages
 *   list_corpora   — List cached corpora from previous semantic_crawl.crawl calls
 *   inspect_corpus — Inspect a cached corpus by corpusId
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { SemanticCrawlBatchResult, SemanticCrawlSource } from '../../types.js';
import { logger } from '../../logger.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../../semanticLimits.js';
import { semanticCrawl } from '../semanticCrawl.js';
import { listCorpora, inspectCorpus } from '../../utils/corpusCache.js';
import { extractDocumentUrl } from '../../utils/documentExtraction.js';
import { isDocumentUrl } from '../../utils/documentUtils.js';
import { readabilityFallbackResult } from '../../utils/crawlResultShaping.js';
import {
  buildLlmFallback,
  extractionConfigSchema,
  normalizeLlmForValidation,
  validateExtractionConfig,
} from '../../utils/extractionConfig.js';
import { createProgressReporter } from '../progress.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { wrapResponse } from '../response.js';

// ── Action schemas (discriminated on "action") ──────────────────────────────

const crawlSchema = z.object({
  action: z
    .literal('crawl')
    .describe('Crawl an information space and return semantically relevant passages'),
  source: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('url').describe('Crawl a URL and optionally follow links from it'),
        url: z.url().describe('Seed URL to start crawling from'),
        urls: z
          .array(z.url())
          .optional()
          .describe('Additional seed URLs to crawl in the same corpus'),
      }),
      z.object({
        type: z
          .literal('sitemap')
          .describe('Parse sitemap.xml, rank URLs against query, then crawl selected URLs'),
        url: z.url().describe('URL of a sitemap.xml to parse for seed URLs'),
        preferLocale: z
          .string()
          .optional()
          .describe(
            'Preferred locale when collapsing locale-duplicate sitemap URLs, e.g. en or en-US',
          ),
      }),
      z.object({
        type: z.literal('search').describe('Use web search to discover seed URLs, then crawl them'),
        query: z.string().describe('Web search query to discover seed URLs, then crawl them'),
        maxSeedUrls: tolerant(z.number().int().min(1).max(20))
          .optional()
          .default(10)
          .describe('Max URLs to collect from web search (1–20, default 10)'),
      }),
      z.object({
        type: z.literal('github').describe('Build a corpus from files in a GitHub repository'),
        owner: z.string().describe('GitHub repository owner'),
        repo: z.string().describe('GitHub repository name'),
        branch: z.string().optional().describe('Git branch (default: repo default branch)'),
        extensions: z.array(z.string()).optional().describe('File extensions to include'),
        query: z
          .string()
          .optional()
          .describe('Optional code search query to pre-filter and rank files'),
        includePaths: z
          .array(z.string())
          .optional()
          .describe('Only include files whose path contains one of these substrings'),
        excludePaths: z
          .array(z.string())
          .optional()
          .describe('Exclude files whose path contains one of these substrings'),
        preFilterByContent: z
          .boolean()
          .optional()
          .default(true)
          .describe('Run a lightweight content-based prefilter before downloading full files'),
      }),
      z.object({
        type: z.literal('cached').describe('Reuse a previous corpusId without crawling again'),
        corpusId: z
          .string()
          .describe(
            'Corpus ID returned by a previous semantic_crawl.crawl call. Skip re-crawl and re-embed.',
          ),
      }),
    ])
    .describe(
      'Source of the corpus to crawl. Valid source.type values: "url", "sitemap", "search", "github", "cached". ' +
        'Use "cached" with a corpusId returned by semantic_crawl.crawl, or use semantic_crawl.list_corpora to discover cached corpora.',
    ),
  query: z.string().optional().describe('The semantic search query — what are you looking for?'),
  queries: z
    .array(z.string())
    .min(1)
    .max(10)
    .optional()
    .describe('Batch query mode for cached corpora. Provide multiple queries in one call.'),
  topK: tolerant(z.number().int().min(1).max(50))
    .optional()
    .default(10)
    .describe('Number of most-relevant chunks to return (1–50, default 10)'),
  strategy: z
    .enum(['bfs', 'dfs'])
    .optional()
    .default('bfs')
    .describe(
      'Crawl strategy. bfs visits all links at depth N before depth N+1; dfs follows one path deeply before backtracking.',
    ),
  maxDepth: tolerant(z.number().int().min(0).max(5))
    .optional()
    .default(2)
    .describe(
      'Maximum link-follow depth from seed URL. 0 = only seed page(s). Sitemap/search modes force this to 0 because URLs are preselected.',
    ),
  maxPages: tolerant(z.number().int().min(1).max(100))
    .optional()
    .default(20)
    .describe(
      'Maximum total pages to crawl (1–100, default 20). The budget is divided across seed URLs and enforced client-side if Crawl4AI returns extra pages.',
    ),
  includeExternalLinks: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Follow links to external domains (default false). External pages share the same maxPages budget.',
    ),
  maxBytes: tolerant(z.number().int().min(1).max(DEFAULT_SEMANTIC_MAX_BYTES))
    .optional()
    .default(DEFAULT_SEMANTIC_MAX_BYTES)
    .describe('Maximum total bytes to crawl (1–250MB, default 250MB)'),
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
  delayBeforeReturnHtml: tolerant(z.number().min(0).max(30))
    .optional()
    .default(0.1)
    .describe(
      'Extra seconds to wait after page load for dynamic content to settle (0–30, default 0.1)',
    ),
  pageTimeout: tolerant(z.number().int().min(1000).max(300000))
    .optional()
    .default(60000)
    .describe('Page operation timeout in milliseconds (1000–300000, default 60000)'),
  jsCode: z
    .string()
    .optional()
    .describe(
      'Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More"). Runs after wait_for completes.',
    ),
});

const listCorporaSchema = z.object({
  action: z.literal('list_corpora').describe('List cached corpora from previous crawl calls'),
  limit: tolerant(z.number().int().min(1).max(100))
    .optional()
    .default(25)
    .describe('Maximum cached corpora to return (1–100, default 25)'),
});

const inspectCorpusSchema = z.object({
  action: z.literal('inspect_corpus').describe('Inspect a cached corpus by corpusId'),
  corpusId: z.string().describe('Corpus ID returned by semantic_crawl.crawl'),
});

// ── Handler helpers ─────────────────────────────────────────────────────────

interface CrawlArgs {
  source: { type: 'url' | 'sitemap' | 'search' | 'github' | 'cached'; [key: string]: unknown };
  query?: string;
  queries?: string[];
  topK: number;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes: number;
  extractionConfig?: import('../../utils/extractionConfig.js').ExtractionConfig;
  waitFor?: string;
  delayBeforeReturnHtml: number;
  pageTimeout: number;
  jsCode?: string;
}

async function handleCrawl(args: CrawlArgs, cfg: SearchConfig, extra: unknown) {
  const useReranker = false;
  const minScore = undefined as number | undefined;
  const maxChunkTokens = undefined as number | undefined;
  const allowPathDrift = false;
  const includeElements = true;
  const elementsLimit = undefined as number | undefined;
  const outputMode = 'full' as const;

  logger.info(
    {
      tool: 'semantic_crawl',
      sourceType: args.source.type,
      query: args.query,
      queryCount: args.queries?.length,
      topK: args.topK,
    },
    'Tool invoked',
  );

  // MCP-native progress reporting (coarse-grained phases)
  const extraAny = extra as
    | {
        _meta?: { progressToken?: string | number };
        sendNotification?: (n: {
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      }
    | undefined;
  const progressReporter =
    extraAny?._meta?.progressToken !== undefined && extraAny.sendNotification
      ? createProgressReporter(extraAny.sendNotification, extraAny._meta.progressToken, 100)
      : undefined;

  await progressReporter?.update(10, 'Crawling...');
  if (args.extractionConfig) {
    validateExtractionConfig(args.extractionConfig, normalizeLlmForValidation(cfg.llm));
  }

  const singleQuery = args.query?.trim();
  const batchQueries = args.queries
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0);
  if ((singleQuery ? 1 : 0) + (batchQueries && batchQueries.length > 0 ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of `query` or `queries`.');
  }

  const typedSource = args.source as unknown as SemanticCrawlSource;
  const warnings: string[] = [];
  if (typedSource.type === 'cached' && args.extractionConfig) {
    warnings.push(
      'extractionConfig is ignored when using cached source (cached sources skip crawling)',
    );
  }

  if (typedSource.type === 'url' && isDocumentUrl(typedSource.url)) {
    const documentResult = await extractDocumentUrl(typedSource.url, {
      timeoutMs: args.pageTimeout,
    });
    warnings.push(...documentResult.warnings);
    if (documentResult.success && documentResult.markdown.trim().length > 0) {
      logger.info(
        { tool: 'semantic_crawl', url: typedSource.url },
        'Document URL extracted in-process',
      );
      const article: import('../../types.js').ArticleResult = {
        url: typedSource.url,
        title: documentResult.title || null,
        textContent: documentResult.markdown,
        content: documentResult.markdown,
        extractionMethod: 'document',
        byline: null,
        siteName: null,
        description: null,
        publishedDate: null,
        image: null,
        elements: [],
      };
      const singlePage = readabilityFallbackResult(
        typedSource.url,
        article,
        args.strategy,
        args.maxDepth,
        args.maxPages,
      );
      return wrapResponse(singlePage, warnings);
    }
  }

  const llmFallback = buildLlmFallback(args.extractionConfig, cfg.llm);

  await progressReporter?.update(50, 'Embedding and ranking...');

  const resolvedQuery = singleQuery ?? '';
  const effectiveMaxBytes = args.maxBytes;

  if (batchQueries !== undefined) {
    if (typedSource.type !== 'cached') {
      throw new Error('`queries` batch mode is currently supported only for cached corpora.');
    }
    const batchResults = await Promise.all(
      batchQueries.map((batchQuery) =>
        semanticCrawl(
          {
            source: typedSource,
            query: batchQuery,
            topK: args.topK,
            ...(minScore !== undefined ? { minScore } : {}),
            strategy: args.strategy,
            maxDepth: args.maxDepth,
            maxPages: args.maxPages,
            includeExternalLinks: args.includeExternalLinks,
            maxBytes: effectiveMaxBytes,
            useReranker,
            maxChunkTokens,
            allowPathDrift,
            includeElements,
            ...(elementsLimit !== undefined ? { elementsLimit } : {}),
            outputMode,
            waitFor: args.waitFor,
            delayBeforeReturnHtml: args.delayBeforeReturnHtml,
            pageTimeout: args.pageTimeout,
            jsCode: args.jsCode,
            ...(args.extractionConfig ? { extractionConfig: args.extractionConfig } : {}),
            ...(llmFallback ? { llmFallback } : {}),
          },
          cfg.crawl4ai,
          cfg.embeddingSidecar.baseUrl,
          cfg.embeddingSidecar.apiToken ?? '',
          cfg.embeddingSidecar.dimensions,
        ),
      ),
    );
    const data: SemanticCrawlBatchResult = {
      seedUrl: batchResults[0]?.seedUrl ?? `corpus:${typedSource.corpusId}`,
      corpusId: batchResults[0]?.corpusId ?? typedSource.corpusId,
      totalChunks: batchResults[0]?.totalChunks ?? 0,
      topKRequested: args.topK,
      results: batchResults.map((result) => ({
        query: result.query,
        topKRequested: result.topKRequested,
        topKDelivered: result.topKDelivered,
        chunks: result.chunks,
      })),
      warnings: [...new Set(batchResults.flatMap((result) => result.warnings ?? []))],
      structuredWarnings: batchResults.flatMap((result) => result.structuredWarnings ?? []),
    };
    const combinedWarnings = [...warnings, ...(data.warnings ?? [])];
    await progressReporter?.done();
    return wrapResponse(data, combinedWarnings);
  }

  const data = await semanticCrawl(
    {
      source: typedSource,
      query: resolvedQuery,
      topK: args.topK,
      ...(minScore !== undefined ? { minScore } : {}),
      strategy: args.strategy,
      maxDepth: args.maxDepth,
      maxPages: args.maxPages,
      includeExternalLinks: args.includeExternalLinks,
      maxBytes: effectiveMaxBytes,
      useReranker,
      maxChunkTokens,
      allowPathDrift,
      includeElements,
      ...(elementsLimit !== undefined ? { elementsLimit } : {}),
      outputMode,
      waitFor: args.waitFor,
      delayBeforeReturnHtml: args.delayBeforeReturnHtml,
      pageTimeout: args.pageTimeout,
      jsCode: args.jsCode,
      ...(args.extractionConfig ? { extractionConfig: args.extractionConfig } : {}),
      ...(llmFallback ? { llmFallback } : {}),
    },
    cfg.crawl4ai,
    cfg.embeddingSidecar.baseUrl,
    cfg.embeddingSidecar.apiToken ?? '',
    cfg.embeddingSidecar.dimensions,
  );
  await progressReporter?.done();

  const allWarnings = [...warnings, ...(data.warnings ?? [])];
  return wrapResponse(data, allWarnings);
}

// ── Family definition ───────────────────────────────────────────────────────

const semanticCrawlFamily: FamilyDefinition = {
  name: 'semantic_crawl',
  description:
    'Crawl an information space and return semantically relevant passages for a query, ' +
    'list cached corpora, or inspect a cached corpus. ' +
    'Use the `action` field: "crawl" does the crawl + semantic retrieval, ' +
    '"list_corpora" lists cached corpora, and "inspect_corpus" inspects one by corpusId.',
  defaultAction: 'crawl',
  actions: [
    {
      name: 'crawl',
      description: 'Crawl an information space and return semantically relevant passages',
      schema: crawlSchema,
      handler: async (rawArgs, cfg, extra) => {
        return handleCrawl(rawArgs as unknown as CrawlArgs, cfg, extra);
      },
      configIssue: (cfg) => {
        if (!cfg.crawl4ai.baseUrl) {
          return 'Set CRAWL4AI_BASE_URL to point at a running crawl4ai sidecar.';
        }
        if (!cfg.embeddingSidecar.baseUrl) {
          return 'Set EMBEDDING_SIDECAR_BASE_URL for embedding sidecar.';
        }
        return null;
      },
    },
    {
      name: 'list_corpora',
      description: 'List cached corpora from previous semantic_crawl.crawl calls',
      schema: listCorporaSchema,
      handler: async (rawArgs) => {
        const { limit } = rawArgs as { limit: number };
        const corpora = listCorpora().slice(0, limit);
        return {
          corpora,
          reuseHint:
            'Pass source: { type: "cached", corpusId } to semantic_crawl.crawl to query an existing corpus.',
        };
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'inspect_corpus',
      description:
        'Inspect a cached semantic_crawl corpus by corpusId, including source metadata, URLs, chunk counts, and recent queries.',
      schema: inspectCorpusSchema,
      handler: async (rawArgs) => {
        const { corpusId } = rawArgs as { corpusId: string };
        const corpus = inspectCorpus(corpusId);
        if (corpus === null) {
          throw new Error(`Corpus '${corpusId}' not found or expired.`);
        }
        return corpus;
      },
      annotations: { readOnlyHint: true },
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerSemanticCrawlFamily(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, semanticCrawlFamily, cfg);
}

/**
 * Action-level capability report for health checks.
 */
export function semanticCrawlCapabilities(cfg: SearchConfig) {
  return semanticCrawlFamily.actions.map((a) => ({
    name: `semantic_crawl.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
