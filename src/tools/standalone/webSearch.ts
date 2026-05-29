/**
 * Standalone web_search tool registration.
 *
 * Search the web using the configured backend (Exa, Brave, or SearXNG)
 * with automatic fallback.
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { webSearch, type ProvenanceResult } from '../webSearch.js';
import { correctQuery } from '../../utils/fuzzyCorrection.js';
import { formatCollatedFindings, type FindingEntry } from '../../utils/collatedFindings.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import type { SearchResult } from '../../types.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { CATEGORY_NAMES } from '../../utils/searchCategories.js';
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
        limit: tolerant(z.number().int().min(1).max(50))
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
        category: z
          .enum(CATEGORY_NAMES)
          .optional()
          .describe(
            'Search category profile to enhance the query (company, research paper, news, pdf, github, tweet, personal site, people, financial report)',
          ),
        resultFormat: z
          .enum(['raw', 'collated'])
          .optional()
          .default('raw')
          .describe('Output format: raw passes through backend results, collated assembles structured findings with source blocks'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      query,
      limit,
      safeSearch,
      expandQuery,
      category,
      resultFormat,
    }) => {
      // Server-level defaults (always on, hidden from schema to reduce param noise)
      const mergeSearchBackends = true;
      const fuzzyCorrect = true;

      logger.info(
        {
          tool: 'web_search',
          limit,
          safeSearch,
          expandQuery,
        },
        'Tool invoked',
      );
      const start = Date.now();
      try {
        let correction:
          | {
              original: string;
              corrected: string;
              changes: { original: string; corrected: string; distance: number }[];
            }
          | undefined;
        // Always apply fuzzy correction (was a param, now always-on default)
        {
          const cr = correctQuery(query);
          if (cr.changes.length > 0) {
            correction = { original: query, corrected: cr.corrected, changes: cr.changes };
          }
        }

        const provenanceRef: { current: ProvenanceResult | null } = { current: null };
        const searchResults = await webSearch(
          query,
          limit,
          safeSearch,
          expandQuery,
          mergeSearchBackends,
          fuzzyCorrect,
          provenanceRef,
          category,
        );

        // Post-process: collated format transforms results into a structured markdown string
        let data: SearchResult[] | string = searchResults;
        if (resultFormat === 'collated') {
          const findings: FindingEntry[] = searchResults.map((r, i) => ({
            url: r.url,
            title: r.title,
            domain: new URL(r.url).hostname,
            rank: i + 1,
            content: r.description,
          }));
          data = formatCollatedFindings(findings);
        }

        // collated format produces a formatted string
        if (resultFormat === 'collated') {
          const result = makeResult('web_search', { text: data as string }, Date.now() - start, {
            ...(correction ? { correction } : {}),
            ...(provenanceRef.current ? { provenance: provenanceRef.current } : {}),
          });
          return successResponse(result);
        }
        // Intent filtering removed from schema — auto-applied when output exceeds 5KB.
        // The `intent` param is still accepted via raw args for backward-compat but hidden from schema.

        const result = makeResult('web_search', data, Date.now() - start, {
          ...(correction ? { correction } : {}),
          ...(provenanceRef.current ? { provenance: provenanceRef.current } : {}),
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
