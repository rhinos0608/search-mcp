/**
 * V4.3.0 — Research job manager for async job/poll deep research.
 *
 * Manages in-flight research jobs with status lifecycle, bounded snapshot
 * state, TTL cleanup, max active limit, and AbortSignal propagation.
 *
 * Status lifecycle:
 *   queued → running → complete
 *                    → cancelling → cancelled
 *                    → failed
 *   any terminal → expired (TTL)
 */

import type { ResearchDepth, ResearchResult } from './types.js';
import { logger } from '../logger.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ACTIVE = 5;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 1_000; // 1 minute
const QUERY_TRUNCATE_LENGTH = 80;

// ── Types ──────────────────────────────────────────────────────────────────────

export type JobStatus =
   | 'queued'
   | 'running'
   | 'complete'
   | 'failed'
   | 'cancelling'
   | 'cancelled'
   | 'expired';

export interface ResearchJobParams {
   query: string;
   depth: ResearchDepth;
   maxTimeMs: number | undefined;
}

/** Bounded partial state available before research completes. */
export interface ResearchJobPartial {
   classification: string | undefined;
   subQuestionCount: number | undefined;
   sourceCount: number | undefined;
   /** Total individual sources (not source types). */
   sourceTypeCount: number | undefined;
   findingCount: number | undefined;
}

/** Snapshot returned by poll. Contains bounded partials, full result only when complete. */
export interface ResearchJobSnapshot {
   jobId: string;
   query: string;
   depth: ResearchDepth;
   status: JobStatus;
   progress: number;
   phase: string;
   message: string | undefined;
   createdAt: number;
   updatedAt: number;
   startedAt: number | undefined;
   completedAt: number | undefined;
   failedAt: number | undefined;
   cancelledAt: number | undefined;
   classification: string | undefined;
   subQuestionCount: number | undefined;
   sourceCount: number | undefined;
   /** Total individual sources (not source types). */
   sourceTypeCount: number | undefined;
   findingCount: number | undefined;
   result: ResearchResult | undefined;
   error: string | undefined;
   /** Path to persisted result file on disk, if saved. */
   resultFile: string | undefined;
   /** Original max time at job creation (before any extensions). */
   originalMaxTimeMs: number;
   /** Current max time (may have been extended). */
   maxTimeMs: number;
   /** Total additional ms granted via extendRuntime. */
   totalExtensionsMs: number;
   /** Number of times extendRuntime was called. */
   extensionCount: number;
   /** Gap loop iterations executed so far. */
   gapLoopCount: number;
}

/** Lightweight summary returned by list. */
export interface ResearchJobSummary {
   jobId: string;
   query: string;
   status: JobStatus;
   progress: number;
   phase: string;
   createdAt: number;
   updatedAt: number;
}

/** Fields that can be updated via update(). */
export interface ResearchJobUpdate extends ResearchJobPartial {
   progress: number;
   phase: string;
   message: string | undefined;
}

// ── Internal job record (not exported) ─────────────────────────────────────────

interface InternalJob {
   // Identity
   jobId: string;
   query: string;
   depth: ResearchDepth;
   /** Original max time at job creation (before any extensions). */
   originalMaxTimeMs: number;
   /** Current max time (may have been extended). */
   maxTimeMs: number;

   // Status lifecycle
   status: JobStatus;
   progress: number;
   phase: string;
   message: string | undefined;

   // Timestamps
   createdAt: number;
   updatedAt: number;
   startedAt: number | undefined;
   completedAt: number | undefined;
   failedAt: number | undefined;
   cancelledAt: number | undefined;

   // Bounded partials
   classification: string | undefined;
   subQuestionCount: number | undefined;
   sourceCount: number | undefined;
   /** Total individual sources (not source types). */
   sourceTypeCount: number | undefined;
   findingCount: number | undefined;

   // Adaptive timeout tracking
   /** Total additional ms granted via extendRuntime. */
   totalExtensionsMs: number;
   /** Number of times extendRuntime was called. */
   extensionCount: number;
   /** Gap loop iterations executed so far (for observability). */
   gapLoopCount: number;

   // Internal (never exposed in snapshot)
   abortController: AbortController | undefined;
   runtimeTimeout: NodeJS.Timeout | undefined;
   result: ResearchResult | undefined;
   error: string | undefined;
   /** Path to persisted result file on disk, if saved. */
   resultFile: string | undefined;
}

// ── Job Manager ────────────────────────────────────────────────────────────────

export class ResearchJobManager {
   private readonly jobs = new Map<string, InternalJob>();
   private readonly maxActive: number;
   private readonly ttlMs: number;
   private nextId = 0;
   private cleanupTimer: ReturnType<typeof setInterval>;

   constructor(options?: { maxActive?: number; ttlMs?: number }) {
      this.maxActive = options?.maxActive ?? DEFAULT_MAX_ACTIVE;
      this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
      this.cleanupTimer = setInterval(() => { this.runCleanup(); }, CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
   }

   // ── Public API ──────────────────────────────────────────────────────────────

   /**
    * Create a new research job. Returns null if max active limit is reached.
    * The job is created in 'queued' status and immediately transitions to 'running'
    * if a slot is available.
    */
   create(params: ResearchJobParams): ResearchJobSnapshot | null {
      const activeCount = this.countActive();
      if (activeCount >= this.maxActive) {
         logger.warn(
            { activeCount, maxActive: this.maxActive },
            'Research job rejected: max active limit reached',
         );
         return null;
      }

      const jobId = this.generateId();
      const maxTimeMs = params.maxTimeMs ?? this.resolveDefaultMaxTimeMs(params.depth);

      const job: InternalJob = {
         jobId,
         query: params.query,
         depth: params.depth,
         originalMaxTimeMs: maxTimeMs,
         maxTimeMs,
         status: 'queued',
         progress: 0,
         phase: 'queued',
         message: undefined,
         createdAt: Date.now(),
         updatedAt: Date.now(),
         startedAt: undefined,
         completedAt: undefined,
         failedAt: undefined,
         cancelledAt: undefined,
         classification: undefined,
         subQuestionCount: undefined,
         sourceCount: undefined,
         sourceTypeCount: undefined,
         findingCount: undefined,
         totalExtensionsMs: 0,
         extensionCount: 0,
         gapLoopCount: 0,
         abortController: undefined,
         runtimeTimeout: undefined,
         result: undefined,
         error: undefined,
         resultFile: undefined,
      };

      this.jobs.set(jobId, job);
      this.transitionRunning(job);

      logger.info({ jobId, depth: params.depth }, 'Research job created');
      return this.toSnapshot(job);
   }

   /**
    * Update a job's bounded state. Called from the orchestrator's progress callback.
    * No-op if the job no longer exists.
    */
   update(jobId: string, update: ResearchJobUpdate): void {
      const job = this.jobs.get(jobId);
      if (!job) return;

      // progress and phase are always present (not optional)
      job.progress = update.progress;
      job.phase = update.phase;
      if (update.message !== undefined) job.message = update.message;
      if (update.classification !== undefined) job.classification = update.classification;
      if (update.subQuestionCount !== undefined) job.subQuestionCount = update.subQuestionCount;
      if (update.sourceCount !== undefined) job.sourceCount = update.sourceCount;
      if (update.sourceTypeCount !== undefined) job.sourceTypeCount = update.sourceTypeCount;
      if (update.findingCount !== undefined) job.findingCount = update.findingCount;
      job.updatedAt = Date.now();
   }

   /**
    * Mark a job as complete with its final result.
    */
   complete(jobId: string, result: ResearchResult): void {
      const job = this.jobs.get(jobId);
      if (!job) return;

      job.status = 'complete';
      job.progress = 100;
      job.phase = 'complete';
      job.result = result;
      job.completedAt = Date.now();
      job.updatedAt = Date.now();
      // Populate source counts from completed result
      job.sourceCount = result.report.sourceCount;
      job.sourceTypeCount = result.report.sourceTypeCount;
      this.disarmJob(job);

      logger.info(
         { jobId, sources: result.report.sourceCount, findings: result.report.findingCount },
         'Research job complete',
      );
   }

   /**
    * Mark a job as failed with an error.
    */
   fail(jobId: string, error: Error): void {
      const job = this.jobs.get(jobId);
      if (!job) return;

      job.status = 'failed';
      job.progress = Math.max(job.progress, 0);
      job.error = error.message;
      job.failedAt = Date.now();
      job.updatedAt = Date.now();
      this.disarmJob(job);

      logger.error({ jobId, error: error.message }, 'Research job failed');
   }

   /**
    * Request cancellation of a running job. Transitions to 'cancelling' and
    * fires the AbortController. The orchestrator's .catch handler calls
    * markCancelled() when the abort is acknowledged.
    */
   cancel(jobId: string): ResearchJobSnapshot | null {
      const job = this.jobs.get(jobId);
      if (!job) return null;

      // Terminal states cannot be cancelled
      if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
         return this.toSnapshot(job);
      }

      if (job.status === 'cancelling') {
         return this.toSnapshot(job);
      }

      job.status = 'cancelling';
      job.updatedAt = Date.now();

      const ac = job.abortController;
      if (ac && !ac.signal.aborted) {
         ac.abort(new Error('Job cancelled by user'));
         logger.info({ jobId }, 'Research job cancel requested');
      }

      // If no abort controller (shouldn't happen), mark cancelled immediately
      if (!ac) {
         job.status = 'cancelled';
         job.cancelledAt = Date.now();
      }

      return this.toSnapshot(job);
   }

   /**
    * Mark a job as cancelled (called from orchestrator .catch on AbortError).
    */
   markCancelled(jobId: string): void {
      const job = this.jobs.get(jobId);
      if (!job) return;

      job.status = 'cancelled';
      job.cancelledAt = Date.now();
      job.updatedAt = Date.now();
      this.disarmJob(job);

      logger.info({ jobId }, 'Research job cancelled');
   }

   /**
    * Extend a running job's max runtime by additionalMs.
    *
    * Clears the existing timeout and sets a new one. Only works on running
    * jobs. Caps total extensions at 2× the original max time to prevent
    * unbounded growth. Each extension is at most 5 minutes.
    *
    * Returns true if the extension was applied, false otherwise.
    */
   extendRuntime(jobId: string, additionalMs: number): boolean {
      const job = this.jobs.get(jobId);
      if (!job) return false;
      if (job.status !== 'running') return false;

      // Safety caps
      const maxTotal = job.originalMaxTimeMs * 2;
      if (job.totalExtensionsMs + additionalMs > maxTotal) {
         additionalMs = Math.max(0, maxTotal - job.totalExtensionsMs);
      }
      if (additionalMs <= 0) return false;

      const perExtensionCap = 300_000; // 5 minutes per extension call
      if (additionalMs > perExtensionCap) {
         additionalMs = perExtensionCap;
      }

      // Apply extension
      job.totalExtensionsMs += additionalMs;
      job.extensionCount++;
      job.maxTimeMs = job.originalMaxTimeMs + job.totalExtensionsMs;

      // Clear old timeout, set new one
      if (job.runtimeTimeout) clearTimeout(job.runtimeTimeout);
      const remaining = job.maxTimeMs - (Date.now() - (job.startedAt ?? Date.now()));
      const effectiveTimeout = Math.max(remaining + additionalMs, 0);

      job.runtimeTimeout = setTimeout(() => {
         if (job.abortController && !job.abortController.signal.aborted) {
            logger.warn(
               { jobId, maxTimeMs: job.maxTimeMs, extensions: job.extensionCount },
               'Job max runtime exceeded (after extensions)',
            );
            job.abortController.abort(new Error('Research exceeded max runtime'));
         }
      }, effectiveTimeout);
      job.runtimeTimeout.unref();

      job.updatedAt = Date.now();
      logger.info(
         { jobId, additionalMs, totalExtensionsMs: job.totalExtensionsMs, extensionCount: job.extensionCount },
         'Research job runtime extended',
      );
      return true;
   }

   /** Increment the gap loop counter for a job (observability only). */
   incrementGapLoops(jobId: string): void {
      const job = this.jobs.get(jobId);
      if (!job) return;
      job.gapLoopCount++;
      job.updatedAt = Date.now();
   }

   /**
    * Get an AbortSignal for a running job. Used to propagate cancellation
    * through long-running operations.
    */
   getAbortSignal(jobId: string): AbortSignal | undefined {
      return this.jobs.get(jobId)?.abortController?.signal;
   }

   /**
    * Get a snapshot of a job's current state. Returns null if the job
    * doesn't exist or has expired.
    */
   poll(jobId: string): ResearchJobSnapshot | null {
      const job = this.jobs.get(jobId);
      if (!job || job.status === 'expired') return null;
      return this.toSnapshot(job);
   }

   /**
    * List all non-expired jobs as lightweight summaries, newest first.
    */
   list(): ResearchJobSummary[] {
      const result: ResearchJobSummary[] = [];
      for (const job of this.jobs.values()) {
         if (job.status === 'expired') continue;
         result.push(this.toSummary(job));
      }
      result.sort((a, b) => b.createdAt - a.createdAt);
      return result;
   }

   /**
    * Shut down the job manager: cancel all active jobs, clear timers.
    */
   shutdown(): void {
      clearInterval(this.cleanupTimer);

      for (const job of this.jobs.values()) {
         if (job.abortController && !job.abortController.signal.aborted) {
            job.abortController.abort(new Error('Server shutting down'));
         }
         this.disarmJob(job);
      }
      this.jobs.clear();

      logger.info('Research job manager shut down');
   }

   /**
    * Get count of active (running + cancelling) jobs.
    */
   /**
    * Get the full result for a completed job. Returns undefined if the job
    * doesn't exist, hasn't completed, or has expired.
    */
   getResult(jobId: string): ResearchResult | undefined {
      return this.jobs.get(jobId)?.result;
   }

   /**
    * Get the result file path for a job, if previously saved.
    */
   getResultFile(jobId: string): string | undefined {
      return this.jobs.get(jobId)?.resultFile;
   }

   /**
    * Record the result file path after a save operation.
    */
   setResultFile(jobId: string, filePath: string): void {
      const job = this.jobs.get(jobId);
      if (!job) return;
      job.resultFile = filePath;
      job.updatedAt = Date.now();
   }

   activeCount(): number {
      return this.countActive();
   }

   // ── Internal ────────────────────────────────────────────────────────────────

   private generateId(): string {
      return `dr_${Date.now().toString(36)}_${(this.nextId++).toString(36)}`;
   }

   private resolveDefaultMaxTimeMs(depth: ResearchDepth): number {
      // Aligned with budget profile defaults
      switch (depth) {
         case 'quick':
            return 60_000;
         case 'standard':
            return 180_000;
         case 'deep':
            return 300_000;
         case 'exhaustive':
            return 600_000;
         case 'tree':
            return 300_000;
         default:
            return 180_000;
      }
   }

   private transitionRunning(job: InternalJob): void {
      job.status = 'running';
      job.phase = 'running';
      job.startedAt = Date.now();
      job.updatedAt = Date.now();

      const abortController = new AbortController();
      job.abortController = abortController;

      // Set max runtime timeout
      job.runtimeTimeout = setTimeout(() => {
         if (job.abortController && !job.abortController.signal.aborted) {
            logger.warn({ jobId: job.jobId, maxTimeMs: job.maxTimeMs }, 'Job max runtime exceeded');
            job.abortController.abort(new Error('Research exceeded max runtime'));
         }
      }, job.maxTimeMs);
      job.runtimeTimeout.unref();
   }

   private countActive(): number {
      let count = 0;
      for (const job of this.jobs.values()) {
         if (job.status === 'running' || job.status === 'cancelling') count++;
      }
      return count;
   }

   private disarmJob(job: InternalJob): void {
      // No separate runtime timer to clear — it's handled by the
      // AbortController's timeout. Just null references for GC.
      job.abortController = undefined;
   }

   private runCleanup(): void {
      const now = Date.now();

      for (const [id, job] of this.jobs) {
         if (job.status === 'expired') continue;

         const terminalTime = job.completedAt ?? job.failedAt ?? job.cancelledAt;

         if (terminalTime !== undefined && now - terminalTime > this.ttlMs) {
            job.status = 'expired';
            job.updatedAt = now;
            logger.debug({ jobId: id }, 'Research job expired');
            continue;
         }

         // Defensive: expire stale running/cancelling jobs (shouldn't happen)
         if (
            (job.status === 'running' || job.status === 'cancelling') &&
            job.startedAt !== undefined &&
            now - job.startedAt > Math.max(this.ttlMs, job.maxTimeMs * 2)
         ) {
            logger.warn({ jobId: id, status: job.status }, 'Stale research job force-expired');
            job.status = 'expired';
            job.updatedAt = now;
            if (job.abortController && !job.abortController.signal.aborted) {
               job.abortController.abort(new Error('Job expired'));
            }
            continue;
         }
      }
   }

   private toSnapshot(job: InternalJob): ResearchJobSnapshot {
      return {
         jobId: job.jobId,
         query: job.query,
         depth: job.depth,
         status: job.status,
         progress: job.progress,
         phase: job.phase,
         message: job.message,
         createdAt: job.createdAt,
         updatedAt: job.updatedAt,
         startedAt: job.startedAt,
         completedAt: job.completedAt,
         failedAt: job.failedAt,
         cancelledAt: job.cancelledAt,
         classification: job.classification,
         subQuestionCount: job.subQuestionCount,
         sourceCount: job.sourceCount,
         sourceTypeCount: job.sourceTypeCount,
         findingCount: job.findingCount,
         result: job.result,
         error: job.error,
         resultFile: job.resultFile,
         originalMaxTimeMs: job.originalMaxTimeMs,
         maxTimeMs: job.maxTimeMs,
         totalExtensionsMs: job.totalExtensionsMs,
         extensionCount: job.extensionCount,
         gapLoopCount: job.gapLoopCount,
      };
   }

   private toSummary(job: InternalJob): ResearchJobSummary {
      return {
         jobId: job.jobId,
         query:
            job.query.length > QUERY_TRUNCATE_LENGTH
               ? job.query.slice(0, QUERY_TRUNCATE_LENGTH - 3) + '...'
               : job.query,
         status: job.status,
         progress: job.progress,
         phase: job.phase,
         createdAt: job.createdAt,
         updatedAt: job.updatedAt,
      };
   }
}

// ── Singleton ───────────────────────────────────────────────────────────────────

export const researchJobManager = new ResearchJobManager();
