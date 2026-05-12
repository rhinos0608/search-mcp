/**
 * Standalone health_check tool registration.
 *
 * Run live health checks across all configured search tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { runHealthProbes } from '../../health.js';
import { makeResult, errorResponse, successResponse } from '../response.js';

export function registerHealthCheck(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'health_check',
    {
      description:
        'Run a live health check across all search tools. Returns per-tool status (healthy, degraded, unconfigured, rate_limited, unreachable) with remediation hints, plus an overall server status. No caching — always reflects current state. Use this to diagnose failures or verify configuration before relying on a tool.',
      inputSchema: {},
    },
    async () => {
      logger.info({ tool: 'health_check' }, 'Tool invoked');
      const start = Date.now();
      try {
        const report = await runHealthProbes(cfg);
        const result = makeResult('health_check', report, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'health_check' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );
}
