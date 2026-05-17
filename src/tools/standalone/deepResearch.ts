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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import {
  ResearchOrchestrator,
  type OrchestratorLlmConfig,
  type ProgressCallback,
} from '../../research/orchestrator.js';
import { researchJobManager } from '../../research/jobManager.js';
import type { ResearchJobSnapshot } from '../../research/jobManager.js';
import type { ResearchResult, ResearchReport } from '../../research/types.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import { logger } from '../../logger.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';

// ── Schema (flat object — MCP clients render flat properties) ──────────────

const deepResearchSchema = z.object({
  action: z.enum(['start', 'poll', 'list', 'cancel', 'save', 'run']).describe('Which action to perform'),
  jobId: z.string().optional().describe('Job ID (required for poll, cancel, and save)'),
  path: z
    .string()
    .optional()
    .describe(
      'Optional file path to save the research result (save action). If omitted, a default path under ~/.cache/search-mcp/research-results/ is used.',
    ),
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
        '- quick: 5-10 sources, 1 gap loop (~5min)\n' +
        '- standard: 15-25 sources, 2 gap loops (~8min)\n' +
        '- deep: 30-60 sources, 3 gap loops (~30min)\n' +
        '- exhaustive: 100+ sources, comprehensive coverage (~45min)\n' +
        '- tree: breadth×depth recursive exploration (4 sub-queries × 2 levels, ~15min)',
    ),
  maxTimeMs: z
    .number()
    .int()
    .min(10_000)
    .max(2_700_000)
    .optional()
    .describe(
      'Maximum runtime in milliseconds (10s to 45min). If omitted, the depth profile default is used.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(300_000)
    .optional()
    .describe(
      'Maximum wait in milliseconds for the run convenience action (10s to 5min). Defaults to 60s. On timeout, returns partial status with jobId and retry metadata.',
    ),
  strategy: z
    .enum(['agent', 'pipeline', 'tree'])
    .optional()
    .describe(
      'Research strategy. When omitted, defaults to agent (when LLM configured) or pipeline (deterministic fallback). Use tree for breadth×depth recursive exploration.',
    ),
  deterministic: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, forces the research to run without any LLM API calls (purely deterministic algorithms).',
    ),
  save: z
    .boolean()
    .optional()
    .default(true)
    .describe('Save result to disk when research completes. Set false to opt out of auto-save.'),
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
/** Default timeout for the run convenience action. */
const RUN_DEFAULT_TIMEOUT_MS = POLL_WAIT_MS;
/** Interval between status checks during poll wait. */
const POLL_INTERVAL_MS = 2_000;

// ── Action handlers ────────────────────────────────────────────────────────

async function handleStart(
  args: DeepResearchArgs,
  cfg: SearchConfig,
  extra: DeepResearchExtra | undefined,
  kgHook: KnowledgeGraphHook | undefined,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
  const start = Date.now();

  if (typeof args.query !== 'string' || args.query.length < 10) {
    return errorResponse(new Error('start requires query (min 10 characters)'));
  }
  const query = args.query;
  const depth = args.depth;
  const maxTimeMs = args.maxTimeMs;
  const strategy = args.strategy;
  const deterministic = args.deterministic;
  const requestedStrategy = depth === 'tree' ? 'tree' : deterministic ? 'pipeline' : strategy;

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
    logger.info(
      { workerBaseUrl: drCfg.workerBaseUrl, baseUrl: drCfg.baseUrl },
      'DR LLM config debug',
    );
    llmConfig = {
      baseUrl: drCfg.baseUrl,
      workerBaseUrl: drCfg.workerBaseUrl || drCfg.baseUrl,
      model: drCfg.model,
      workerModel: drCfg.workerModel || drCfg.model,
      ...(drCfg.apiToken ? { apiToken: drCfg.apiToken } : {}),
    };
  }

  // Register job with the manager
  const snapshot = researchJobManager.create({
    query,
    depth,
    maxTimeMs: maxTimeMs ?? undefined,
    ...(requestedStrategy !== undefined ? { strategy: requestedStrategy } : {}),
  });
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

  // Opt-in flag for auto-save (default: true)
  const autoSave = args.save;

  // ── Build progress callback ─────────────────────────────────────────────
  const onProgress: ProgressCallback = async (progress, message, phase, partials) => {
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
    // Use explicit phase from orchestrator when available, otherwise derive from progress
    const resolvedPhase = phase ?? derivePhase(progress);
    researchJobManager.update(jobId, {
      progress,
      phase: resolvedPhase,
      message: message ?? undefined,
      classification: partials?.classification ?? undefined,
      subQuestionCount: partials?.subQuestionCount ?? undefined,
      sourceCount: partials?.sourceCount ?? undefined,
      sourceTypeCount: partials?.sourceTypeCount ?? undefined,
      findingCount: partials?.findingCount ?? undefined,
      gapLoopCount: partials?.gapLoopCount ?? undefined,
    });
  };

  // ── Fire orchestrator in detached promise ────────────────────────────────
  const orchestrator = new ResearchOrchestrator(drCfg, llmConfig);

  // Not awaited — runs in background
  const promise = orchestrator.run(
    query,
    depth,
    maxTimeMs,
    abortSignal,
    onProgress,
    jobId,
    strategy,
    deterministic,
  );

  promise
    .then(async (result) => {
      researchJobManager.complete(jobId, result);

      // KG extraction from deep research synthesis (uses persistent hook for proper
      // active-run routing during research)
      if (cfg.knowledgeGraph.enabled && kgHook) {
        try {
          await kgHook.onDeepResearchComplete(jobId, result);
        } catch (err) {
          logger.warn({ err, jobId }, 'KG extraction after deep research failed (non-fatal)');
        }
      }

      if (autoSave) {
        try {
          await autoSaveResult(jobId, args.path, getDefaultResultsDir);
        } catch (err) {
          logger.warn({ err, jobId }, 'Auto-save threw unexpectedly (non-fatal)');
        }
      }

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
    makeResult(
      'deep_research',
      { jobId, status: snapshot.status, retryAfterMs: POLL_WAIT_MS },
      elapsed,
    ),
  );
}

/**
 * Convenience: start and poll until complete or timeout.
 * Returns final result on completion, or partial status with jobId and retry metadata on timeout.
 */
async function handleRun(
  args: DeepResearchArgs,
  cfg: SearchConfig,
  extra: DeepResearchExtra | undefined,
  kgHook: KnowledgeGraphHook | undefined,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
  const start = Date.now();

  // First, start the job using handleStart
  const startResult = await handleStart(args, cfg, extra, kgHook);
  if ('isError' in startResult) {
    return startResult;
  }

  // Parse jobId from the start result
  let jobId: string | undefined;
  try {
    const content: unknown = JSON.parse(startResult.content[0]?.text ?? '{}');
    if (typeof content === 'object' && content !== null && 'data' in content) {
      const data = content.data;
      if (typeof data === 'object' && data !== null && 'jobId' in data) {
        const parsedJobId = data.jobId;
        if (typeof parsedJobId === 'string') {
          jobId = parsedJobId;
        }
      }
    }
    if (!jobId) {
      return errorResponse(new Error('Start did not return a jobId'));
    }
  } catch {
    return errorResponse(new Error('Failed to parse start result'));
  }

  // Bounded poll loop
  const timeoutMs = args.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const snapshot: ResearchJobSnapshot | null = researchJobManager.poll(jobId);
    if (!snapshot) {
      return errorResponse(new Error(`Research job "${jobId}" not found.`));
    }

    // Terminal state → return final result
    if (
      snapshot.status === 'complete' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled' ||
      snapshot.status === 'expired'
    ) {
      if (snapshot.status === 'complete' && !snapshot.result && snapshot.resultFile) {
        snapshot.result = ensureResultLoaded(jobId);
      }
      const elapsed = Date.now() - start;
      return successResponse(makeResult('deep_research', snapshot, elapsed));
    }

    // Timeout → return partial status with retry metadata
    const now = Date.now();
    if (now >= deadline) {
      const elapsed = now - start;
      return successResponse(
        makeResult(
          'deep_research',
          { ...snapshot, jobId },
          elapsed,
          {
            partial: true,
            retry: {
              recommended: true,
              reason: 'Research did not complete within the timeout window. Poll for results.',
              minimalCall: {
                action: 'poll',
                jobId,
              },
            },
          },
        ),
      );
    }

    const remaining = deadline - now;
    const delay = Math.min(POLL_INTERVAL_MS, remaining);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
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

  for (;;) {
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
      // If result is missing from memory but a save file exists, load it back
      if (snapshot.status === 'complete' && !snapshot.result && snapshot.resultFile) {
        snapshot.result = ensureResultLoaded(jobId);
      }

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

/** Default directory for persisted research result files. */
function getDefaultResultsDir(): string {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    // Use a sibling directory relative to DATABASE_PATH
    return path.join(path.dirname(dbPath), 'research-results');
  }
  return path.join(os.homedir(), '.cache', 'search-mcp', 'research-results');
}

/**
 * Resolve an output path for a research result, with path-traversal protection.
 * Used by both auto-save and the save action.
 * Hierarchical default: results/YYYY/MM/DD/jobId.json
 */
function resolveResultPath(
  requestedPath: string | undefined,
  jobId: string,
  getResultsDir: () => string,
): string {
  const safeBaseDir = path.resolve(getResultsDir());
  if (requestedPath) {
    const resolved = path.resolve(safeBaseDir, requestedPath);
    if (!resolved.startsWith(safeBaseDir)) {
      throw new Error(
        `Path "${requestedPath}" escapes the results directory "${safeBaseDir}". Use a relative filename or omit path to save to the default location.`,
      );
    }
    return resolved;
  }

  // Hierarchical default: results/YYYY/MM/DD/jobId.json
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');

  return path.join(safeBaseDir, year, month, day, `${jobId}.json`);
}

/**
 * Save a completed research result to disk and record the path in the job manager.
 * Errors are non-fatal — failures are logged but do not surface to the caller.
 */
async function autoSaveResult(
  jobId: string,
  requestedPath: string | undefined,
  getResultsDir: () => string,
): Promise<string | null> {
  const snapshot = researchJobManager.poll(jobId);
  if (!snapshot) {
    logger.debug({ jobId }, 'Auto-save skipped: no job found (may have expired)');
    return null;
  }

  const outputPath = resolveResultPath(requestedPath, jobId, getResultsDir);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // Save the FULL snapshot (metadata + result)
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    // Offload from memory — poll will load back from disk if needed
    researchJobManager.setResultFile(jobId, outputPath, true);
    logger.info({ jobId, outputPath }, 'Auto-saved full research snapshot to disk');
    return outputPath;
  } catch (err) {
    logger.warn({ err, jobId, outputPath }, 'Auto-save failed (non-fatal)');
    return null;
  }
}

/**
 * Helper to ensure a job's result is loaded into memory if it was offloaded to disk.
 */
function ensureResultLoaded(jobId: string): ResearchResult | undefined {
  const result = researchJobManager.getResult(jobId);
  if (result) return result;

  const resultFile = researchJobManager.getResultFile(jobId);
  if (resultFile) {
    try {
      const raw = fs.readFileSync(resultFile, 'utf-8');
      const loaded = JSON.parse(raw) as unknown;

      // Handle both legacy (result only) and new (full snapshot) files
      if (loaded && typeof loaded === 'object') {
        const job = loaded as { result?: ResearchResult; jobId?: string };
        if (job.result) {
          return job.result;
        }
        // If it's a legacy file, 'loaded' might be ResearchReport or ResearchResult
        const anyLoaded = loaded as Record<string, unknown>;
        if (anyLoaded.report) {
          return loaded as ResearchResult;
        }
        if (anyLoaded.query && (anyLoaded as { narrativeMarkdown?: string }).narrativeMarkdown) {
          // It's a legacy ResearchReport — wrap it in ResearchResult
          return {
            report: anyLoaded as unknown as ResearchReport,
            timeline: [],
          };
        }
      }
    } catch (err) {
      logger.warn({ err, jobId, path: resultFile }, 'Failed to load offloaded result from disk');
    }
  }
  return undefined;
}

async function handleSave(
  args: DeepResearchArgs,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
  const start = Date.now();

  if (typeof args.jobId !== 'string') {
    return errorResponse(new Error('save requires jobId'));
  }
  const jobId = args.jobId;

  // Get the completed result (ensuring it's loaded if offloaded)
  const result = ensureResultLoaded(jobId);
  if (!result) {
    return errorResponse(
      new Error(`Research job "${jobId}" not found, not yet complete, or has expired.`),
    );
  }

  // Resolve output path with path-traversal protection
  const outputPath = resolveResultPath(args.path, jobId, getDefaultResultsDir);

  try {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // Write the full result as formatted JSON
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

    // Record the file path on the job and offload from memory
    researchJobManager.setResultFile(jobId, outputPath, true);

    const elapsed = Date.now() - start;
    logger.info(
      { jobId, outputPath, sizeBytes: Buffer.byteLength(JSON.stringify(result), 'utf-8') },
      'Research result saved to file and offloaded from memory',
    );

    return successResponse(makeResult('deep_research', { jobId, resultFile: outputPath }, elapsed));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error, jobId, outputPath }, 'Failed to save research result');
    return errorResponse(new Error(`Failed to save result: ${error.message}`));
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
  extra: DeepResearchExtra | undefined,
  kgHook: KnowledgeGraphHook | undefined,
): Promise<ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>> {
  // Validate the args through Zod for type coercion (defaults applied)
  const parsed = deepResearchSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first ? `${first.path.join('.')}: ${first.message}` : 'Invalid arguments';
    return errorResponse(new Error(msg));
  }

  const args = parsed.data;

  switch (args.action) {
    case 'start':
      return handleStart(args, cfg, extra, kgHook);
    case 'run':
      return handleRun(args, cfg, extra, kgHook);
    case 'poll':
      return handlePoll(args);
    case 'list':
      return handleList();
    case 'cancel':
      return handleCancel(args);
    case 'save':
      return handleSave(args);
  }
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Recursively find all .json research files and register them with the job manager.
 */
function rehydratePersistentJobs(baseDir: string): void {
  if (!fs.existsSync(baseDir)) return;

  try {
    const rootContents = fs.readdirSync(baseDir);
    let count = 0;
    const tryRegisterJob = (filePath: string): void => {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as unknown;
        if (data && typeof data === 'object' && 'jobId' in data) {
          researchJobManager.registerJob(data as ResearchJobSnapshot);
          count++;
        }
      } catch (_err) {
        // Ignore malformed or incompatible files during re-hydration.
      }
    };

    for (const entry of rootContents) {
      const entryPath = path.join(baseDir, entry);
      const stats = fs.statSync(entryPath);

      if (stats.isFile() && entry.endsWith('.json')) {
        // Root file (legacy or custom path)
        tryRegisterJob(entryPath);
        continue;
      }

      if (stats.isDirectory() && /^\d{4}$/.test(entry)) {
        // Hierarchical (YYYY/MM/DD)
        const monthDirs = fs.readdirSync(entryPath);
        for (const month of monthDirs) {
          const monthPath = path.join(entryPath, month);
          if (!fs.statSync(monthPath).isDirectory()) continue;

          const dayDirs = fs.readdirSync(monthPath);
          for (const day of dayDirs) {
            const dayPath = path.join(monthPath, day);
            if (!fs.statSync(dayPath).isDirectory()) continue;

            const files = fs.readdirSync(dayPath);
            for (const file of files) {
              if (!file.endsWith('.json')) continue;
              tryRegisterJob(path.join(dayPath, file));
            }
          }
        }
      }
    }

    if (count > 0) {
      logger.info({ count, baseDir }, 'Re-hydrated persistent research jobs from disk');
    }
  } catch (err) {
    logger.warn({ err, baseDir }, 'Failed to re-hydrate research jobs');
  }
}

export function registerDeepResearchTool(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  // Bootstrap: Re-hydrate persistent jobs on registration
  if (cfg.deepResearch.enabled) {
    const resultsDir = getDefaultResultsDir();
    rehydratePersistentJobs(resultsDir);
  }

  server.registerTool(
    'deep_research',
    {
      description:
        'Conduct deep multi-source research via a job/poll protocol.\n\n' +
        'Actions:\n' +
        '  start  — Begin research. Returns jobId immediately. Research runs in background. Results are auto-saved to disk unless save=false is set.\n' +
        '  run    — Convenience: start and poll until complete or timeout. Returns final result, or partial status + jobId + retry metadata on timeout.\n' +
        '  poll   — Check job status and retrieve partial or complete results.\n' +
        '  list   — List all jobs. Includes status, progress, saved file path, and creation time for each. Use poll with a jobId to retrieve results.\n' +
        '  cancel — Cancel a running research job.\n' +
        '  save   — Explicitly save a completed result to disk. Use jobId and optional path. (Usually not needed — results auto-save by default.)\n\n' +
        'Two-tier storage:\n' +
        '  1. Saved Results: Permanent hierarchical storage (results/YYYY/MM/DD/jobId.json). Results are offloaded from memory but reloaded on demand.\n' +
        '  2. Unsaved Results: Held in memory for 24 hours then expired. Always auto-saves by default unless save=false is set.\n\n' +
        'Depth profiles and estimated durations:\n' +
        '  quick   — 5 minutes (5-10 sources, 1 gap loop, fast overview)\n' +
        '  standard — 12 minutes (15-25 sources, 2 gap loops, balanced approach)\n' +
        '  deep    — 30 minutes (30-60 sources, 3 gap loops, thorough investigation)\n' +
        '  exhaustive — 45 minutes (100+ sources, comprehensive coverage, maximum depth)\n' +
        '  tree    — 15 minutes (4 sub-queries × 2 levels, breadth×depth recursive exploration)\n\n' +
        'Uses strategy-based research: agent (LLM-driven ReAct, default when LLM configured), pipeline (fixed 7-phase), or tree (recursive).\n' +
        'The agent strategy adapts tactics mid-research using tool-calling.\n' +
        'The pipeline strategy uses a fixed 7-phase pipeline: decomposition → discovery → extraction → gap analysis → audit → synthesis.\n\n' +
        'Use the `deterministic` flag to force research without any LLM calls (algorithmic decomposition, regex extraction).',
      inputSchema: deepResearchSchema,
    },
    async (rawArgs: unknown, extra) => {
      return handleDeepResearch(rawArgs, cfg, extra as DeepResearchExtra | undefined, kgHook);
    },
  );

  logger.info('Registered deep_research tool (job/poll pattern)');
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable phase label from progress percentage.
 * Used as a fallback when the orchestrator does not provide an explicit phase.
 */
function derivePhase(progress: number): string {
  if (progress < 10) return 'initializing';
  if (progress < 20) return 'decomposition';
  if (progress < 30) return 'worker_searching';
  if (progress < 45) return 'worker_fetching';
  if (progress < 52) return 'worker_synthesizing';
  if (progress < 60) return 'gap_analysis';
  if (progress < 65) return 'gap_filling';
  if (progress < 95) return 'audit';
  if (progress < 100) return 'synthesis';
  return 'complete';
}
