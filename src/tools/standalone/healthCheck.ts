/**
 * Standalone health_check tool registration.
 *
 * Run live health checks across all configured search tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { runHealthProbes } from '../../health.js';
import { makeResult, errorResponse } from '../response.js';
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
            tier: z.enum(['free', 'core', 'gated', 'optional', 'family']).optional(),
            activeBackend: z.string().optional(),
            configuration: z
              .object({
                configured: z.boolean(),
                required: z.array(z.string()),
                missing: z.array(z.string()),
              })
              .optional(),
          }),
        ),
        tiers: z.record(
          z.enum(['free', 'core', 'gated', 'optional', 'family']),
          z.array(z.string()),
        ),
        timestamp: z.string(),
        outputBudget: z
          .object({
            totalCalls: z.number(),
            totalBytesReturned: z.number(),
            totalBytesSandboxed: z.number(),
            cacheHits: z.number(),
            cacheBytesSaved: z.number(),
            sessionStart: z.number(),
            savingsRatio: z.number(),
            byTool: z.record(
              z.string(),
              z.object({
                calls: z.number(),
                bytesReturned: z.number(),
                avgBytesPerCall: z.number(),
              }),
            ),
          })
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (): Promise<any> => {
      logger.info({ tool: 'health_check' }, 'Tool invoked');
      const start = Date.now();
      try {
        const report = await runHealthProbes(cfg);
        const result = makeResult('health_check', report, Date.now() - start);
        const formatted = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text' as const, text: formatted }],
          structuredContent: report,
        };
      } catch (err: unknown) {
        logger.error({ err, tool: 'health_check' }, 'Tool failed');
        return errorResponse(err, 'health_check');
      }
    },
  );
}
