/**
 * graph_rebuild — On-demand projection rebuild from the event store.
 *
 * Replays from genesis by default; explicit cursors are for diagnostics only.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { rebuildProjection } from '../knowledge/store/projections.js';

const graphRebuildSchema = z.object({
  full: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Replay all events from the beginning. Full rebuild is the safe default because projection swaps require complete state.',
    ),
  from_event_id: z.string().optional().describe('Rebuild from this event cursor (exclusive)'),
  validate: z
    .boolean()
    .optional()
    .default(false)
    .describe('Compute and return checksum after rebuild'),
});

export function registerGraphRebuildTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'graph_rebuild',
    {
      description:
        'Rebuild the six projection tables (nodes, edges, families, sources, node_families, event_refs) ' +
        'from the append-only event store. Replays from genesis by default so the atomic swap receives complete state. ' +
        'Explicit cursors are for diagnostics only.',
      inputSchema: graphRebuildSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const rebuildOpts: Record<string, unknown> = { full: true };
        if (args.from_event_id !== undefined) rebuildOpts.fromEventId = args.from_event_id;
        if (args.validate) rebuildOpts.validate = true;
        const result = rebuildProjection(rebuildOpts);

        return successResponse(
          makeResult(
            'graph_rebuild',
            {
              rebuilt_at: result.rebuiltAt,
              events_processed: result.eventsProcessed,
              duration_ms: result.durationMs,
              from_genesis: result.fromGenesis,
              ...(result.checksum !== undefined ? { checksum: result.checksum } : {}),
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'graph_rebuild' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered graph_rebuild tool');
}
