/**
 * deep_research MCP tool registration (Job/Poll pattern).
 *
 * Instead of blocking until research completes (which exceeds client timeouts),
 * the tool uses a start/poll/list/cancel protocol:
 *
 *   start  → initiates research, returns jobId immediately
 *   poll   → returns current status and bounded partial results
 *   list   → lightweight summaries of all known jobs
 *   cancel → aborts a running job
 *
 * Each call returns within milliseconds — no client-side timeout issues.
 * The orchestrator runs in a detached promise and updates job state via
 * the progress callback. MCP progress notifications are still sent for
 * clients that support them, but pollable job state is the reliable
 * retrieval mechanism.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import {
   ResearchOrchestrator,
   type OrchestratorLlmConfig,
   type ProgressCallback,
} from '../research/orchestrator.js';
import { researchJobManager } from '../research/jobManager.js';
import type { ResearchJobSnapshot } from '../research/jobManager.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { logger } from '../logger.js';

// ── Schema (flat object — MCP clients render flat properties) ──────────────

const deepResearchSchema = z.object({
   action: z
      .enum(['start', 'poll', 'list', 'cancel'])
      .describe('Which action to perform'),
   jobId: z
      .string()
      .optional()
      .describe('Job ID (required for poll and cancel)'),
   query: z
      .string()
      .min(10)
      .max(5000)
      .optional()
      .describe('The research question (required for start)'),
   depth: z
      .enum(['quick', 'standard', 'deep', 'exhaustive', 'tree'])
      .optional()
      .default('standard')
      .describe(
         'Research depth profile:\n' +
         '- quick: 5-10 sources, 1 gap loop (~60s)\n' +
         '- standard: 15-25 sources, 2 gap loops (~3min)\n' +
         '- deep: 30-60 sources, 3 gap loops (~5min)\n' +
         '- tree: breadth×depth recursive exploration (4 sub-queries × 2 levels)',
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

// ── MCP extra (minimal subset) ─────────────────────────────────────────────

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

// ── Constants ──────────────────────────────────────────────────────────────

/** Poll blocks for up to this long when the job is still running. */
const POLL_WAIT_MS = 60_000;
/** Interval between status checks during poll wait. */
const POLL_INTERVAL_MS = 2_000;

// ── Action handlers ────────────────────────────────────────────────────────

async function handleStart(
   args: DeepResearchArgs,
   cfg: SearchConfig,
   extra?: DeepResearchExtra,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
   const start = Date.now();

   if (typeof args.query !== 'string' || args.query.length < 10) {
      return errorResponse(new Error('start requires query (min 10 characters)'));
   }
   const query = args.query;
   const depth = args.depth;
   const maxTimeMs = args.maxTimeMs;

   const drCfg = cfg.deepResearch;
   if (!drCfg.enabled) {
      return errorResponse(
         new Error(
            'Deep research is not enabled. Set DEEP_RESEARCH_ENABLED=true and configure DEEP_RESEARCH_BASE_URL and DEEP_RESEARCH_MODEL.',
         ),
      );
   }

   // Build LLM config
   let llmConfig: OrchestratorLlmConfig | undefined;
   if (drCfg.baseUrl && drCfg.model) {
      llmConfig = {
         baseUrl: drCfg.baseUrl,
         model: drCfg.model,
         workerModel: drCfg.workerModel || drCfg.model,
         ...(drCfg.apiToken ? { apiToken: drCfg.apiToken } : {}),
      };
   }

   // Register job with the manager
   const snapshot = researchJobManager.create({ query, depth, maxTimeMs: maxTimeMs ?? undefined });
   if (!snapshot) {
      return errorResponse(
         new Error(
            `Maximum active research jobs (${String(researchJobManager.activeCount())}) reached. Wait for a job to complete and try again.`,
         ),
      );
   }

   const jobId = snapshot.jobId;

   // Get the AbortSignal for cancellation
   const abortSignal = researchJobManager.getAbortSignal(jobId);

   // ── Build progress callback ─────────────────────────────────────────────
   const onProgress: ProgressCallback = async (progress, message) => {
      // 1. MCP progress notifications (fire-and-forget)
      if (extra?._meta?.progressToken !== undefined) {
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
      }

      // 2. Update job state with progress and bounded partials
      researchJobManager.update(jobId, {
         progress,
         phase: derivePhase(progress),
         message: message ?? undefined,
         classification: undefined,
         subQuestionCount: undefined,
         sourceCount: undefined,
         findingCount: undefined,
      });
   };

   // ── Fire orchestrator in detached promise ────────────────────────────────
   const orchestrator = new ResearchOrchestrator(drCfg, llmConfig);

   // Not awaited — runs in background
   const promise = orchestrator.run(query, depth, maxTimeMs, abortSignal, onProgress);

   promise
      .then((result) => {
         researchJobManager.complete(jobId, result);
         logger.info({ jobId, elapsedMs: Date.now() - start }, 'Deep research job completed');
      })
      .catch((err: unknown) => {
         const error = err instanceof Error ? err : new Error(String(err));
         if (
            error.name === 'AbortError' ||
            error.message.includes('cancelled') ||
            error.message.includes('aborted')
         ) {
            researchJobManager.markCancelled(jobId);
         } else {
            researchJobManager.fail(jobId, error);
         }
      });

   logger.info({ jobId, depth, queryLength: query.length }, 'Deep research job started');

   const elapsed = Date.now() - start;
   return successResponse(
      makeResult('deep_research', { jobId, status: snapshot.status, retryAfterMs: POLL_WAIT_MS }, elapsed),
   );
}

async function handlePoll(
   args: DeepResearchArgs,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
   const start = Date.now();

   if (typeof args.jobId !== 'string') {
      return errorResponse(new Error('poll requires jobId'));
   }
   const jobId = args.jobId;

   // Block until the job reaches a terminal state or the wait expires.
   // This prevents LLMs from spam-polling — each poll call naturally takes time.
   const deadline = Date.now() + POLL_WAIT_MS;

   for (; ;) {
      const snapshot: ResearchJobSnapshot | null = researchJobManager.poll(jobId);
      if (!snapshot) {
         return errorResponse(
            new Error(`Research job "${jobId}" not found. It may have expired or never existed.`),
         );
      }

      // Terminal state → return immediately
      if (
         snapshot.status === 'complete' ||
         snapshot.status === 'failed' ||
         snapshot.status === 'cancelled' ||
         snapshot.status === 'expired'
      ) {
         const elapsed = Date.now() - start;
         return successResponse(makeResult('deep_research', snapshot, elapsed));
      }

      // In-flight — wait and loop
      const now = Date.now();
      if (now >= deadline) {
         // Wait expired; return current snapshot with retry guidance
         const elapsed = now - start;
         return successResponse(
            makeResult('deep_research', { ...snapshot, retryAfterMs: POLL_WAIT_MS }, elapsed),
         );
      }

      const remaining = deadline - now;
      const delay = Math.min(POLL_INTERVAL_MS, remaining);
      await new Promise((resolve) => setTimeout(resolve, delay));
   }
}

async function handleList(): Promise<ReturnType<typeof successResponse>> {
   const start = Date.now();
   const jobs = researchJobManager.list();
   const elapsed = Date.now() - start;
   return successResponse(makeResult('deep_research', { jobs }, elapsed));
}

async function handleCancel(
   args: DeepResearchArgs,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
   const start = Date.now();

   if (typeof args.jobId !== 'string') {
      return errorResponse(new Error('cancel requires jobId'));
   }
   const jobId = args.jobId;

   const snapshot = researchJobManager.cancel(jobId);
   if (!snapshot) {
      return errorResponse(new Error(`Research job "${jobId}" not found.`));
   }

   const elapsed = Date.now() - start;
   return successResponse(makeResult('deep_research', { jobId, status: snapshot.status }, elapsed));
}

// ── Main handler ───────────────────────────────────────────────────────────

async function handleDeepResearch(
   rawArgs: unknown,
   cfg: SearchConfig,
   extra?: DeepResearchExtra,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
   // Validate the args through Zod for type coercion (defaults applied)
   const parsed = deepResearchSchema.safeParse(rawArgs);
   if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first
         ? `${first.path.join('.')}: ${first.message}`
         : 'Invalid arguments';
      return errorResponse(new Error(msg));
   }

   const args = parsed.data;

   switch (args.action) {
      case 'start':
         return handleStart(args, cfg, extra);
      case 'poll':
         return handlePoll(args);
      case 'list':
         return handleList();
      case 'cancel':
         return handleCancel(args);
   }
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerDeepResearchTool(server: McpServer, cfg: SearchConfig): void {
   server.registerTool(
      'deep_research',
      {
         description:
            'Conduct deep multi-source research via a job/poll protocol.\n\n' +
            'Actions:\n' +
            '  start  — Begin research. Returns jobId immediately. Research runs in background.\n' +
            '  poll   — Check job status and retrieve partial or complete results.\n' +
            '  list   — List all active and recent research jobs.\n' +
            '  cancel — Cancel a running research job.\n\n' +
            'Uses a 7-phase pipeline: query decomposition → parallel discovery → extraction → gap analysis → audit → synthesis.',
         inputSchema: deepResearchSchema,
      },
      async (rawArgs: unknown, extra) => {
         return handleDeepResearch(rawArgs, cfg, extra as DeepResearchExtra | undefined);
      },
   );

   logger.info('Registered deep_research tool (job/poll pattern)');
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Derive a human-readable phase label from progress percentage. */
function derivePhase(progress: number): string {
   if (progress < 10) return 'initializing';
   if (progress < 25) return 'decomposition';
   if (progress < 60) return 'worker_investigation';
   if (progress < 65) return 'gap_analysis';
   if (progress < 90) return 'audit';
   return 'synthesis';
}
