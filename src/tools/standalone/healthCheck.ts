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
import { z } from 'zod/v4';

export function registerHealthCheck(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'health_check',
    {
      description:
        'Run a live health check across all search tools. Returns per-tool status (healthy, degraded, unconfigured, rate_limited, unreachable) with remediation hints, plus an overall server status. No caching — always reflects current state. Use this to diagnose failures or verify configuration before relying on a tool.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        overall: z.enum(['healthy', 'degraded', 'unhealthy']),
        tools: z.record(
          z.string(),
          z.object({
            status: z.enum(['healthy', 'degraded', 'unconfigured', 'rate_limited', 'unreachable']),
            message: z.string(),
            remediation: z.string().optional(),
            latencyMs: z.number().optional(),
          }),
        ),
        timestamp: z.string(),
        outputBudget: z
          .object({ totalBytes: z.number(), toolBytes: z.record(z.string(), z.number()) })
          .optional(),
        toolStats: z
          .array(
            z.object({
              name: z.string(),
              calls: z.number(),
              errors: z.number(),
              totalLatencyMs: z.number(),
              avgLatencyMs: z.number(),
            }),
          )
          .optional(),
      }),
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
        return errorResponse(err, 'health_check');
      }
    },
  );
}
