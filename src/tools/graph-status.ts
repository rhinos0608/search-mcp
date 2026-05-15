/**
 * graph_status — Health, run state, projection age, and storage metrics.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { getKgDb, getKgDbPath } from '../knowledge/store/db.js';
import { countEvents } from '../knowledge/store/events.js';
import { getLatestCompatibleCheckpoint } from '../knowledge/store/checkpoints.js';

const graphStatusSchema = z.object({}).describe('No input parameters');

export function registerGraphStatusTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'graph_status',
    {
      description:
        'Knowledge graph health and status. Returns event count, projection age, ' +
        'storage size, node/edge/family counts, and active/failed run stats.',
      inputSchema: graphStatusSchema,
    },
    async () => {
      const start = Date.now();
      try {
        const eventCount = countEvents();
        const db = getKgDb();

        // Projection age
        const checkpoint = getLatestCompatibleCheckpoint(1);
        const lastProjectionBuilt = checkpoint?.createdAt ?? null;
        const projectionAgeMs =
          lastProjectionBuilt !== null ? Date.now() - new Date(lastProjectionBuilt).getTime() : 0;
        const projectionVersion = checkpoint?.projectionVersion ?? 0;

        // Storage bytes
        let storageBytes = 0;
        const dbPath = getKgDbPath();
        if (dbPath !== null) {
          try {
            const { readFileSync } = await import('node:fs');
            const st = readFileSync(dbPath);
            storageBytes = st.length;
          } catch {
            storageBytes = 0;
          }
        }

        // Family/node/edge counts
        let families = 0;
        let nodes = 0;
        let edges = 0;
        if (db !== null) {
          try {
            families =
              ((db.prepare('SELECT COUNT(*) as cnt FROM kg_families').get() as { cnt: number } | undefined)?.cnt ?? 0);
            nodes =
              ((db.prepare('SELECT COUNT(*) as cnt FROM kg_nodes').get() as { cnt: number } | undefined)?.cnt ?? 0);
            edges =
              ((db.prepare('SELECT COUNT(*) as cnt FROM kg_edges').get() as { cnt: number } | undefined)?.cnt ?? 0);
          } catch {
            // projection tables may be empty
          }
        }

        // Active & failed runs
        let activeRuns = 0;
        let failedRuns = 0;
        let lastRunError: string | null = null;
        if (db !== null) {
          try {
            const activeRow = db
              .prepare("SELECT COUNT(*) as cnt FROM kg_runs WHERE status IN ('extracting','classifying','projecting')")
              .get() as { cnt: number } | undefined;
            activeRuns = activeRow?.cnt ?? 0;

            const failedRow = db
              .prepare("SELECT COUNT(*) as cnt FROM kg_runs WHERE status = 'failed'")
              .get() as { cnt: number } | undefined;
            failedRuns = failedRow?.cnt ?? 0;

            const lastErrRow = db
              .prepare("SELECT last_error FROM kg_runs WHERE status = 'failed' AND last_error IS NOT NULL ORDER BY failed_at DESC LIMIT 1")
              .get() as { last_error: string } | undefined;
            lastRunError = lastErrRow?.last_error ?? null;
          } catch {
            // table may be empty
          }
        }

        // Pending counts from working-state tables
        let pendingFamilyCount = 0;
        let pendingAssignmentCount = 0;
        let pendingExtractionCount = 0;
        let oldestPendingExtraction: string | null = null;
        let lastConsolidationAt: string | null = null;
        if (db !== null) {
          try {
            const pfRow = db.prepare('SELECT COUNT(*) as cnt FROM kg_pending_families').get() as { cnt: number } | undefined;
            pendingFamilyCount = pfRow?.cnt ?? 0;

            const paRow = db.prepare('SELECT COUNT(*) as cnt FROM kg_pending_assignments').get() as { cnt: number } | undefined;
            pendingAssignmentCount = paRow?.cnt ?? 0;

            const peRow = db.prepare("SELECT COUNT(*) as cnt FROM kg_pending_extractions WHERE run_id IS NULL").get() as { cnt: number } | undefined;
            pendingExtractionCount = peRow?.cnt ?? 0;

            const oeRow = db.prepare('SELECT queued_at FROM kg_pending_extractions WHERE run_id IS NULL ORDER BY queued_at ASC LIMIT 1').get() as { queued_at: string } | undefined;
            oldestPendingExtraction = oeRow?.queued_at ?? null;

            const lcRow = db.prepare('SELECT MAX(created_at) as latest FROM kg_projection_checkpoints WHERE compatible = 1').get() as { latest: string } | undefined;
            lastConsolidationAt = lcRow?.latest ?? null;
          } catch {
            // tables or queries may be unavailable
          }
        }

        return successResponse(
          makeResult(
            'graph_status',
            {
              event_count: eventCount,
              last_projection_built: lastProjectionBuilt,
              projection_age_ms: projectionAgeMs,
              projection_version: projectionVersion,
              pending_family_count: pendingFamilyCount,
              pending_assignment_count: pendingAssignmentCount,
              pending_extraction_count: pendingExtractionCount,
              oldest_pending_extraction: oldestPendingExtraction,
              storage_bytes: storageBytes,
              families,
              nodes,
              edges,
              active_runs: activeRuns,
              failed_runs: failedRuns,
              last_run_error: lastRunError,
              last_consolidation_at: lastConsolidationAt,
              write_queue_depth: 0, // TODO: track write queue depth if queuing is implemented
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'graph_status' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered graph_status tool');
}
