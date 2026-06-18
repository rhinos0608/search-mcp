/**
 * family_list — All families with stats and merge candidates.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { queryFamilies } from '../knowledge/store/projections.js';
import { getKgDb } from '../knowledge/store/db.js';

const familyListSchema = z.object({
  cursor: z.string().optional().describe('Pagination cursor'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Max families to return (default 50)'),
});

export function registerFamilyListTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'family_list',
    {
      description:
        'List all knowledge graph families with node counts, related families, and merge candidates. Paginated.',
      inputSchema: familyListSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const famOpts: Record<string, unknown> = {};
        if (args.cursor !== undefined) famOpts.cursor = args.cursor;
        famOpts.limit = args.limit;
        const result = queryFamilies(famOpts);
        const db = getKgDb();

        // Batch queries for all families at once
        const nodeCountMap = new Map<string, number>();
        const mergeCandidatesMap = new Map<
          string,
          { family_id: string; label: string; confidence: number }[]
        >();

        if (db !== null && result.families.length > 0) {
          const familyIds = result.families.map((f) => f.id);
          const placeholders = familyIds.map(() => '?').join(',');

          try {
            const nodeCountRows = db
              .prepare(
                `SELECT family_id, COUNT(*) as cnt FROM kg_node_families WHERE family_id IN (${placeholders}) GROUP BY family_id`,
              )
              .all(...familyIds) as { family_id: string; cnt: number }[];
            for (const row of nodeCountRows) {
              nodeCountMap.set(row.family_id, row.cnt);
            }

            const mergeRows = db
              .prepare(
                `SELECT family_a, family_b, reason, confidence FROM kg_family_merge_candidates WHERE family_a IN (${placeholders})`,
              )
              .all(...familyIds) as {
              family_a: string;
              family_b: string;
              reason: string | null;
              confidence: number | null;
            }[];
            for (const row of mergeRows) {
              const list = mergeCandidatesMap.get(row.family_a) ?? [];
              list.push({
                family_id: row.family_b,
                label: row.family_b,
                confidence: row.confidence ?? 0,
              });
              mergeCandidatesMap.set(row.family_a, list);
            }
          } catch (err) {
            logger.warn({ err }, 'batch query failed in family-list');
          }
        }

        const families = result.families.map((f) => {
          const nodeCount = nodeCountMap.get(f.id) ?? 0;
          const mergeCandidates = mergeCandidatesMap.get(f.id) ?? [];
          let relatedFamilies: {
            relation_id: string;
            family_id: string;
            relation_type: string;
          }[] = [];

          // Parse related_families JSON
          if (f.relatedFamilies !== null && f.relatedFamilies !== '') {
            try {
              const parsed = JSON.parse(f.relatedFamilies) as unknown;
              if (Array.isArray(parsed)) {
                relatedFamilies = (parsed as Record<string, unknown>[]).map(
                  (rf: Record<string, unknown>) => ({
                    relation_id: (rf.relation_id as string | undefined) ?? '',
                    family_id: (rf.family_id as string | undefined) ?? '',
                    relation_type: (rf.relation_type as string | undefined) ?? '',
                  }),
                );
              }
            } catch {
              // malformed JSON
            }
          }

          return {
            id: f.id,
            label: f.label,
            description: f.description ?? '',
            run_count: f.runCount ?? 0,
            node_count: nodeCount,
            last_activity: f.lastActivity ?? '',
            related_families: relatedFamilies,
            merge_candidates: mergeCandidates,
          };
        });

        return successResponse(
          makeResult(
            'family_list',
            {
              families,
              next_cursor: result.nextCursor,
              total: result.total,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'family_list' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered family_list tool');
}
