/**
 * Standalone web_search tool registration.
 *
 * Search the web using the configured backend (Exa, Brave, or SearXNG)
 * with automatic fallback.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { webSearch } from '../webSearch.js';
import { correctQuery } from '../../utils/fuzzyCorrection.js';
import { applyIntentFilter, type IntentFilterResult } from '../../utils/intentFilter.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import type { SearchResult } from '../../types.js';
export function registerWebSearch(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  server.registerTool(
    'web_search',
    {
      description:
        'Search the web and return a ranked list of results with titles, URLs, descriptions, and citation metadata (position, domain, source backend, age). Uses the configured search backend (Exa, Brave, or SearXNG) with automatic fallback.',
      inputSchema: {
        query: z.string().describe('The search query string'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe('Maximum number of results to return (1–50, default 10)'),
        safeSearch: z
          .enum(['strict', 'moderate', 'off'])
          .optional()
          .default('moderate')
          .describe('Safe-search level: strict | moderate | off'),
        expandQuery: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Generate query variations (question, concept, scope, opposition) and merge results for broader coverage.',
          ),
        mergeSearchBackends: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'When multiple search backends are configured, query all of them and merge + deduplicate results. Adds engines field tracking which backend returned each result.',
          ),
        fuzzyCorrect: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Auto-correct typos in the query using Levenshtein fuzzy matching against a domain vocabulary.',
          ),
        intent: z
          .string()
          .optional()
          .describe(
            'Natural language intent description. When provided and results exceed ~5KB, only intent-matched results are returned. E.g., "implementation details and code examples" keeps only results related to that intent.',
          ),
      },
    },
    async ({ query, limit, safeSearch, expandQuery, mergeSearchBackends, fuzzyCorrect, intent }) => {
      logger.info(
        { tool: 'web_search', limit, safeSearch, expandQuery, mergeSearchBackends, fuzzyCorrect, intent },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        let correction: { original: string; corrected: string; changes: { original: string; corrected: string; distance: number }[] } | undefined;
        if (fuzzyCorrect) {
          const cr = correctQuery(query);
          if (cr.changes.length > 0) {
            correction = { original: query, corrected: cr.corrected, changes: cr.changes };
          }
        }

        let data = await webSearch(query, limit, safeSearch, expandQuery, mergeSearchBackends, fuzzyCorrect);
        let intentFilterResult: IntentFilterResult<SearchResult> | undefined;

        // Apply intent filtering at the handler level when intent is provided
        if (intent) {
          intentFilterResult = applyIntentFilter<SearchResult>(
            data,
            intent,
            5000,
            (item: SearchResult) => `${item.title} ${item.description}`,
          );
          data = intentFilterResult.results;
        }

        const result = makeResult('web_search', data, Date.now() - start, {
          ...(correction ? { correction } : {}),
          ...(intentFilterResult ? { intentFilter: intentFilterResult } : {}),
        });

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && cfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall('web_search', data).catch((err: unknown) => {
            logger.warn({ err, tool: 'web_search' }, 'KG passive capture failed (non-fatal)');
          });
        }

        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_search' }, 'Tool failed');
        return errorResponse(err, 'web_search');
      }
    },
  );
}
