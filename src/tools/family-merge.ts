/**
 * family_merge — Merge two families into one (one-way, irreversible).
 *
 * Emits a FAMILY_MERGED event. Always run with dry_run:true first.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { getFamily } from '../knowledge/store/projections.js';
import { getKgDb } from '../knowledge/store/db.js';
import { appendEvents } from '../knowledge/store/events.js';

const familyMergeSchema = z.object({
  from_id: z.string().min(1).describe('Family ID to merge FROM (will be retired)'),
  into_id: z.string().min(1).describe('Family ID to merge INTO (will absorb)'),
  reason: z.string().min(1).max(1000).describe('Reason for the merge'),
  dry_run: z.boolean().optional().default(false).describe('Preview affected counts without executing'),
});

export function registerFamilyMergeTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'family_merge',
    {
      description:
        'Merge one family into another. One-way and irreversible in V7.0. ' +
        'Always run with dry_run:true first to preview affected entity and run counts.',
      inputSchema: familyMergeSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const fromFamily = getFamily(args.from_id);
        const intoFamily = getFamily(args.into_id);

        if (fromFamily === null) {
          return errorResponse(new Error(`Source family "${args.from_id}" not found`));
        }
        if (intoFamily === null) {
          return errorResponse(new Error(`Target family "${args.into_id}" not found`));
        }

        if (args.from_id === args.into_id) {
          return errorResponse(new Error('Cannot merge a family into itself'));
        }

        const db = getKgDb();

        // Count affected entities
        let affectedEntityCount = 0;
        let affectedRunCount = 0;
        let dbUnavailable = false;
        if (db !== null) {
          try {
            const eRow = db
              .prepare('SELECT COUNT(*) as cnt FROM kg_node_families WHERE family_id = ?')
              .get(args.from_id) as { cnt: number } | undefined;
            affectedEntityCount = eRow?.cnt ?? 0;

            const rRow = db
              .prepare('SELECT COUNT(DISTINCT run_id) as cnt FROM kg_node_families WHERE family_id = ?')
              .get(args.from_id) as { cnt: number } | undefined;
            affectedRunCount = rRow?.cnt ?? 0;
          } catch (err: unknown) {
            logger.error({ err, tool: 'family_merge', fromId: args.from_id }, 'Failed to query affected counts');
          }
        } else {
          dbUnavailable = true;
        }

        if (args.dry_run) {
          return successResponse(
            makeResult(
              'family_merge',
              {
                dry_run: true,
                affected_entity_count: affectedEntityCount,
                affected_run_count: affectedRunCount,
                db_unavailable: dbUnavailable,
              },
              Date.now() - start,
            ),
          );
        }

        // Emit FAMILY_MERGED event
        const event = {
          timestamp: new Date().toISOString(),
          eventType: 'FAMILY_MERGED' as const,
          eventVersion: 1,
          runId: 'manual',
          batchId: null,
          actor: 'user',
          entityId: args.into_id,
          entityType: 'family',
          payload: JSON.stringify({
            from_id: args.from_id,
            into_id: args.into_id,
            reason: args.reason,
            affected_entity_count: affectedEntityCount,
            affected_run_count: affectedRunCount,
          }),
          payloadHash: null,
        };

        const emitted = appendEvents([event]);
        if (emitted.length === 0) {
          return errorResponse(new Error('Failed to emit FAMILY_MERGED event (DB not ready)'));
        }

        return successResponse(
          makeResult(
            'family_merge',
            {
              merged_entity_count: affectedEntityCount,
              dry_run: false,
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'family_merge' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered family_merge tool');
}
