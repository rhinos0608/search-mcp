/**
 * Standalone web_crawl tool registration.
 *
 * Crawl a URL using a headless Playwright browser via crawl4ai sidecar
 * with RAG-Anything fallback for document URLs.
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { webCrawl } from '../webCrawl.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import {
  tryRagaFallback,
  normalizeLlmForValidation,
  buildLlmFallback,
} from '../../utils/ragaFallback.js';
import { readabilityFallbackResult, extractionWarnings } from '../../utils/crawlResultShaping.js';
import { extractionConfigSchema, validateExtractionConfig } from '../../utils/extractionConfig.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';

export function registerWebCrawl(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  server.registerTool(
    'web_crawl',
    {
      description:
        'Crawl a URL using a headless Playwright browser (via a crawl4ai sidecar). ' +
        'Handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. ' +
        'Returns clean LLM-ready Markdown with title, description, and extracted links for each crawled page. ' +
        'Supports deep crawling across multiple pages. Requires CRAWL4AI_BASE_URL env var (self-hosted Docker sidecar).',
      inputSchema: {
        url: z.url().describe('Seed URL to start crawling from'),
        strategy: z
          .enum(['bfs', 'dfs'])
          .optional()
          .default('bfs')
          .describe(
            'Crawl strategy: bfs (breadth-first, good for shallow wide coverage) | ' +
              'dfs (depth-first, good for deeply nested docs)',
          ),
        maxDepth: tolerant(z.number().int().min(1).max(5))
          .optional()
          .default(1)
          .describe(
            'Maximum link depth to follow from seed URL (1–5, default 1 = single page only)',
          ),
        maxPages: tolerant(z.number().int().min(1).max(100))
          .optional()
          .default(1)
          .describe('Maximum number of pages to crawl (1–100, default 1)'),
        includeExternalLinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow links to external domains (default false — stays on seed domain)'),
        extractionConfig: extractionConfigSchema
          .optional()
          .describe(
            'Optional structured data extraction config. Supports css_schema, xpath_schema, regex, and llm strategies. ' +
              'Requires Crawl4AI sidecar v0.8.x or later.',
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
      },
      annotations: { readOnlyHint: true },
    },
    async (
      {
        url,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        extractionConfig,
        waitFor,
        delayBeforeReturnHtml,
        pageTimeout,
        jsCode,
      },
      extra,
    ) => {
      logger.info({ tool: 'web_crawl', url, strategy, maxDepth, maxPages }, 'Tool invoked');
      const start = Date.now();
      try {
        const warnings: string[] = [];
        if (extractionConfig) {
          validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
        }

        // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
        if (cfg.raga.enabled && cfg.raga.baseUrl) {
          const ragaResult = await tryRagaFallback(
            url,
            { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs },
            extra,
          );
          if (ragaResult) {
            logger.info(
              { tool: 'web_crawl', url },
              'Document URL detected — using RAG-Anything extraction',
            );
            warnings.push(...ragaResult.warnings);
            const article = {
              url,
              title: null,
              textContent: ragaResult.markdown,
              content: ragaResult.markdown,
              extractionMethod: 'raga' as const,
              elements: [],
              byline: null,
              siteName: null,
              description: null,
              publishedDate: null,
              image: null,
            };
            const data = readabilityFallbackResult(url, article, strategy, maxDepth, maxPages);
            const result = makeResult('web_crawl', data, Date.now() - start, { warnings });

            // KG passive capture (fire-and-forget, never fails the tool call)
            if (kgHook && cfg.knowledgeGraph.enabled) {
              void kgHook.onToolCall('web_crawl', data).catch((err: unknown) => {
                logger.warn({ err, tool: 'web_crawl' }, 'KG passive capture failed (non-fatal)');
              });
            }

            return successResponse(result);
          }
        }

        const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
        const data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
          strategy,
          maxDepth,
          maxPages,
          includeExternalLinks,
          waitFor,
          delayBeforeReturnHtml,
          pageTimeout,
          jsCode,
          ...(extractionConfig ? { extractionConfig } : {}),
          ...(llmFallback ? { llmFallback } : {}),
        });
        warnings.push(...extractionWarnings(data), ...(data.warnings ?? []));

        // Strip html and structured elements from MCP response — both are
        // derived from markdown and double/triple payload size with zero
        // information gain for LLM consumers. Internal callers (semanticCrawl,
        // jobPipeline, extraction) call webCrawl() directly and retain them.
        for (const page of data.pages) {
          const p = page as unknown as Record<string, unknown>;
          delete p.html;
          delete p.elements;
          delete p.truncatedElements;
          delete p.originalElementCount;
          delete p.omittedElementCount;
        }

        const result = makeResult('web_crawl', data, Date.now() - start, {
          warnings,
        });

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && cfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall('web_crawl', data).catch((err: unknown) => {
            logger.warn({ err, tool: 'web_crawl' }, 'KG passive capture failed (non-fatal)');
          });
        }

        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_crawl' }, 'Tool failed');
        return errorResponse(err, 'web_crawl');
      }
    },
  );
}
