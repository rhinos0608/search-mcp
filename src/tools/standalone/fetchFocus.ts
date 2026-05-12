/**
 * Standalone fetch_focus tool registration.
 *
 * Fetch a web page and extract only the spans relevant to a specific question.
 * Gated on crawl4ai + deepResearch LLM config.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { fetchFocus } from '../fetchFocus.js';
import { makeResult, errorResponse, successResponse } from '../response.js';

export function registerFetchFocus(server: McpServer, cfg: SearchConfig): void {
  // Only register if required config is present
  if (
    cfg.crawl4ai.baseUrl.length === 0 ||
    cfg.deepResearch.baseUrl.length === 0 ||
    cfg.deepResearch.model.length === 0
  ) {
    return;
  }

  server.registerTool(
    'fetch_focus',
    {
      description:
        'Fetch a web page and extract only the spans relevant to a specific question. Requires Crawl4AI and the deep research LLM config.',
      inputSchema: {
        url: z.url().describe('The URL to fetch'),
        focus: z.string().min(1).describe('The specific information to extract from the page'),
      },
    },
    async ({ url, focus }) => {
      logger.info({ tool: 'fetch_focus', url }, 'Tool invoked');
      const start = Date.now();
      try {
        const result = await fetchFocus(url, focus, cfg);
        return successResponse(makeResult('fetch_focus', result, Date.now() - start));
      } catch (err: unknown) {
        return errorResponse(err);
      }
    },
  );
}
