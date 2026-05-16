/**
 * Standalone semantic_crawl tool registration.
 *
 * Crawl an information space and return semantically relevant passages
 * using embeddings and RAG.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { SemanticCrawlBatchResult, SemanticCrawlSource } from '../../types.js';
import { logger } from '../../logger.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../../semanticLimits.js';
import { semanticCrawl } from '../semanticCrawl.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import {
  tryRagaFallback,
  normalizeLlmForValidation,
  buildLlmFallback,
} from '../../utils/ragaFallback.js';
import { readabilityFallbackResult } from '../../utils/crawlResultShaping.js';
import { extractionConfigSchema, validateExtractionConfig } from '../../utils/extractionConfig.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';

export function registerSemanticCrawl(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  server.registerTool(
    'semantic_crawl',
    {
      description:
        'Crawl an information space and return the most semantically relevant passages for a specific query. ' +
        'Accepted source.type values are: "url", "sitemap", "search", "github", and "cached". ' +
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
                .describe('Preferred locale when collapsing locale-duplicate sitemap URLs, e.g. en or en-US'),
            }),
            z.object({
              type: z
                .literal('search')
                .describe('Use web search to discover seed URLs, then crawl them'),
              query: z.string().describe('Web search query to discover seed URLs, then crawl them'),
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
              type: z
                .literal('github')
                .describe('Build a corpus from files in a GitHub repository'),
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
              type: z
                .literal('cached')
                .describe('Reuse a previous corpusId without crawling again'),
              corpusId: z
                .string()
                .describe(
                  'Corpus ID returned by a previous semantic_crawl call. Skip re-crawl and re-embed.',
                ),
            }),
          ])
          .describe(
            'Source of the corpus to crawl. Valid source.type values: "url", "sitemap", "search", "github", "cached". ' +
              'Use "cached" with a corpusId returned by semantic_crawl, or call semantic_crawl_list_corpora to discover cached corpora.',
          ),
        query: z.string().optional().describe('The semantic search query — what are you looking for?'),
        queries: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe('Batch query mode for cached corpora. Provide multiple queries in one call.'),
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
          .describe(
            'Crawl strategy. bfs visits all links at depth N before depth N+1; dfs follows one path deeply before backtracking.',
          ),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .default(2)
          .describe(
            'Maximum link-follow depth from seed URL. 0 = only seed page(s). Sitemap/search modes force this to 0 because URLs are preselected.',
          ),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100)
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
        minScore: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Minimum bi-encoder score required for returned chunks (0–1)'),
        useContextualEmbeddings: z
          .boolean()
          .optional()
          .default(false)
          .describe('Use LLM-generated context for embedding corpus chunks (default false)'),
        maxChunkTokens: z
          .number()
          .int()
          .min(100)
          .max(8000)
          .optional()
          .describe(
            'Override max tokens per chunk (100–8000, default 400). ' +
              'Larger values produce fewer chunks, reducing LLM calls when useContextualEmbeddings is enabled. ' +
              'Auto-scaled to 1200 when useContextualEmbeddings is on and this is not set.',
          ),
        allowPathDrift: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Allow crawler to follow links outside the seed URL path prefix (default false). When false, only pages under the seed path are kept.',
          ),
        includeElements: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Include page-level structured elements in the response (default true). Set false for lower-context output.',
          ),
        elementsLimit: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe(
            'Maximum structured elements to include when includeElements is true (0–1000).',
          ),
        outputMode: z
          .enum(['full', 'passages'])
          .optional()
          .default('full')
          .describe(
            'full returns chunks plus metadata/elements; passages suppresses noisy page elements and extraction details.',
          ),
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
    async (rawArgs, extra) => {
      const {
        source,
        query,
        queries,
        topK,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        maxBytes,
        useReranker,
        minScore,
        useContextualEmbeddings,
        maxChunkTokens,
        allowPathDrift,
        includeElements,
        elementsLimit,
        outputMode,
        extractionConfig,
        waitFor,
        delayBeforeReturnHtml,
        pageTimeout,
        jsCode,
      } = rawArgs as {
        source: {
          type: 'url' | 'sitemap' | 'search' | 'github' | 'cached';
          [key: string]: unknown;
        };
        query?: string;
        queries?: string[];
        topK: number;
        strategy: 'bfs' | 'dfs';
        maxDepth: number;
        maxPages: number;
        includeExternalLinks: boolean;
        maxBytes: number;
        useReranker: boolean;
        minScore?: number;
        useContextualEmbeddings: boolean;
        maxChunkTokens?: number;
        allowPathDrift: boolean;
        includeElements: boolean;
        elementsLimit?: number;
        outputMode: 'full' | 'passages';
        extractionConfig?: import('../../utils/extractionConfig.js').ExtractionConfig;
        waitFor?: string;
        delayBeforeReturnHtml: number;
        pageTimeout: number;
        jsCode?: string;
      };
      logger.info(
        { tool: 'semantic_crawl', sourceType: source.type, query, queryCount: queries?.length, topK },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        if (extractionConfig) {
          validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
        }

        const singleQuery = query?.trim();
        const batchQueries = queries?.map((value) => value.trim()).filter((value) => value.length > 0);
        if ((singleQuery ? 1 : 0) + (batchQueries && batchQueries.length > 0 ? 1 : 0) !== 1) {
          throw new Error('Provide exactly one of `query` or `queries`.');
        }

        const typedSource = source as unknown as SemanticCrawlSource;
        const warnings: string[] = [];
        if (typedSource.type === 'cached' && extractionConfig) {
          warnings.push(
            'extractionConfig is ignored when using cached source (cached sources skip crawling)',
          );
        }

        if (
          typedSource.type === 'url' &&
          cfg.raga.enabled &&
          typeof cfg.raga.baseUrl === 'string' &&
          cfg.raga.baseUrl.trim() !== ''
        ) {
          const ragaResult = await tryRagaFallback(
            typedSource.url,
            { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs },
            extra,
          );
          if (ragaResult) {
            logger.info(
              { tool: 'semantic_crawl', url: typedSource.url },
              'Document URL detected — using RAG-Anything extraction',
            );
            warnings.push(...ragaResult.warnings);
            const article: import('../../types.js').ArticleResult = {
              url: typedSource.url,
              title: null,
              textContent: ragaResult.markdown,
              content: ragaResult.markdown,
              extractionMethod: 'raga',
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
              strategy,
              maxDepth,
              maxPages,
            );
            const result = makeResult('semantic_crawl', singlePage, Date.now() - start, {
              warnings,
            });

            // KG passive capture (fire-and-forget, never fails the tool call)
            if (kgHook && cfg.knowledgeGraph.enabled) {
              void kgHook.onToolCall('semantic_crawl', singlePage).catch((err: unknown) => {
                logger.warn(
                  { err, tool: 'semantic_crawl' },
                  'KG passive capture failed (non-fatal)',
                );
              });
            }

            return successResponse(result);
          }
        }

        const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
        const resolvedQuery = singleQuery ?? '';

        const effectiveMaxBytes = maxBytes;
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
                  topK,
                  ...(minScore !== undefined ? { minScore } : {}),
                  strategy,
                  maxDepth,
                  maxPages,
                  includeExternalLinks,
                  maxBytes: effectiveMaxBytes,
                  useReranker,
                  maxChunkTokens,
                  allowPathDrift,
                  includeElements,
                  ...(elementsLimit !== undefined ? { elementsLimit } : {}),
                  outputMode,
                  waitFor,
                  delayBeforeReturnHtml,
                  pageTimeout,
                  jsCode,
                  ...(extractionConfig ? { extractionConfig } : {}),
                  ...(llmFallback ? { llmFallback } : {}),
                  ...(useContextualEmbeddings
                    ? { useContextualEmbeddings, contextualEmbedding: cfg.llm }
                    : {}),
                },
                cfg.crawl4ai,
                cfg.embeddingSidecar.baseUrl,
                cfg.embeddingSidecar.apiToken ?? '',
                cfg.embeddingSidecar.dimensions,
                cfg.raga,
              ),
            ),
          );
          const data: SemanticCrawlBatchResult = {
            seedUrl: batchResults[0]?.seedUrl ?? `corpus:${typedSource.corpusId}`,
            corpusId: batchResults[0]?.corpusId ?? typedSource.corpusId,
            totalChunks: batchResults[0]?.totalChunks ?? 0,
            topKRequested: topK,
            results: batchResults.map((result) => ({
              query: result.query,
              topKRequested: result.topKRequested,
              topKDelivered: result.topKDelivered,
              chunks: result.chunks,
            })),
            warnings: [...new Set(batchResults.flatMap((result) => result.warnings ?? []))],
            structuredWarnings: batchResults.flatMap((result) => result.structuredWarnings ?? []),
          };
          const result = makeResult('semantic_crawl', data, Date.now() - start, {
            warnings: [...warnings, ...(data.warnings ?? [])],
          });
          if (kgHook && cfg.knowledgeGraph.enabled) {
            void kgHook.onToolCall('semantic_crawl', data).catch((err: unknown) => {
              logger.warn({ err, tool: 'semantic_crawl' }, 'KG passive capture failed (non-fatal)');
            });
          }
          return successResponse(result);
        }

        const data = await semanticCrawl(
          {
            source: typedSource,
            query: resolvedQuery,
            topK,
            ...(minScore !== undefined ? { minScore } : {}),
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            maxBytes: effectiveMaxBytes,
            useReranker,
            maxChunkTokens,
            allowPathDrift,
            includeElements,
            ...(elementsLimit !== undefined ? { elementsLimit } : {}),
            outputMode,
            waitFor,
            delayBeforeReturnHtml,
            pageTimeout,
            jsCode,
            ...(extractionConfig ? { extractionConfig } : {}),
            ...(llmFallback ? { llmFallback } : {}),
            ...(useContextualEmbeddings
              ? { useContextualEmbeddings, contextualEmbedding: cfg.llm }
              : {}),
          },
          cfg.crawl4ai,
          cfg.embeddingSidecar.baseUrl,
          cfg.embeddingSidecar.apiToken ?? '',
          cfg.embeddingSidecar.dimensions,
          cfg.raga,
        );
        const result = makeResult('semantic_crawl', data, Date.now() - start, {
          warnings: [...warnings, ...(data.warnings ?? [])],
        });

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && cfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall('semantic_crawl', data).catch((err: unknown) => {
            logger.warn({ err, tool: 'semantic_crawl' }, 'KG passive capture failed (non-fatal)');
          });
        }

        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'semantic_crawl' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );
}
