/**
 * graph_ingest — Ingest content into the knowledge graph.
 *
 * Supports text content and URL fetching. Calls KnowledgeGraphExtractor to
 * extract entities/relationships, emits events, and triggers async projection.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { KnowledgeGraphExtractor } from '../knowledge/extractor/index.js';
import { createRun, updateRunStatus, getRun } from '../knowledge/store/runs.js';
import { appendEvents } from '../knowledge/store/events.js';
import { getKgDb } from '../knowledge/store/db.js';
import { triggerProjectionRebuildOnRunComplete } from '../knowledge/store/projection-scheduler.js';
import type { NormalizedExtractionInput } from '../knowledge/extractor/normalise.js';

const graphIngestSchema = z.object({
  content: z.object({
    type: z.enum(['text', 'url']).describe('Source type'),
    value: z.string().min(1).max(1_000_000).describe('Text content or URL'),
  }),
  topic: z.string().max(500).optional().describe('Optional topic for the run'),
  family_hint: z.string().max(200).optional().describe('Suggested family label'),
  sync: z.boolean().optional().default(true).describe('When false, return immediately'),
  timeout_ms: z.number().int().min(1_000).max(300_000).optional().default(30_000).describe('Max extraction time (ms)'),
  idempotency_key: z.string().max(200).optional().describe('Prevent duplicate runs'),
});

/** Emit all events from an extraction result. */
function emitEventsFromResult(
  result: Awaited<ReturnType<KnowledgeGraphExtractor['extract']>>,
  runId: string,
): void {
  const all = [
    ...result.claimEvents, ...result.nodeEvents,
    ...result.edgeEvents, ...result.sourceEvents,
    ...result.failureEvents,
  ];
  if (all.length > 0) appendEvents(all);
  updateRunStatus(runId, 'completed', {
    entityCount: result.entities.length,
    edgeCount: result.edges.length,
  });
  triggerProjectionRebuildOnRunComplete(runId);
}

function buildNormInput(
  content: { type: 'text' | 'url'; value: string },
  topic: string | undefined,
  timeoutMs: number,
): Promise<NormalizedExtractionInput> {
  if (content.type === 'text') {
    return Promise.resolve({
      text: content.value,
      url: undefined,
      title: topic,
      sourceKind: 'unknown' as const,
      retrievedAt: new Date().toISOString(),
    });
  }
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const resp = await fetch(content.value, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`);
      return {
        text: await resp.text(),
        url: content.value,
        title: topic,
        sourceKind: 'documentation' as const,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      throw err;
    }
  })();
}

export function registerGraphIngestTool(server: McpServer, cfg: SearchConfig): void {
  server.registerTool(
    'graph_ingest',
    {
      description:
        'Ingest text or URL content into the knowledge graph. ' +
        'Extracts entities and relationships via LLM pipeline. ' +
        'When sync=false, returns a run_id immediately; poll graph_status for progress.',
      inputSchema: graphIngestSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const { content, topic, sync, timeout_ms: timeoutMs, idempotency_key: idKey, family_hint: familyHint } = args;

        // Idempotency check
        const db = getKgDb();
        let runId: string;
        if (idKey !== undefined && db !== null) {
          const row = db.prepare('SELECT run_id FROM kg_runs WHERE idempotency_key = ?').get(idKey) as
            | { run_id: string }
            | undefined;
          if (row !== undefined) {
            runId = row.run_id;
            // Verify the existing run is not in a terminal/non-reusable state
            const existingRun = getRun(runId);
            if (existingRun !== null && (existingRun.status === 'extracting' || existingRun.status === 'classifying' || existingRun.status === 'projecting' || existingRun.status === 'queued')) {
              // Still in progress — return existing run status
              return successResponse(
                makeResult(
                  'graph_ingest',
                  { status: existingRun.status, run_id: runId },
                  Date.now() - start,
                ),
              );
            } else if (existingRun !== null && (existingRun.status === 'completed' || existingRun.status === 'failed')) {
              // Already completed or failed — return early
              return successResponse(
                makeResult(
                  'graph_ingest',
                  { status: existingRun.status === 'completed' ? 'completed' as const : 'failed' as const, run_id: runId },
                  Date.now() - start,
                ),
              );
            }
          } else {
            const run = createRun({ topic: topic ?? familyHint ?? null, query: content.value.slice(0, 500) });
            if (run === null) return errorResponse(new Error('DB not ready'));
            runId = run.runId;
            db.prepare('UPDATE kg_runs SET idempotency_key = ? WHERE run_id = ?').run(idKey, runId);
          }
        } else {
          const run = createRun({ topic: topic ?? familyHint ?? null, query: content.value.slice(0, 500) });
          if (run === null) return errorResponse(new Error('DB not ready'));
          runId = run.runId;
        }

        updateRunStatus(runId, 'extracting');
        let normInput: NormalizedExtractionInput;
        try {
          normInput = await buildNormInput(content, topic, timeoutMs);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          updateRunStatus(runId, 'failed', { lastError: msg });
          return errorResponse(new Error(msg));
        }

        if (!sync) {
          updateRunStatus(runId, 'classifying');
          const extractor = new KnowledgeGraphExtractor(cfg);
          void extractor.extract(normInput, runId).then(
            (result) => { emitEventsFromResult(result, runId); },
            (err: unknown) => { updateRunStatus(runId, 'failed', {
              lastError: err instanceof Error ? err.message : String(err),
            }); },
          );
          return successResponse(
            makeResult('graph_ingest', { status: 'processing' as const, run_id: runId }, Date.now() - start),
          );
        }

        // Sync path
        updateRunStatus(runId, 'classifying');
        const extractor = new KnowledgeGraphExtractor(cfg);
        let extraction: Awaited<ReturnType<KnowledgeGraphExtractor['extract']>>;
        try {
          extraction = await extractor.extract(normInput, runId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          updateRunStatus(runId, 'failed', { lastError: msg });
          return errorResponse(new Error(`Extraction failed: ${msg}`));
        }

        emitEventsFromResult(extraction, runId);

        return successResponse(
          makeResult(
            'graph_ingest',
            {
              status: 'completed' as const,
              run_id: runId,
              entity_count: extraction.entities.length,
              edge_count: extraction.edges.length,
              assignments: extraction.entities.map((e) => ({
                entity_id: e.local_id,
                label: e.label,
                type: e.type,
                family_id: null as string | null,
              })),
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'graph_ingest' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered graph_ingest tool');
}
