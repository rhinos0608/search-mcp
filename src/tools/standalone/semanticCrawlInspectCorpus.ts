/** Inspect a cached semantic_crawl corpus in detail. */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inspectCorpus } from '../../utils/corpusCache.js';
import { makeResult, successResponse, errorResponse } from '../response.js';

export function registerSemanticCrawlInspectCorpus(server: McpServer): void {
  server.registerTool(
    'semantic_crawl_inspect_corpus',
    {
      description:
        'Inspect a cached semantic_crawl corpus by corpusId, including source metadata, URLs, chunk counts, and recent queries.',
      inputSchema: {
        corpusId: z.string().describe('Corpus ID returned by semantic_crawl'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ corpusId }) => {
      const start = Date.now();
      try {
        const corpus = inspectCorpus(corpusId);
        if (corpus === null) {
          throw new Error(`Corpus '${corpusId}' not found or expired.`);
        }
        return successResponse(
          makeResult('semantic_crawl_inspect_corpus', corpus, Date.now() - start),
        );
      } catch (err: unknown) {
        return errorResponse(err, 'semantic_crawl_inspect_corpus');
      }
    },
  );
}
