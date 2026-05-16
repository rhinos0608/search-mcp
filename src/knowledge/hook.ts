/**
 * V7.0.0 — KnowledgeGraphHook: integration layer between tool lifecycle and KG.
 *
 * - onDeepResearchComplete: extracts entities from synthesis output, runs pass-1
 *   classifier, commits events, triggers async projection rebuild.
 * - onToolCall: passive capture for family tools in the allowlist.
 * - flushSession: drains pending extractions for a session.
 * - recover: startup recovery — marks stuck runs failed, flushes stale extractions.
 *
 * Hook failures MUST NEVER fail the original tool call — always catch and log.
 */

import { logger } from '../logger.js';
import type { SearchConfig } from '../config.js';
import type { ResearchResult } from '../research/types.js';
import type { StructuredWarning } from './types.js';
import { KnowledgeGraphExtractor } from './extractor/index.js';
import type { ExtractionResult } from './extractor/index.js';
import { runPass1Classifier, type RunEntity, type RunMetadata } from './families/classifier.js';
import { normalizeToolResult } from './extractor/normalise.js';
import { appendPendingExtraction, flushSessionExtractions, getStaleExtractions, type StaleExtractionGroup } from './store/pending.js';
import { createRun, updateRunStatus } from './store/runs.js';
import { setRunActiveFlag, clearRunActiveFlag, markStuckRunsFailed } from './store/run-active.js';
import { appendEvents } from './store/events.js';
import { triggerProjectionRebuildOnRunComplete } from './store/projection-scheduler.js';
import { scrubContent } from '../utils/contentScrubber.js';

// ────────────────────────────────────────────────────────────────────
// Passive capture allowlist
// ────────────────────────────────────────────────────────────────────

const PASSIVE_CAPTURE_ALLOWLIST = new Set([
  'web_search',
  'web_read',
  'web_crawl',
  'semantic_crawl',
  'reddit.search',
  'reddit.comments',
  'reddit.semantic',
  'youtube.search',
  'youtube.transcript',
  'youtube.semantic',
  'github.repo',
  'github.file',
  'github.tree',
  'github.search',
  'github.code_search',
  'github.trending',
  'research.academic',
  'research.arxiv',
  'research.hackernews',
  'research.stackoverflow',
  'packages.npm',
  'packages.pypi',
]);

const NOT_CAPTURED_PREFIXES = ['graph_', 'family_', 'run_', 'entity_', 'deep_research', 'knowledge_graph'];

function isToolCaptured(toolName: string): boolean {
  for (const prefix of NOT_CAPTURED_PREFIXES) {
    if (toolName.startsWith(prefix)) return false;
  }
  return PASSIVE_CAPTURE_ALLOWLIST.has(toolName);
}

// ────────────────────────────────────────────────────────────────────
// onDeepResearchComplete result metadata
// ────────────────────────────────────────────────────────────────────

export interface DeepResearchKgMeta {
  runId: string;
  entityCount: number;
  edgeCount: number;
  familyAssignments: { label: string; familyId: string | null }[];
  warnings: StructuredWarning[];
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function buildWarning(code: StructuredWarning['code'], message: string, source?: string): StructuredWarning {
  return {
    code,
    severity: 'warn' as const,
    message,
    source: source ?? undefined,
  } as StructuredWarning;
}

// ────────────────────────────────────────────────────────────────────
// KnowledgeGraphHook
// ────────────────────────────────────────────────────────────────────

export class KnowledgeGraphHook {
  private config: SearchConfig;
  private activeRunId: string | null = null;
  private _sessionId: string | null = null;

  constructor(config: SearchConfig) {
    this.config = config;
  }

  // ── Active run tracking ────────────────────────────────────────────

  setActiveRun(runId: string | null): void {
    if (this.activeRunId !== null && this.activeRunId !== runId) {
      clearRunActiveFlag(this.activeRunId);
    }
    this.activeRunId = runId;
    if (runId !== null) {
      setRunActiveFlag(runId);
    }
  }

  /** Returns a stable session ID for the lifetime of this hook instance. */
  getSessionId(): string {
    this._sessionId ??= `stdio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this._sessionId;
  }

  /**
   * Override the auto-generated session ID with an external ID.
   * Must be called before the first passive capture in HTTP mode
   * so that pending extractions are written under the HTTP session UUID
   * and flushSession() can find them.
   */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  // ── Deep research completion ──────────────────────────────────────

  async onDeepResearchComplete(
    jobId: string,
    result: ResearchResult,
  ): Promise<DeepResearchKgMeta> {
    const meta: DeepResearchKgMeta = {
      runId: '',
      entityCount: 0,
      edgeCount: 0,
      familyAssignments: [],
      warnings: [],
    };

    try {
      // 1. Create run
      const run = createRun({
        topic: result.report.classification,
        query: result.report.query,
      });
      if (run === null) {
        meta.warnings.push(buildWarning('EXTRACTION_PARTIAL', 'kg: failed to create run', jobId));
        return meta;
      }
      meta.runId = run.runId;

      // 2. Emit RUN_STARTED event
      appendEvents([
        {
          timestamp: new Date().toISOString(),
          eventType: 'RUN_STARTED',
          eventVersion: 1,
          runId: run.runId,
          batchId: null,
          actor: 'system',
          entityId: run.runId,
          entityType: 'run',
          payload: JSON.stringify({
            topic: result.report.classification,
            query: result.report.query,
            session_mode: false,
          }),
          payloadHash: null,
        },
      ]);

      // 3. Build extraction input from synthesis output
      const synthesisText = result.report.narrativeMarkdown;
      if (!synthesisText || synthesisText.trim().length === 0) {
        meta.warnings.push(
          buildWarning('EXTRACTION_PARTIAL', 'kg: no synthesis text for extraction', jobId),
        );
        updateRunStatus(run.runId, 'failed', { lastError: 'No synthesis text' });
        appendEvents([{ timestamp: new Date().toISOString(), eventType: 'RUN_FAILED', eventVersion: 1, runId: run.runId, batchId: null, actor: 'system', entityId: run.runId, entityType: 'run', payload: JSON.stringify({ lastError: 'No synthesis text' }), payloadHash: null }]);
        return meta;
      }

      const extractionInput = {
        text: synthesisText,
        url: undefined,
        title: result.report.query,
        sourceKind: 'research_paper' as const,
        retrievedAt: new Date().toISOString(),
      };

      // 4. Run extractor
      const extractor = new KnowledgeGraphExtractor(this.config);
      const extractionResult: ExtractionResult = await extractor.extract(
        extractionInput,
        run.runId,
      );

      meta.entityCount = extractionResult.entities.length;
      meta.edgeCount = extractionResult.edges.length;

      if (extractionResult.failureEvents.length > 0) {
        meta.warnings.push(
          buildWarning('EXTRACTION_PARTIAL', 'kg: extraction had failures', jobId),
        );
      }

      // 5. Run family classifier pass 1
      if (extractionResult.entities.length > 0) {
        try {
          const runEntities: RunEntity[] = extractionResult.entities.map((e) => ({
            id: e.local_id,
            label: e.label,
            type: e.type,
          }));

          const runMetadata: RunMetadata = {
            query: result.report.query,
            topic: result.report.classification,
            description: `Deep research: ${result.report.query}`,
          };

          const classifierResult = await runPass1Classifier(
            runEntities,
            runMetadata,
            run.runId,
            this.config.knowledgeGraph,
          );

          meta.familyAssignments = classifierResult.assignments.map((a) => {
            const entity = extractionResult.entities.find((e) => e.local_id === a.entityId);
            return {
              label: entity?.label ?? a.entityId,
              familyId: a.familyId,
            };
          });
        } catch (classifyErr) {
          logger.warn({ err: classifyErr, runId: run.runId }, 'kg: pass-1 classifier failed (non-fatal)');
          meta.warnings.push(
            buildWarning('FAMILY_PENDING', 'kg: pass-1 classifier failed', jobId),
          );
        }
      }

      // 6. Update run status to completed; emit RUN_COMPLETED
      updateRunStatus(run.runId, 'completed', {
        entityCount: meta.entityCount,
        edgeCount: meta.edgeCount,
      });

      appendEvents([
        {
          timestamp: new Date().toISOString(),
          eventType: 'RUN_COMPLETED',
          eventVersion: 1,
          runId: run.runId,
          batchId: null,
          actor: 'system',
          entityId: run.runId,
          entityType: 'run',
          payload: JSON.stringify({
            entity_count: meta.entityCount,
            edge_count: meta.edgeCount,
          }),
          payloadHash: null,
        },
      ]);

      // 7. Trigger projection rebuild (async, fire-and-forget)
      triggerProjectionRebuildOnRunComplete(run.runId);

      // 8. Clear active run flag
      this.setActiveRun(null);

      logger.info(
        { jobId, runId: run.runId, entityCount: meta.entityCount, edgeCount: meta.edgeCount },
        'kg: deep research extraction complete',
      );
    } catch (err) {
      logger.warn({ err, jobId }, 'kg: deep research extraction failed (non-fatal)');
      meta.warnings.push(buildWarning('EXTRACTION_PARTIAL', 'kg: deep research extraction failed', jobId));

      // Mark run failed
      if (meta.runId) {
        try {
          updateRunStatus(meta.runId, 'failed', { lastError: String(err) });
        } catch { /* ignore */ }
      }
    }

    return meta;
  }

  // ── Passive tool call capture ─────────────────────────────────────

  /**
   * Called on every allowed tool call during a session.
   * Hook failures MUST NEVER fail the original tool call — always catch and log.
   */
  async onToolCall(toolName: string, result: unknown): Promise<void> {
    // 1. Check if tool is in the passive capture allowlist
    if (!isToolCaptured(toolName)) return;
    if (result === null || result === undefined) return;

    try {
      // 2. Normalize the result
      const normalized = normalizeToolResult(toolName, result);
      if (normalized === null) return;

      // 3. Content scrubber pass (if enabled)
      if (this.config.scrubContent) {
        const scrubResult = scrubContent(normalized.text);
        if (!scrubResult.clean) {
          logger.debug({ toolName, threats: scrubResult.threats.length }, 'kg: content scrubbed; skipping extraction');
          return;
        }
      }

      // 4. Build content hash for dedup
      const contentHash = simpleHash(normalized.text);

      // 5. Route: active run vs pending
      if (this.activeRunId !== null) {
        // Attach to active run
        const base = {
          sessionId: this.activeRunId,
          toolName,
          content: normalized.text,
          contentHash,
        };
        appendPendingExtraction(
          typeof normalized.url === 'string'
            ? { ...base, sourceUrl: normalized.url }
            : base,
        );
      } else {
        // Write to pending extractions (no active run)
        const sessionId = this.getSessionId();
        const base = {
          sessionId,
          toolName,
          content: normalized.text,
          contentHash,
        };
        appendPendingExtraction(
          typeof normalized.url === 'string'
            ? { ...base, sourceUrl: normalized.url }
            : base,
        );

    }
    } catch (err) {
      // NEVER fail the tool call
      logger.warn({ err, toolName }, 'kg: passive capture failed (non-fatal)');
    }
  }

  // ── Flush pending extractions ─────────────────────────────────────

  async flushSession(sessionId: string): Promise<void> {
    try {
      const result = flushSessionExtractions(sessionId);
      if (result !== null) {
        logger.info({ sessionId, runId: result.runId, count: result.extractionCount }, 'kg: session flushed');
        triggerProjectionRebuildOnRunComplete(result.runId);
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'kg: flushSession failed (non-fatal)');
    }
  }

  // ── Startup recovery ──────────────────────────────────────────────

  async recover(): Promise<void> {
    try {
      // 1. Mark stuck runs as failed
      const stuckCount = markStuckRunsFailed();
      if (stuckCount > 0) {
        logger.info({ stuckCount }, 'kg: recovery marked stuck runs as failed');
      }

      // 2. Flush stale pending extractions
      const maxIdleMs = this.config.knowledgeGraph.session.maxIdleMs;
      const staleGroups: StaleExtractionGroup[] = getStaleExtractions(maxIdleMs);

      for (const group of staleGroups) {
        try {
          const result = flushSessionExtractions(group.sessionId);
          if (result !== null) {
            logger.info(
              { sessionId: group.sessionId, runId: result.runId, count: result.extractionCount },
              'kg: recovery flushed stale extractions',
            );
            triggerProjectionRebuildOnRunComplete(result.runId);
          }
        } catch (flushErr) {
          logger.warn({ err: flushErr, sessionId: group.sessionId }, 'kg: recovery flush failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'kg: startup recovery failed (non-fatal)');
    }
  }
}

// ── Simple content hash (fast non-cryptographic 32-bit hash) ──────────

/**
 * Fast non-cryptographic 32-bit hash, returns up to 8 hex chars for deduplication.
 * Based on DJB2 string hashing. We don't need cryptographic guarantees for dedup.
 *
 * Samples three regions of the content (beginning, middle, end) to avoid
 * false-positive dedup matches when pages share boilerplate headers/footers
 * (nav, cookie banners, metadata) but have different body content.
 */
function simpleHash(content: string): string {
  const len = content.length;
  if (len === 0) return '0';

  let hash = 0;
  const sample = (start: number, count: number): void => {
    const end = Math.min(start + count, len);
    for (let i = start; i < end; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
  };

  // Sample up to 500 chars from each of beginning, middle, and end
  const window = 500;
  sample(0, window); // beginning
  if (len > window * 2) {
    sample(Math.floor(len / 2) - Math.floor(window / 2), window); // middle
  }
  if (len > window) {
    sample(len - window, window); // end
  }

  return Math.abs(hash).toString(16);
}
