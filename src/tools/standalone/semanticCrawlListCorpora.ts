/** List cached corpora that can be reused by semantic_crawl. */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listCorpora } from '../../utils/corpusCache.js';
import { makeResult, successResponse, errorResponse } from '../response.js';

export function registerSemanticCrawlListCorpora(server: McpServer): void {
  server.registerTool(
    'semantic_crawl_list_corpora',
    {
      description:
        'List cached corpora from previous semantic_crawl calls. Reuse a corpus with ' +
        'semantic_crawl source: { type: "cached", corpusId: "..." } to skip re-crawling and re-embedding.',
      inputSchema: {
        limit: tolerant(z.number().int().min(1).max(100))
          .optional()
          .default(25)
          .describe('Maximum cached corpora to return (1–100, default 25)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const start = Date.now();
      try {
        const corpora = listCorpora().slice(0, limit);
        return successResponse(
          makeResult(
            'semantic_crawl_list_corpora',
            {
              corpora,
              reuseHint:
                'Pass source: { type: "cached", corpusId } to semantic_crawl to query an existing corpus.',
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        return errorResponse(err, 'semantic_crawl_list_corpora');
      }
    },
  );
}
