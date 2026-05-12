/**
 * Standalone semantic_crawl tool registration.
 *
 * Crawl an information space and return semantically relevant passages
 * using embeddings and RAG.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
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

export function registerSemanticCrawl(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'semantic_crawl',
    {
      description:
        'Crawl an information space and return the most semantically relevant passages for a specific query. ' +
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
              type: z.literal('url'),
              url: z.url().describe('Seed URL to start crawling from'),
              urls: z
                .array(z.url())
                .optional()
                .describe('Additional seed URLs to crawl in the same corpus'),
            }),
            z.object({
              type: z.literal('sitemap'),
              url: z.url().describe('URL of a sitemap.xml to parse for seed URLs'),
            }),
            z.object({
              type: z.literal('search'),
              query: z
                .string()
                .describe('Web search query to discover seed URLs, then crawl them'),
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
              type: z.literal('github'),
              owner: z.string().describe('GitHub repository owner'),
              repo: z.string().describe('GitHub repository name'),
              branch: z.string().optional().describe('Git branch (default: repo default branch)'),
              extensions: z.array(z.string()).optional().describe('File extensions to include'),
              query: z
                .string()
                .optional()
                .describe('Optional code search query to pre-filter files'),
            }),
            z.object({
              type: z.literal('cached'),
              corpusId: z
                .string()
                .describe(
                  'Corpus ID returned by a previous semantic_crawl call. Skip re-crawl and re-embed.',
                ),
            }),
          ])
          .describe('Source of the corpus to crawl'),
        query: z.string().describe('The semantic search query — what are you looking for?'),
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
          .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .default(2)
          .describe(
            'Maximum link depth (0–5, default 2). Set 0 for single-page / sitemap / search modes.',
          ),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum pages to crawl (1–100, default 20). Divided across seeds.'),
        includeExternalLinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow external domain links (default false)'),
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
          .describe('Allow crawler to follow links outside the seed URL path (default false)'),
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
    async (
      {
        source,
        query,
        topK,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        maxBytes,
        useReranker,
        useContextualEmbeddings,
        maxChunkTokens,
        allowPathDrift,
        extractionConfig,
        waitFor,
        delayBeforeReturnHtml,
        pageTimeout,
        jsCode,
      },
      extra,
    ) => {
      logger.info(
        { tool: 'semantic_crawl', sourceType: source.type, query, topK },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        if (extractionConfig) {
          validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
        }

        const warnings: string[] = [];
        if (source.type === 'cached' && extractionConfig) {
          warnings.push(
            'extractionConfig is ignored when using cached source (cached sources skip crawling)',
          );
        }

        // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
        if (
          source.type === 'url' &&
          cfg.raga.enabled &&
          cfg.raga.baseUrl
        ) {
          const ragaResult = await tryRagaFallback(
            source.url,
            { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs },
            extra,
          );
          if (ragaResult) {
            logger.info(
              { tool: 'semantic_crawl', url: source.url },
              'Document URL detected — using RAG-Anything extraction',
            );
            warnings.push(...ragaResult.warnings);
            const article: import('../../types.js').ArticleResult = {
              url: source.url,
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
              source.url,
              article,
              strategy,
              maxDepth,
              maxPages,
            );
            const result = makeResult('semantic_crawl', singlePage, Date.now() - start, {
              warnings,
            });
            return successResponse(result);
          }
        }

        const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);

        const effectiveMaxBytes = maxBytes;
        const data = await semanticCrawl(
          {
            source,
            query,
            topK,
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            maxBytes: effectiveMaxBytes,
            useReranker,
            maxChunkTokens,
            allowPathDrift,
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
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'semantic_crawl' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );
}
