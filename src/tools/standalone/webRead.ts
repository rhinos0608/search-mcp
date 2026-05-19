/**
 * Standalone web_read tool registration.
 *
 * Fetch and parse a web page via crawl4ai headless browser with RAG-Anything
 * fallback for document URLs.
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { webCrawl } from '../webCrawl.js';
import { webRead } from '../webRead.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import {
  tryRagaFallback,
  normalizeLlmForValidation,
  buildLlmFallback,
} from '../../utils/ragaFallback.js';
import { readabilityFallbackResult, extractionWarnings } from '../../utils/crawlResultShaping.js';
import { extractionConfigSchema, validateExtractionConfig } from '../../utils/extractionConfig.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';

export function registerWebRead(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  server.registerTool(
    'web_read',
    {
      description:
        'Fetch and parse a web page via crawl4ai headless browser. Handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. Returns clean LLM-ready Markdown with title, description, and extracted links. [DEPRECATED] Use web_crawl for deep crawling support.',
      inputSchema: {
        url: z
          .url()
          .describe('The fully-qualified URL of the page to read (must include https://)'),
        strategy: z
          .enum(['bfs', 'dfs'])
          .optional()
          .default('bfs')
          .describe('Crawl strategy (default bfs)'),
        maxDepth: tolerant(z.number().int().min(1).max(5))
          .optional()
          .default(1)
          .describe('Max link depth to follow (1–5, default 1 = single page)'),
        maxPages: tolerant(z.number().int().min(1).max(100))
          .optional()
          .default(1)
          .describe('Max pages to crawl (1–100, default 1)'),
        includeExternalLinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow external domain links (default false)'),
        extractionConfig: extractionConfigSchema
          .optional()
          .describe(
            'Optional structured data extraction config. Only works when crawl4ai is configured; ignored in Readability fallback.',
          ),
      },
    },
    async (
      { url, strategy, maxDepth, maxPages, includeExternalLinks, extractionConfig },
      extra,
    ) => {
      logger.info({ tool: 'web_read' }, 'Tool invoked');
      const start = Date.now();
      try {
        if (extractionConfig) {
          validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
        }

        let data = readabilityFallbackResult(
          url,
          {
            url,
            title: null,
            textContent: '',
            content: '',
            extractionMethod: 'fallback',
            elements: [],
            byline: null,
            siteName: null,
            description: null,
            publishedDate: null,
            image: null,
          },
          strategy,
          maxDepth,
          maxPages,
        );
        const warnings: string[] = [];

        // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
        let ragaAttempted = false;
        if (cfg.raga.enabled && cfg.raga.baseUrl) {
          const ragaResult = await tryRagaFallback(
            url,
            { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs },
            extra,
          );
          if (ragaResult) {
            logger.info(
              { tool: 'web_read', url },
              'Document URL detected — using RAG-Anything extraction',
            );
            warnings.push(...ragaResult.warnings);
            data = readabilityFallbackResult(
              url,
              {
                url,
                title: null,
                textContent: ragaResult.markdown,
                content: ragaResult.markdown,
                extractionMethod: 'raga',
                elements: [],
                byline: null,
                siteName: null,
                description: null,
                publishedDate: null,
                image: null,
              },
              strategy,
              maxDepth,
              maxPages,
            );
            ragaAttempted = true;
          }
        }

        if (!ragaAttempted) {
          if (cfg.crawl4ai.baseUrl) {
            const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
            data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
              strategy,
              maxDepth,
              maxPages,
              includeExternalLinks,
              ...(extractionConfig ? { extractionConfig } : {}),
              ...(llmFallback ? { llmFallback } : {}),
            });
            warnings.push(...extractionWarnings(data));
          } else {
            if (extractionConfig) {
              warnings.push(
                'extractionConfig is ignored when crawl4ai is not configured (Readability fallback does not support structured extraction)',
              );
            }
            logger.debug('crawl4ai not configured — falling back to webRead (Readability)');
            const article = await webRead(url);
            data = readabilityFallbackResult(url, article, strategy, maxDepth, maxPages);
          }
        }

        const result = makeResult('web_read', data, Date.now() - start, {
          warnings,
        });

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && cfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall('web_read', data).catch((err: unknown) => {
            logger.warn({ err, tool: 'web_read' }, 'KG passive capture failed (non-fatal)');
          });
        }

        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_read' }, 'Tool failed');
        return errorResponse(err, 'web_read');
      }
    },
  );
}
