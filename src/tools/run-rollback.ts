/**
 * run_rollback — Compensating-event rollback with dry-run mode.
 *
 * Emits RUN_ROLLED_BACK event. pure_run_local events require no compensation;
 * only cross_run_mutation events appear in the compensation plan.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { getRun, updateRunStatus } from '../knowledge/store/runs.js';
import { getKgDb } from '../knowledge/store/db.js';
import { appendEvents } from '../knowledge/store/events.js';
import type { CompensationEvent, CompensationType, RollbackClass } from '../knowledge/types.js';

const runRollbackSchema = z.object({
  run_id: z.string().min(1).describe('Run ID to roll back'),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview compensation plan without executing'),
});

export function registerRunRollbackTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'run_rollback',
    {
      description:
        'Roll back a run by emitting a RUN_ROLLED_BACK event. Pure-run-local events vanish from ' +
        'projection on rebuild; cross-run mutations appear in the compensation plan for manual review. ' +
        'Always use dry_run:true first to preview the compensation plan.',
      inputSchema: runRollbackSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const run = getRun(args.run_id);
        if (run === null) {
          return errorResponse(new Error(`Run "${args.run_id}" not found`));
        }
        if (run.status === 'rolled_back') {
          return successResponse(
            makeResult(
              'run_rollback',
              {
                status: 'already_rolled_back' as const,
                compensated_event_count: 0,
                compensation_plan: [],
                warnings: [],
              },
              Date.now() - start,
            ),
          );
        }

        const db = getKgDb();

        // Build compensation plan: query events for this run
        const compensationPlan: CompensationEvent[] = [];
        let compensatedEventCount = 0;

        if (db !== null) {
          try {
            const events = db
              .prepare(
                'SELECT id, event_type FROM kg_events WHERE run_id = ? AND event_type != ? ORDER BY timestamp ASC',
              )
              .all(args.run_id, 'RUN_ROLLED_BACK') as { id: string; event_type: string }[];

            const COMPENSATION_MAP: Record<
              string,
              'ENTITY_SPLIT' | 'FAMILY_REATTRIBUTED' | 'FAMILY_RETIRED'
            > = {
              ENTITY_MERGED: 'ENTITY_SPLIT',
              FAMILY_CLASSIFIED: 'FAMILY_REATTRIBUTED',
              FAMILY_CREATED: 'FAMILY_RETIRED',
            };
            for (const ev of events) {
              if (ev.event_type === 'NODE_ADDED' || ev.event_type === 'EDGE_ADDED') {
                compensatedEventCount++;
              } else if (ev.event_type in COMPENSATION_MAP) {
                compensatedEventCount++;
                const rollbackClass: RollbackClass = 'cross_run_mutation';
                const compensationType = COMPENSATION_MAP[ev.event_type] as CompensationType;
                compensationPlan.push({
                  original_event_id: ev.id,
                  original_event_type: ev.event_type,
                  rollback_class: rollbackClass,
                  compensation_type: compensationType,
                  description: `Compensate ${ev.event_type} event ${ev.id} from run ${args.run_id}`,
                });
              }
            }
          } catch {
            // query failed
          }
        }

        if (args.dry_run) {
          return successResponse(
            makeResult(
              'run_rollback',
              {
                status: 'dry_run' as const,
                compensated_event_count: compensatedEventCount,
                compensation_plan: compensationPlan,
                warnings: [],
              },
              Date.now() - start,
            ),
          );
        }

        // Emit RUN_ROLLED_BACK event
        const event = {
          timestamp: new Date().toISOString(),
          eventType: 'RUN_ROLLED_BACK' as const,
          eventVersion: 1,
          runId: args.run_id,
          batchId: null,
          actor: 'user',
          entityId: null,
          entityType: null,
          payload: JSON.stringify({
            run_id: args.run_id,
            compensated_event_count: compensatedEventCount,
            compensation_plan: compensationPlan,
          }),
          payloadHash: null,
        };

        const emitted = appendEvents([event]);
        if (emitted.length === 0) {
          return errorResponse(new Error('Failed to emit RUN_ROLLED_BACK event (DB not ready)'));
        }

        // Mark the run as rolled_back in kg_runs so it's excluded from listings
        updateRunStatus(args.run_id, 'rolled_back', {
          entityCount: run.entityCount,
          edgeCount: run.edgeCount,
        });

        return successResponse(
          makeResult(
            'run_rollback',
            {
              status: 'completed' as const,
              compensated_event_count: compensatedEventCount,
              compensation_plan: compensationPlan,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'run_rollback' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered run_rollback tool');
}
