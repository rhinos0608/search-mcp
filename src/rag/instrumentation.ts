import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TraceSpan {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: 'started' | 'completed' | 'failed';
  error?: string;
  metadata?: Record<string, unknown>;
  children: TraceSpan[];
}

export interface RetrievalRunTrace {
  runId: string;
  adapter: string;
  query: string;
  startedAt: Date;
  completedAt?: Date;
  totalDurationMs: number;
  spans: TraceSpan[];
  metadata: Record<string, unknown>;
}

export interface InstrumentationOptions {
  enabled: boolean;
  logLevel: 'debug' | 'info' | 'warn';
  emitToLogger: boolean;
  collectSpans: boolean;
}

const defaultOptions: InstrumentationOptions = {
  enabled: true,
  logLevel: 'info',
  emitToLogger: true,
  collectSpans: true,
};

let globalOptions: InstrumentationOptions = { ...defaultOptions };

// ── Global options ─────────────────────────────────────────────────────────

export function configureInstrumentation(opts: Partial<InstrumentationOptions>): void {
  globalOptions = { ...globalOptions, ...opts };
}

export function getInstrumentationOptions(): InstrumentationOptions {
  return { ...globalOptions };
}

export function resetInstrumentation(): void {
  globalOptions = { ...defaultOptions };
  activeRuns.clear();
}

// ── Run tracking ─────────────────────────────────────────────────────────────

const activeRuns = new Map<string, RetrievalRunTrace>();

export function startRun(adapter: string, query: string): RetrievalRunTrace {
  const runId = generateRunId();
  const trace: RetrievalRunTrace = {
    runId,
    adapter,
    query,
    startedAt: new Date(),
    totalDurationMs: 0,
    spans: [],
    metadata: {},
  };

  if (globalOptions.collectSpans) {
    activeRuns.set(runId, trace);
  }

  if (globalOptions.emitToLogger && globalOptions.enabled) {
    logger.info({ runId, adapter, query }, 'RAG run started');
  }

  return trace;
}

export function completeRun(
  runId: string,
  metadata?: Record<string, unknown>,
): RetrievalRunTrace | undefined {
  const trace = activeRuns.get(runId);
  if (!trace) return undefined;

  trace.completedAt = new Date();
  trace.totalDurationMs = trace.completedAt.getTime() - trace.startedAt.getTime();

  if (metadata) {
    Object.assign(trace.metadata, metadata);
  }

  if (globalOptions.emitToLogger && globalOptions.enabled) {
    logger.info(
      {
        runId,
        adapter: trace.adapter,
        query: trace.query,
        totalDurationMs: trace.totalDurationMs,
        spanCount: trace.spans.length,
        ...trace.metadata,
      },
      'RAG run completed',
    );
  }

  activeRuns.delete(runId);
  return trace;
}

export function getRun(runId: string): RetrievalRunTrace | undefined {
  return activeRuns.get(runId);
}

export function listActiveRuns(): RetrievalRunTrace[] {
  return [...activeRuns.values()];
}

// ── Span tracking ──────────────────────────────────────────────────────────

export function startSpan(
  runId: string,
  name: string,
  metadata?: Record<string, unknown>,
): TraceSpan | undefined {
  if (!globalOptions.enabled || !globalOptions.collectSpans) return undefined;

  const trace = activeRuns.get(runId);
  if (!trace) return undefined;

  const span: TraceSpan = {
    name,
    startMs: performance.now(),
    status: 'started',
    ...(metadata ? { metadata } : {}),
    children: [],
  };

  trace.spans.push(span);

  if (globalOptions.emitToLogger && globalOptions.logLevel === 'debug') {
    logger.debug({ runId, span: name, ...metadata }, 'Span started');
  }

  return span;
}

export function endSpan(
  span: TraceSpan | undefined,
  status: 'completed' | 'failed' = 'completed',
  error?: string,
): void {
  if (!span) return;

  const endMs = performance.now();
  span.endMs = endMs;
  span.durationMs = endMs - span.startMs;
  span.status = status;

  if (error) {
    span.error = error;
  }

  if (globalOptions.emitToLogger && globalOptions.logLevel === 'debug') {
    logger.debug(
      {
        span: span.name,
        durationMs: Math.round(span.durationMs),
        status,
        ...(error ? { error } : {}),
      },
      status === 'failed' ? 'Span failed' : 'Span completed',
    );
  }
}

export function spanSync<T>(
  runId: string,
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  const span = startSpan(runId, name, metadata);
  try {
    const result = fn();
    endSpan(span, 'completed');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endSpan(span, 'failed', message);
    throw err;
  }
}

export async function spanAsync<T>(
  runId: string,
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const span = startSpan(runId, name, metadata);
  try {
    const result = await fn();
    endSpan(span, 'completed');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endSpan(span, 'failed', message);
    throw err;
  }
}

// ── High-level pipeline instrumentation ────────────────────────────────────

export interface PipelineInstrumentation {
  runId: string;
  tracePrepareCorpus(options: { documentCount: number; dedupEnabled: boolean }): void;
  traceRetrieveCorpus(options: {
    totalChunks: number;
    vectorCandidates: number;
    lexicalCandidates: number;
    returnedResults: number;
    constraintEnabled: boolean;
  }): void;
  traceEnd(): RetrievalRunTrace;
}

export function instrumentPipeline(adapter: string, query: string): PipelineInstrumentation {
  const run = startRun(adapter, query);

  return {
    runId: run.runId,

    tracePrepareCorpus(options: { documentCount: number; dedupEnabled: boolean }): void {
      if (!globalOptions.enabled) return;
      startSpan(run.runId, 'prepareCorpus', {
        documentCount: options.documentCount,
        dedupEnabled: options.dedupEnabled,
      });
    },

    traceRetrieveCorpus(options: {
      totalChunks: number;
      vectorCandidates: number;
      lexicalCandidates: number;
      returnedResults: number;
      constraintEnabled: boolean;
    }): void {
      if (!globalOptions.enabled) return;
      startSpan(run.runId, 'retrieveCorpus', {
        totalChunks: options.totalChunks,
        vectorCandidates: options.vectorCandidates,
        lexicalCandidates: options.lexicalCandidates,
        returnedResults: options.returnedResults,
        constraintEnabled: options.constraintEnabled,
      });
    },

    traceEnd(): RetrievalRunTrace {
      return completeRun(run.runId) ?? run;
    },
  };
}

// ── Adapter instrumentation ──────────────────────────────────────────────────

export function instrumentAdapter<T>(
  runId: string,
  adapterType: string,
  operation: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  return spanSync(runId, `${adapterType}:${operation}`, fn, {
    adapterType,
    operation,
    ...metadata,
  });
}

export async function instrumentAdapterAsync<T>(
  runId: string,
  adapterType: string,
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  return spanAsync(runId, `${adapterType}:${operation}`, fn, {
    adapterType,
    operation,
    ...metadata,
  });
}

// ── Timing helpers ───────────────────────────────────────────────────────────

export function timed<T>(fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  return { result, durationMs: performance.now() - start };
}

export async function timedAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function generateRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
