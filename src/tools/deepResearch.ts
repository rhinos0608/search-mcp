/**
 * deep_research MCP tool registration.
 *
 * Registers a `deep_research` tool that accepts a query and depth profile,
 * runs the full 7-phase research pipeline, and returns a structured report
 * with progressive timeline metadata.
 * Supports MCP progress notifications when the client provides a progress token.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import type { ResearchDepth } from '../research/types.js';
import type { ResearchResult } from '../research/types.js';
import {
  ResearchOrchestrator,
  type OrchestratorLlmConfig,
  type ProgressCallback,
} from '../research/orchestrator.js';
import { makeResult, errorResponse, successResponse } from '../tools/response.js';
import { logger } from '../logger.js';

// ── Schema ──────────────────────────────────────────────────────────────────

const deepResearchSchema = z.object({
  query: z
    .string()
    .min(10)
    .max(5000)
    .describe(
      'The research question to investigate. Should be a complex, open-ended question requiring multi-source analysis.',
    ),
  depth: z
    .enum(['quick', 'standard', 'deep', 'exhaustive'])
    .optional()
    .default('standard')
    .describe(
      'Research depth profile:\n' +
        '- quick: 5-10 sources, 1 gap loop (~60s)\n' +
        '- standard: 15-25 sources, 2 gap loops (~3min)\n' +
        '- deep: 30-60 sources, 3 gap loops (~5min)',
    ),
  maxTimeMs: z
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .optional()
    .describe('Optional max execution time in ms (default: based on depth profile).'),
});

type DeepResearchArgs = z.infer<typeof deepResearchSchema>;

// ── MCP extra (minimal subset for progress notifications) ────────────────────

interface DeepResearchExtra {
  _meta?: {
    progressToken?: string | number;
  };
  signal?: AbortSignal;
  sendNotification: (notification: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<void>;
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function handleDeepResearch(
  args: DeepResearchArgs,
  cfg: SearchConfig,
  extra?: DeepResearchExtra,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
  const start = Date.now();
  const { query, depth, maxTimeMs } = args;

  logger.info({ tool: 'deep_research', depth, queryLength: query.length }, 'Deep research invoked');

  // Build an orchestrator progress callback that sends MCP notifications/progress
  const onProgress: ProgressCallback = async (progress, message) => {
    if (!extra || extra._meta?.progressToken === undefined) {
      return; // client did not request progress notifications
    }
    // Fire-and-forget: notification failures are non-fatal
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: extra._meta.progressToken,
          progress,
          total: 100,
          ...(message !== undefined ? { message } : {}),
        },
      });
    } catch (err) {
      logger.warn({ err, progress }, 'MCP progress notification failed (non-fatal)');
    }
  };

  try {
    // Build LLM config from deep research config
    const drCfg = cfg.deepResearch;
    let llmConfig: OrchestratorLlmConfig | undefined;
    if (drCfg.enabled && drCfg.baseUrl && drCfg.model) {
      llmConfig = {
        baseUrl: drCfg.baseUrl,
        model: drCfg.model,
        workerModel: drCfg.workerModel || drCfg.model,
        ...(drCfg.apiToken ? { apiToken: drCfg.apiToken } : {}),
      };
    }
    const orchestrator = new ResearchOrchestrator(drCfg, llmConfig);
    const result: ResearchResult = await orchestrator.run(
      query,
      depth as ResearchDepth,
      maxTimeMs,
      extra?.signal,
      onProgress,
    );

    const elapsed = Date.now() - start;
    const wrapped = makeResult(
      'deep_research',
      {
        report: result.report,
        timeline: result.timeline,
      },
      elapsed,
      {
        warnings: [
          ...(result.report.limitations.length > 0
            ? [`Limitations: ${result.report.limitations.join('; ')}`]
            : []),
          ...(result.report.uncertainties.length > 0
            ? [`Uncertainties identified: ${String(result.report.uncertainties.length)}`]
            : []),
        ],
      },
    );

    return successResponse(wrapped);
  } catch (err) {
    logger.error({ err, tool: 'deep_research' }, 'Deep research failed');
    return errorResponse(err);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerDeepResearchTool(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'deep_research',
    {
      description:
        'Answer complex, open-ended, multi-source questions through adaptive search, ' +
        'extraction, evidence tracking, and source-weighted synthesis. ' +
        'Uses a 7-phase research pipeline: query decomposition → parallel discovery → ' +
        'deep extraction → gap analysis → audit → synthesis. ' +
        'Supports quick, standard, and deep depth profiles. ' +
        'Returns a structured report with confidence-labeled findings, contradictions, uncertainties, ' +
        'and a progressive timeline of the research process.',
      inputSchema: deepResearchSchema,
    },
    async (rawArgs: unknown, extra) => {
      const args = rawArgs as DeepResearchArgs;
      return handleDeepResearch(args, cfg, extra as DeepResearchExtra | undefined);
    },
  );

  logger.info('Registered deep_research tool');
}
