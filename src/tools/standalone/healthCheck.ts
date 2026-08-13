/**
 * Standalone health_check tool registration.
 *
 * Run live health checks across all configured search tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { runHealthProbes } from '../../health.js';
import { makeResult, errorResponse } from '../response.js';
import { z } from 'zod/v4';

/**
 * Register the health_check tool.
 *
 * `cfg` is retained for registration-time compatibility (callers pass the
 * startup config), but the handler reloads the live persisted config on every
 * invocation via `loadConfig()` — matching web_search's runtime behavior — so
 * a dashboard config update is reflected on the next health_check call
 * without a restart. The dashboard's ConfigManager invalidates the loadConfig
 * cache when it persists changes.
 */
export function registerHealthCheck(server: McpServer, _cfg: SearchConfig): void {
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
            parsers: z.object({ pdf: z.boolean(), office: z.boolean() }).optional(),
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
        // Live config: dashboard updates are persisted and invalidate the
        // loadConfig cache, so a fresh read reflects them on the next call.
        const currentCfg = loadConfig();
        const report = await runHealthProbes(currentCfg);
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
