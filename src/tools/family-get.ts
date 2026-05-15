/**
 * family_get — Full family detail: entities, runs, relations, merge candidates.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { getFamily } from '../knowledge/store/projections.js';
import { getKgDb } from '../knowledge/store/db.js';

const familyGetSchema = z.object({
  family_id: z.string().min(1).describe('Family ID to retrieve'),
  include_entities: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include entities belonging to this family'),
  include_runs: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include runs associated with this family'),
});

export function registerFamilyGetTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'family_get',
    {
      description:
        'Retrieve full family detail including description, created_at, last_activity, run_count, ' +
        'related families, merge candidates, and optionally entities and runs.',
      inputSchema: familyGetSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const family = getFamily(args.family_id);
        if (family === null) {
          return errorResponse(new Error(`Family "${args.family_id}" not found`));
        }

        const db = getKgDb();

        // Parse related_families JSON
        let relatedFamilies: {
          relation_id: string;
          family_id: string;
          label: string;
          relation_type: string;
        }[] = [];
        if (family.relatedFamilies !== null && family.relatedFamilies !== '') {
          try {
            const parsed = JSON.parse(family.relatedFamilies) as unknown;
            if (Array.isArray(parsed)) {
              relatedFamilies = (parsed as Record<string, unknown>[]).map((rf: Record<string, unknown>) => ({
                relation_id: (rf.relation_id as string | undefined) ?? '',
                family_id: (rf.family_id as string | undefined) ?? '',
                label: (rf.label as string | undefined) ?? (rf.family_id as string | undefined) ?? '',
                relation_type: (rf.relation_type as string | undefined) ?? '',
              }));
            }
          } catch {
            // malformed JSON
          }
        }

        // Merge candidates
        let mergeCandidates: { family_id: string; label: string; confidence: number }[] = [];
        if (db !== null) {
          try {
            const mergeRows = db
              .prepare(
                'SELECT family_b, confidence FROM kg_family_merge_candidates WHERE family_a = ?',
              )
              .all(args.family_id) as { family_b: string; confidence: number | null }[];
            mergeCandidates = mergeRows.map((r) => ({
              family_id: r.family_b,
              label: r.family_b,
              confidence: r.confidence ?? 0,
            }));
          } catch {
            // query failed
          }
        }

        // Entities
        let entities: { id: string; label: string; type: string; confidence: number }[] | undefined;
        if (args.include_entities && db !== null) {
          try {
            const rows = db
              .prepare(
                `SELECT n.id, n.label, n.type, n.extraction_confidence
                 FROM kg_nodes n
                 JOIN kg_node_families nf ON n.id = nf.node_id
                 WHERE nf.family_id = ?
                 ORDER BY n.label ASC`,
              )
              .all(args.family_id) as {
              id: string;
              label: string;
              type: string;
              extraction_confidence: number | null;
            }[];
            entities = rows.map((r) => ({
              id: r.id,
              label: r.label,
              type: r.type,
              confidence: r.extraction_confidence ?? 0,
            }));
          } catch {
            entities = [];
          }
        }

        // Runs
        let runs: { run_id: string; topic: string; started_at: string; status: string }[] | undefined;
        if (args.include_runs && db !== null) {
          try {
            const rows = db
              .prepare(
                `SELECT DISTINCT r.run_id, r.topic, r.started_at, r.status
                 FROM kg_runs r
                 JOIN kg_node_families nf ON r.run_id = nf.run_id
                 WHERE nf.family_id = ?
                 ORDER BY r.started_at DESC`,
              )
              .all(args.family_id) as {
              run_id: string;
              topic: string | null;
              started_at: string;
              status: string;
            }[];
            runs = rows.map((r) => ({
              run_id: r.run_id,
              topic: r.topic ?? '',
              started_at: r.started_at,
              status: r.status,
            }));
          } catch {
            runs = [];
          }
        }

        return successResponse(
          makeResult(
            'family_get',
            {
              id: family.id,
              label: family.label,
              description: family.description ?? '',
              created_at: family.createdAt ?? '',
              last_activity: family.lastActivity ?? '',
              run_count: family.runCount ?? 0,
              related_families: relatedFamilies,
              merge_candidates: mergeCandidates,
              ...(entities !== undefined ? { entities } : {}),
              ...(runs !== undefined ? { runs } : {}),
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'family_get' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered family_get tool');
}
