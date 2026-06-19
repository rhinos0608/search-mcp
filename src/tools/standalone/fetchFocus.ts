/**
 * Deprecated fetch_focus compatibility alias.
 *
 * Delegates to the same fetchFocus() implementation used by agentic_browse.focus.
 * Kept for one release to avoid breaking existing MCP clients.
 * Migrate to agentic_browse.focus. Will be removed in next major release.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { fetchFocus } from '../fetchFocus.js';
import { makeResult, errorResponse, successResponse } from '../response.js';

export function registerFetchFocus(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'fetch_focus',
    {
      description:
        '[DEPRECATED] Use agentic_browse.focus instead. Fetch a web page and extract only the spans relevant to a specific question. Requires Crawl4AI and the deep research LLM config.',
      inputSchema: {
        url: z.url().describe('The URL to fetch'),
        focus: z.string().min(1).describe('The specific information to extract from the page'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, focus }) => {
      logger.info({ tool: 'fetch_focus', url }, 'Tool invoked');
      const start = Date.now();
      try {
        const result = await fetchFocus(url, focus, cfg);
        return successResponse(makeResult('fetch_focus', result, Date.now() - start));
      } catch (err: unknown) {
        return errorResponse(err, 'fetch_focus');
      }
    },
  );
}
