/**
 * entity_lookup_batch — Batch resolve entity IDs to labeled nodes.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { getNode } from '../knowledge/store/projections.js';

const entityLookupBatchSchema = z.object({
  entity_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe('Entity IDs to resolve (max 100)'),
});

export function registerEntityLookupBatchTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'entity_lookup_batch',
    {
      description:
        'Batch resolve up to 100 entity IDs to labeled nodes with type, confidence, aliases, and family membership.',
      inputSchema: entityLookupBatchSchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const nodes: {
          id: string;
          label: string;
          type: string;
          extraction_confidence: number;
          aliases: string[];
          primary_family_id: string | null;
        }[] = [];
        const notFound: string[] = [];

        for (const id of args.entity_ids) {
          const node = getNode(id);
          if (node === null) {
            notFound.push(id);
          } else {
            nodes.push({
              id: node.id,
              label: node.label,
              type: node.type,
              extraction_confidence: node.extractionConfidence ?? 0,
              aliases: parseJsonArr(node.aliases),
              primary_family_id: node.primaryFamilyId,
            });
          }
        }

        return successResponse(
          makeResult(
            'entity_lookup_batch',
            { nodes, not_found: notFound, warnings: [] },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'entity_lookup_batch' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered entity_lookup_batch tool');
}

function parseJsonArr(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
    return [];
  } catch {
    return [];
  }
}
