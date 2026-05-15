/**
 * run_list — Filterable, paginated list of research runs.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { listRuns } from '../knowledge/store/runs.js';
import { getKgDb } from '../knowledge/store/db.js';

const runListSchema = z.object({
  family_id: z.string().optional().describe('Filter runs contributing to this family'),
  topic: z.string().optional().describe('Filter by topic (substring match)'),
  status: z.string().optional().describe('Filter by run status (queued, extracting, etc.)'),
  after: z.string().optional().describe('ISO-8601; runs started after this timestamp'),
  before: z.string().optional().describe('ISO-8601; runs started before this timestamp'),
  limit: z.number().int().min(1).max(200).optional().default(20).describe('Max runs (default 20)'),
  cursor: z.string().optional().describe('Pagination cursor (started_at|run_id)'),
});

export function registerRunListTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'run_list',
    {
      description:
        'List knowledge graph runs with optional filters (family, topic, status, temporal range) and cursor-based pagination.',
      inputSchema: runListSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const listOpts: Record<string, unknown> = {};
        if (args.family_id !== undefined) listOpts.familyId = args.family_id;
        if (args.topic !== undefined) listOpts.topic = args.topic;
        if (args.status !== undefined) {
          listOpts.status = args.status;
        } else {
          // Exclude rolled_back runs by default (they're audit trail, not content)
          listOpts.excludeStatuses = ['rolled_back'];
        }
        if (args.after !== undefined) listOpts.after = args.after;
        if (args.before !== undefined) listOpts.before = args.before;
        listOpts.limit = args.limit;
        if (args.cursor !== undefined) listOpts.cursor = args.cursor;
        const result = listRuns(listOpts);

        const db = getKgDb();

        // Batch-resolve family_ids for all runs to avoid N+1 queries
        const familyIdsByRun = new Map<string, string[]>();
        if (db !== null && result.runs.length > 0) {
          try {
            const runIds = result.runs.map((r) => r.runId);
            const placeholders = runIds.map(() => '?').join(',');
            const rows = db
              .prepare(
                `SELECT DISTINCT run_id, family_id FROM kg_node_families WHERE run_id IN (${placeholders})`,
              )
              .all(...runIds) as { run_id: string; family_id: string }[];
            for (const row of rows) {
              const list = familyIdsByRun.get(row.run_id) ?? [];
              list.push(row.family_id);
              familyIdsByRun.set(row.run_id, list);
            }
          } catch {
            // query failed — fall back to empty arrays
          }
        }

        const runs = result.runs.map((r) => {
          const familyIds = familyIdsByRun.get(r.runId) ?? [];

          return {
            run_id: r.runId,
            topic: r.topic ?? '',
            status: r.status,
            started_at: r.startedAt,
            completed_at: r.completedAt,
            entity_count: r.entityCount ?? 0,
            edge_count: r.edgeCount ?? 0,
            family_ids: familyIds,
            session_mode: r.sessionMode === 1,
          };
        });

        return successResponse(
          makeResult(
            'run_list',
            {
              runs,
              next_cursor: result.nextCursor,
              total: result.total,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'run_list' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered run_list tool');
}
