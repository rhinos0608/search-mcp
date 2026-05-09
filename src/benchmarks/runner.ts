/**
 * Deep Research Benchmark runner.
 *
 * Executes benchmark questions through the ResearchOrchestrator, collects
 * results, and grades accuracy against ground truth answers.
 *
 * Supports:
 * - Configurable research depth and timeouts
 * - LLM or deterministic (no-LLM) research mode
 * - LLM or heuristic grading
 * - Per-question concurrency limit
 * - Domain and difficulty filtering
 * - Timing breakdown per question
 */

import {
  ResearchOrchestrator,
  type OrchestratorLlmConfig,
  type ProgressCallback,
} from '../research/orchestrator.js';
import { BenchmarkGrader, type GraderConfig } from './grader.js';
import { benchmarkQuestions } from './questions.js';
import { logger } from '../logger.js';
import type {
  BenchmarkConfig,
  BenchmarkQuestion,
  BenchmarkOutput,
  BenchmarkMetrics,
  QuestionBenchmarkResult,
  BenchmarkDomain,
  BenchmarkDifficulty,
  GradeMethod,
} from './types.js';
import type { ResearchResult } from '../research/types.js';
import type { DeepResearchConfig } from '../config.js';

// ── Defaults ───────────────────────────────────────────────────────────────

/** Minimal deep research config for the benchmark runner. */
function buildDrConfig(cfg: BenchmarkConfig): Partial<DeepResearchConfig> {
  return {
    enabled: true,
    defaultDepth: cfg.depth,
    maxDepth: cfg.depth,
    maxToolCalls: 200,
    maxTokens: 500_000,
    maxTimeMs: cfg.questionTimeoutMs,
    baseUrl: '',
    model: '',
    workerModel: '',
    apiToken: '',
    treeBreadth: 4,
    treeDepth: 2,
    treeConcurrency: 2,
    treeContextWordLimit: 25000,
    agentMaxIterations: 30,
    agentMaxSubIterations: 8,
    agentDefaultFetchMode: 'summary_focus_query',
  };
}

// ── Filtering ──────────────────────────────────────────────────────────────

/** Filter questions by domain and difficulty. */
export function filterQuestions(cfg: BenchmarkConfig): readonly BenchmarkQuestion[] {
  let questions = benchmarkQuestions;

  if (cfg.domains && cfg.domains.length > 0) {
    const domainSet = new Set<BenchmarkDomain>(cfg.domains);
    questions = questions.filter((q) => domainSet.has(q.domain));
  }

  if (cfg.difficulties && cfg.difficulties.length > 0) {
    const diffSet = new Set<BenchmarkDifficulty>(cfg.difficulties);
    questions = questions.filter((q) => diffSet.has(q.difficulty));
  }

  return questions;
}

// ── Phase timing extraction ────────────────────────────────────────────────

function extractPhaseTimings(timeline: ResearchResult['timeline']): Record<string, number> {
  const timings: Record<string, number> = {};

  if (!Array.isArray(timeline) || timeline.length === 0) return timings;

  for (const entry of timeline) {
    const phase: string = entry.phase;
    // Use duration if available, otherwise skip
    const durationMs = (entry as { durationMs?: number }).durationMs;
    if (durationMs !== undefined) {
      timings[phase] = (timings[phase] ?? 0) + durationMs;
    }
  }

  return timings;
}

// ── Metrics computation ────────────────────────────────────────────────────

function computeMetrics(results: QuestionBenchmarkResult[], method: GradeMethod): BenchmarkMetrics {
  const total = results.length;
  const correct = results.filter((r) => r.grade.verdict === 'correct').length;
  const incorrect = results.filter((r) => r.grade.verdict === 'incorrect').length;
  const unclear = results.filter((r) => r.grade.verdict === 'unclear').length;
  const timedOut = results.filter((r) => r.timedOut).length;
  const errors = results.filter((r) => r.error !== undefined).length;

  const avgElapsedMs =
    total > 0 ? Math.round(results.reduce((sum, r) => sum + r.elapsedMs, 0) / total) : 0;
  const avgSourceCount =
    total > 0 ? Math.round(results.reduce((sum, r) => sum + r.sourceCount, 0) / total) : 0;
  const avgFindingCount =
    total > 0 ? Math.round(results.reduce((sum, r) => sum + r.findingCount, 0) / total) : 0;

  // Domain breakdown
  const domainTotal: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    const d = r.question.domain;
    domainTotal[d] ??= { total: 0, correct: 0 };
    domainTotal[d].total++;
    if (r.grade.verdict === 'correct') domainTotal[d].correct++;
  }
  const domainBreakdown = Object.fromEntries(
    Object.entries(domainTotal).map(([domain, data]) => [
      domain,
      {
        total: data.total,
        correct: data.correct,
        accuracy: data.total > 0 ? data.correct / data.total : 0,
      },
    ]),
  ) as BenchmarkMetrics['domainBreakdown'];

  // Difficulty breakdown
  const diffTotal: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    const d = r.question.difficulty;
    diffTotal[d] ??= { total: 0, correct: 0 };
    diffTotal[d].total++;
    if (r.grade.verdict === 'correct') diffTotal[d].correct++;
  }
  const difficultyBreakdown = Object.fromEntries(
    Object.entries(diffTotal).map(([diff, data]) => [
      diff,
      {
        total: data.total,
        correct: data.correct,
        accuracy: data.total > 0 ? data.correct / data.total : 0,
      },
    ]),
  ) as BenchmarkMetrics['difficultyBreakdown'];

  // Depth breakdown
  const depthKey = results[0]?.depth ?? 'standard';
  const depthAccuracy = total > 0 ? correct / total : 0;
  const depthBreakdown: Record<string, { total: number; correct: number; accuracy: number }> = {
    [depthKey]: { total, correct, accuracy: depthAccuracy },
  };

  return {
    totalQuestions: total,
    correct,
    incorrect,
    unclear,
    accuracy: total > 0 ? correct / total : 0,
    accuracyGivenAnswer: total - unclear > 0 ? correct / (total - unclear) : 0,
    avgElapsedMs,
    avgSourceCount,
    avgFindingCount,
    timedOutCount: timedOut,
    errorCount: errors,
    domainBreakdown,
    difficultyBreakdown,
    depthBreakdown,
    gradeMethod: method,
  };
}

// ── Single question execution ──────────────────────────────────────────────

interface RunOneOptions {
  question: BenchmarkQuestion;
  orchestrator: ResearchOrchestrator;
  depth: BenchmarkConfig['depth'];
  deterministic: boolean;
  timeoutMs: number;
  strategy?: string;
}

async function runOneQuestion(opts: RunOneOptions): Promise<QuestionBenchmarkResult> {
  const { question, orchestrator, depth, deterministic, timeoutMs, strategy } = opts;
  const startTime = Date.now();

  const phaseStartTimes: Record<string, number> = {};
  const phaseTimingsRaw: Record<string, number> = {};

  const onProgress: ProgressCallback = (progress, _message, phase) => {
    const label = phase ?? `progress_${String(progress)}`;
    phaseStartTimes[label] ??= Date.now();
  };

  // Create an AbortController for per-question timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await orchestrator.run(
      question.question,
      depth,
      timeoutMs,
      controller.signal,
      onProgress,
      undefined, // jobId — not needed for benchmarks
      strategy,
      deterministic,
    );

    clearTimeout(timeoutId);

    // Compute phase timings
    const now = Date.now();
    for (const [phase, start] of Object.entries(phaseStartTimes)) {
      phaseTimingsRaw[phase] = now - start;
    }

    const report = result.report;
    const timelinePhases = extractPhaseTimings(result.timeline);

    return {
      question,
      depth: report.depth,
      classification: report.classification,
      elapsedMs: now - startTime,
      sourceCount: report.sourceCount,
      findingCount: report.findingCount,
      executiveSummary: report.executiveSummary,
      narrativeMarkdown: report.narrativeMarkdown.slice(0, 2000),
      phaseTimings: { ...timelinePhases, ...phaseTimingsRaw },
      grade: {
        questionId: question.id,
        verdict: 'unclear',
        reasoning: 'Not yet graded.',
        extractedAnswer: '',
      },
      gradeMethod: 'heuristic',
      timedOut: false,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    const isTimeout =
      (err instanceof Error && err.name === 'AbortError') ||
      (err instanceof Error && err.message.includes('aborted'));

    return {
      question,
      depth,
      classification: 'unknown',
      elapsedMs: Date.now() - startTime,
      sourceCount: 0,
      findingCount: 0,
      executiveSummary: '',
      narrativeMarkdown: '',
      phaseTimings: {},
      grade: {
        questionId: question.id,
        verdict: 'unclear',
        reasoning: isTimeout ? 'Research timed out.' : `Error: ${String(err)}`,
        extractedAnswer: '',
        unclearReason: isTimeout ? 'timeout' : 'error',
      },
      gradeMethod: 'heuristic',
      timedOut: isTimeout,
      ...(isTimeout ? {} : { error: String(err) }),
    };
  }
}

// ── Concurrency limiter ────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) return;
      results[idx] = await fn(item, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface RunBenchmarkOptions {
  /** Benchmark config. */
  config: BenchmarkConfig;
  /** Optional LLM config for research (orchestrator + worker models). */
  llmConfig?: OrchestratorLlmConfig;
  /** Optional grader LLM config. */
  graderConfig?: GraderConfig;
  /** Optional progress callback (total, completed). */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Run the full benchmark.
 *
 * 1. Filters questions by domain/difficulty.
 * 2. Runs them through the orchestrator with specified concurrency.
 * 3. Grades all results.
 * 4. Computes metrics.
 * 5. Returns structured output.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchmarkOutput> {
  const { config, llmConfig, graderConfig, onProgress } = opts;

  const questions = filterQuestions(config);
  logger.info(
    { total: questions.length, depth: config.depth, deterministic: config.deterministic },
    'Starting benchmark run',
  );

  // Build orchestrator
  const drCfg = buildDrConfig(config);
  const orchestrator = new ResearchOrchestrator(drCfg, llmConfig);

  // Determine strategy
  const effectiveStrategy = config.deterministic ? 'pipeline' : undefined;

  // Run all questions
  const total = questions.length;
  let completed = 0;

  const rawResults = await runWithConcurrency(questions, config.concurrency, async (question) => {
    const result = await runOneQuestion({
      question,
      orchestrator,
      depth: config.depth,
      deterministic: config.deterministic,
      timeoutMs: config.questionTimeoutMs,
      ...(effectiveStrategy !== undefined ? { strategy: effectiveStrategy } : {}),
    });
    completed++;
    onProgress?.(completed, total);
    logger.info(
      { qid: question.id, elapsedMs: result.elapsedMs, sources: result.sourceCount },
      `Benchmark progress: ${String(completed)}/${String(total)}`,
    );
    return result;
  });

  // Grade results
  const grader = new BenchmarkGrader(graderConfig);
  const gradeMethod = grader.method;

  const gradeInputs = rawResults.map((r) => ({
    question: r.question,
    executiveSummary: r.executiveSummary,
    narrativeSnippet: r.narrativeMarkdown,
  }));

  const gradeResults = await grader.gradeBatch(gradeInputs);

  if (gradeResults.length !== rawResults.length) {
    logger.error(
      { gradeCount: gradeResults.length, rawCount: rawResults.length },
      'Grader result length mismatch',
    );
  }

  // Merge grades into results
  const fullResults: QuestionBenchmarkResult[] = rawResults.map((r, i) => ({
    ...r,
    grade: gradeResults[i] ?? r.grade,
    gradeMethod,
  }));

  // Compute metrics
  const metrics = computeMetrics(fullResults, gradeMethod);

  // Clean up orchestrator
  await orchestrator.close();

  return {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config,
    gradeMethod,
    metrics,
    questions: fullResults,
  };
}
