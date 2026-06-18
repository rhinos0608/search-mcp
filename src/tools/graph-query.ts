/**
 * graph_query — Semantic search, entity lookup, and relationship traversal.
 *
 * Exactly one of query, entity_id, or entity_label must be provided.
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import { makeResult, errorResponse, successResponse } from './response.js';
import { queryNodes, getEdgesForNode } from '../knowledge/store/projections.js';
import { getLatestCompatibleCheckpoint } from '../knowledge/store/checkpoints.js';

const graphQuerySchema = z.object({
  query: z.string().max(5000).optional().describe('Full-text search query (alias-aware)'),
  entity_id: z.string().optional().describe('Lookup by exact entity ID'),
  entity_label: z.string().optional().describe('Lookup by label (alias-aware)'),
  family_id: z.string().optional().describe('Filter to entities in this family'),
  entity_type: z.string().optional().describe('Filter by entity type'),
  min_confidence: z.number().min(0).max(1).optional().describe('Minimum extraction confidence'),
  run_id: z.string().optional().describe('Restrict to entities from this run'),
  after: z.string().optional().describe('ISO-8601; entities first seen after'),
  before: z.string().optional().describe('ISO-8601; entities first seen before'),
  depth: z.number().int().min(1).max(3).optional().default(1).describe('Traversal depth (1-3)'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

export function registerGraphQueryTool(server: McpServer, _cfg: SearchConfig): void {
  server.registerTool(
    'graph_query',
    {
      description:
        'Query the knowledge graph by entity ID, entity label, or full-text search. ' +
        'Exactly one of query, entity_id, or entity_label is required. ' +
        'Returns connected nodes, edges, and traversal metadata.',
      inputSchema: graphQuerySchema,
    },
    async (args) => {
      const start = Date.now();
      try {
        const provided = [args.query, args.entity_id, args.entity_label].filter(Boolean);
        if (provided.length !== 1) {
          return errorResponse(
            new Error('Exactly one of query, entity_id, or entity_label must be provided'),
          );
        }

        const {
          family_id,
          entity_type,
          min_confidence,
          run_id,
          after,
          before,
          depth,
          limit,
          cursor,
        } = args;
        const limitVal = limit;

        // Resolve nodes
        const nodeOpts: Record<string, unknown> = {};
        if (args.entity_id !== undefined) nodeOpts.entityId = args.entity_id;
        if (args.entity_label !== undefined) nodeOpts.label = args.entity_label;
        if (
          args.query !== undefined &&
          args.entity_id === undefined &&
          args.entity_label === undefined
        ) {
          // TODO: args.query should trigger full-text search behavior distinct from label matching.
          // Currently falls back to label/substring match (alias-aware) via nodeOpts.label.
          // Full-text search (e.g. FTS5 on kg_nodes.label + kg_nodes.aliases) is planned.
          nodeOpts.label = args.query;
        }
        if (entity_type !== undefined) nodeOpts.type = entity_type;
        if (family_id !== undefined) nodeOpts.familyId = family_id;
        if (min_confidence !== undefined) nodeOpts.minConfidence = min_confidence;
        if (run_id !== undefined) nodeOpts.runId = run_id;
        if (after !== undefined) nodeOpts.after = after;
        if (before !== undefined) nodeOpts.before = before;
        nodeOpts.limit = limitVal;
        if (cursor !== undefined) nodeOpts.cursor = cursor;
        const nodeResult = queryNodes(nodeOpts);

        const disambiguated = args.entity_label !== undefined && nodeResult.nodes.length > 1;

        // Collect edge IDs to avoid dupes at each depth
        const seenEdgeIds = new Set<string>();
        const allEdges = new Map<string, unknown>();

        // Multi-hop traversal: start from found nodes, expand outward up to depth
        const visitedNodeIds = new Set<string>();
        let frontier = [...nodeResult.nodes];

        for (let hop = 0; hop < depth; hop++) {
          if (frontier.length === 0) break;

          const nextFrontier: typeof nodeResult.nodes = [];

          for (const node of frontier) {
            if (visitedNodeIds.has(node.id)) continue;
            visitedNodeIds.add(node.id);

            const edges = getEdgesForNode(node.id, 1);
            for (const edge of edges) {
              if (!seenEdgeIds.has(edge.id)) {
                seenEdgeIds.add(edge.id);
                allEdges.set(edge.id, edge);

                // Add the peer node to the next frontier
                const peerId = edge.fromId === node.id ? edge.toId : edge.fromId;
                if (!visitedNodeIds.has(peerId)) {
                  const peerResult = queryNodes({ entityId: peerId, limit: 1 });
                  if (peerResult.nodes.length > 0) {
                    const peer = peerResult.nodes[0];
                    if (peer !== undefined) {
                      nextFrontier.push(peer);
                    }
                  }
                }
              }
            }

            frontier = nextFrontier;
          }
        }

        // Check projection age
        const checkpoint = getLatestCompatibleCheckpoint(1);
        let projectionAgeMs = 0;
        if (checkpoint !== null) {
          projectionAgeMs = Date.now() - new Date(checkpoint.createdAt).getTime();
        }

        // Format output per spec
        const nodes = nodeResult.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          type: n.type,
          extraction_confidence: n.extractionConfidence ?? 0,
          aliases: parseJsonArr(n.aliases),
          primary_family_id: n.primaryFamilyId,
          first_seen_run_id: n.firstSeenRunId ?? '',
        }));

        const edges = Array.from(allEdges.values()).map((e) => {
          const record = e as Record<string, unknown>;
          return {
            id: record.id as string,
            from_id: record.fromId as string,
            to_id: record.toId as string,
            type: record.type as string,
            evidence_strength: (record.evidenceStrength as number | undefined) ?? 0,
            evidence: (record.evidence as string | undefined) ?? '',
            evidence_verbatim: (record.evidenceVerbatim as number | undefined) === 1,
          };
        });

        return successResponse(
          makeResult(
            'graph_query',
            {
              nodes,
              edges,
              disambiguated,
              next_cursor: nodeResult.nextCursor,
              total: nodeResult.total,
              warnings: [],
              meta: {
                query_ms: Date.now() - start,
                projection_age_ms: projectionAgeMs,
              },
            },
            Date.now() - start,
          ),
        );
      } catch (err: unknown) {
        logger.error({ err, tool: 'graph_query' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  logger.info('Registered graph_query tool');
}

function parseJsonArr(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === 'string');
    return [];
  } catch {
    return [];
  }
}
