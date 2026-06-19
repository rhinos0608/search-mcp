/**
 * Consolidated Knowledge Graph tool family.
 *
 * Replaces ten standalone MCP tools (graph_ingest, graph_query, entity_lookup_batch,
 * graph_status, graph_rebuild, family_list, family_get, family_merge, run_list, run_rollback)
 * with a single `knowledge_graph` tool using a discriminated-union `action` field.
 *
 * Actions:
 *   ingest              — Ingest text/URL into knowledge graph
 *   query               — Full-text search, entity lookup, traversal
 *   entity_lookup_batch — Resolve up to 100 entity IDs
 *   status              — Event count, projection stats, storage size
 *   rebuild             — Rebuild projection tables
 *   family_list         — List families with node counts and merge candidates
 *   family_get          — Retrieve family detail with entities and runs
 *   family_merge        — Merge families (one-way, irreversible)
 *   run_list            — List extraction runs with filters
 *   run_rollback        — Roll back a run
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { logger } from '../../logger.js';
import { assertSafeUrl, safeResponseText } from '../../httpGuards.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { KnowledgeGraphExtractor } from '../../knowledge/extractor/index.js';
import type { NormalizedExtractionInput } from '../../knowledge/extractor/normalise.js';
import { createRun, updateRunStatus, getRun } from '../../knowledge/store/runs.js';
import { listRuns } from '../../knowledge/store/runs.js';
import { appendEvents } from '../../knowledge/store/events.js';
import { countEvents } from '../../knowledge/store/events.js';
import { getKgDb, getKgDbPath } from '../../knowledge/store/db.js';
import { rebuildProjection } from '../../knowledge/store/projections.js';
import { queryNodes, getEdgesForNode } from '../../knowledge/store/projections.js';
import { queryFamilies } from '../../knowledge/store/projections.js';
import { getFamily } from '../../knowledge/store/projections.js';
import { getNode } from '../../knowledge/store/projections.js';
import { getLatestCompatibleCheckpoint } from '../../knowledge/store/checkpoints.js';

// ════════════════════════════════════════════════════════════════════════════
// Action schemas (discriminated on "action")
// ════════════════════════════════════════════════════════════════════════════

const ingestSchema = z.object({
  action: z.literal('ingest').describe('Ingest text or URL content into the knowledge graph'),
  content: z.object({
    type: z.enum(['text', 'url']).describe('Source type'),
    value: z.string().min(1).max(1_000_000).describe('Text content or URL'),
  }),
  topic: z.string().max(500).optional().describe('Optional topic for the run'),
  family_hint: z.string().max(200).optional().describe('Suggested family label'),
  sync: z.boolean().optional().default(true).describe('When false, return immediately'),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .optional()
    .default(30_000)
    .describe('Max extraction time (ms)'),
  idempotency_key: z.string().max(200).optional().describe('Prevent duplicate runs'),
});

const querySchema = z.object({
  action: z
    .literal('query')
    .describe('Query the knowledge graph by entity ID, label, or full-text search'),
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

const entityLookupBatchSchema = z
  .object({
    action: z
      .literal('entity_lookup_batch')
      .describe(
        'Batch resolve up to 100 entity IDs by exact ID, or a single label query that can return multiple labeled nodes',
      ),
    entity_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe('Entity IDs to resolve (max 100)'),
    entity_label: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Single label/substring query — returns all matching labeled nodes up to limit'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe('Max results when using entity_label lookup'),
  })
  .refine((value) => value.entity_ids !== undefined || value.entity_label !== undefined, {
    message: 'Either entity_ids or entity_label is required',
  });

const statusSchema = z
  .object({
    action: z.literal('status').describe('Knowledge graph health and status'),
  })
  .describe(
    'No input parameters; returns event count, projection age, storage size, node/edge/family counts',
  );

const rebuildSchema = z.object({
  action: z
    .literal('rebuild')
    .describe('Rebuild projection tables from the append-only event store'),
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

const familyListSchema = z.object({
  action: z
    .literal('family_list')
    .describe('List all knowledge graph families with stats and merge candidates'),
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

const familyGetSchema = z.object({
  action: z
    .literal('family_get')
    .describe('Retrieve full family detail with optional entities and runs'),
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

const familyMergeSchema = z.object({
  action: z
    .literal('family_merge')
    .describe('Merge one family into another (one-way, irreversible)'),
  from_id: z.string().min(1).describe('Family ID to merge FROM (will be retired)'),
  into_id: z.string().min(1).describe('Family ID to merge INTO (will absorb)'),
  reason: z.string().min(1).max(1000).describe('Reason for the merge'),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview affected counts without executing'),
});

const runListSchema = z.object({
  action: z.literal('run_list').describe('List knowledge graph runs with optional filters'),
  family_id: z.string().optional().describe('Filter runs contributing to this family'),
  topic: z.string().optional().describe('Filter by topic (substring match)'),
  status: z.string().optional().describe('Filter by run status (queued, extracting, etc.)'),
  after: z.string().optional().describe('ISO-8601; runs started after this timestamp'),
  before: z.string().optional().describe('ISO-8601; runs started before this timestamp'),
  limit: z.number().int().min(1).max(200).optional().default(20).describe('Max runs (default 20)'),
  cursor: z.string().optional().describe('Pagination cursor (started_at|run_id)'),
});

const runRollbackSchema = z.object({
  action: z.literal('run_rollback').describe('Roll back a run with compensating-event plan'),
  run_id: z.string().min(1).describe('Run ID to roll back'),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview compensation plan without executing'),
});

// ════════════════════════════════════════════════════════════════════════════
// Shared helpers (extracted from standalone files)
// ════════════════════════════════════════════════════════════════════════════

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

/**
 * Run extraction asynchronously and emit events on success or failure.
 * Used by the async (non-sync) ingest path to avoid blocking the tool response.
 */
async function runAsyncExtraction(
  extractor: KnowledgeGraphExtractor,
  normInput: NormalizedExtractionInput,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const result = await extractor.extract(normInput, runId, { totalTimeoutMs: timeoutMs });
    emitEventsFromResult(result, runId);
  } catch (err: unknown) {
    updateRunStatus(runId, 'failed', {
      lastError: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Finalize a run after KnowledgeGraphExtractor has emitted its events. */
function emitEventsFromResult(
  result: Awaited<ReturnType<KnowledgeGraphExtractor['extract']>>,
  runId: string,
): void {
  updateRunStatus(runId, 'completed', {
    entityCount: result.entities.length,
    edgeCount: result.edges.length,
  });
  rebuildProjection({ full: true });
}

/** Build a NormalizedExtractionInput from user-supplied content parameters. */
async function buildNormInput(
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
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    assertSafeUrl(content.value);
    const resp = await fetch(content.value, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`);
    const contentType = resp.headers.get('content-type') ?? '';
    if (
      contentType.length > 0 &&
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/json')
    ) {
      throw new Error(`Unsupported content type "${contentType}" for KG ingest URL`);
    }
    return {
      text: await safeResponseText(resp, content.value, 5 * 1024 * 1024),
      url: content.value,
      title: topic,
      sourceKind: 'documentation' as const,
      retrievedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Family definition
// ════════════════════════════════════════════════════════════════════════════

const knowledgeGraphFamily: FamilyDefinition = {
  name: 'knowledge_graph',
  description:
    'Knowledge graph tools for entity extraction, relationship management, family clustering, ' +
    'run tracking, and projection management. Use the `action` field to choose the operation.',
  actions: [
    // ── ingest ───────────────────────────────────────────────────────────
    {
      name: 'ingest',
      description:
        'Ingest text or URL content into the knowledge graph. Extracts entities and relationships ' +
        'via LLM pipeline. When sync=false, returns a run_id immediately; poll via status for progress.',
      schema: ingestSchema,
      handler: async (args, cfg) => {
        const start = Date.now();
        const {
          content,
          topic,
          sync,
          timeout_ms: timeoutMs,
          idempotency_key: idKey,
          family_hint: familyHint,
        } = args as {
          content: { type: 'text' | 'url'; value: string };
          topic?: string;
          sync: boolean;
          timeout_ms: number;
          idempotency_key?: string;
          family_hint?: string;
        };

        const db = getKgDb();
        let runId: string;

        if (idKey !== undefined && db !== null) {
          const row = db
            .prepare('SELECT run_id FROM kg_runs WHERE idempotency_key = ?')
            .get(idKey) as { run_id: string } | undefined;
          if (row !== undefined) {
            runId = row.run_id;
            const existingRun = getRun(runId);
            if (
              existingRun !== null &&
              (existingRun.status === 'extracting' ||
                existingRun.status === 'classifying' ||
                existingRun.status === 'projecting' ||
                existingRun.status === 'queued')
            ) {
              return successResponse(
                makeResult(
                  'knowledge_graph.ingest',
                  { status: existingRun.status, run_id: runId },
                  Date.now() - start,
                ),
              );
            } else if (
              existingRun !== null &&
              (existingRun.status === 'completed' || existingRun.status === 'failed')
            ) {
              return successResponse(
                makeResult(
                  'knowledge_graph.ingest',
                  {
                    status:
                      existingRun.status === 'completed'
                        ? ('completed' as const)
                        : ('failed' as const),
                    run_id: runId,
                  },
                  Date.now() - start,
                ),
              );
            }
          } else {
            const run = createRun({
              topic: topic ?? familyHint ?? null,
              query: content.value.slice(0, 500),
            });
            if (run === null) return errorResponse(new Error('DB not ready'));
            runId = run.runId;
            db.prepare('UPDATE kg_runs SET idempotency_key = ? WHERE run_id = ?').run(idKey, runId);
          }
        } else {
          const run = createRun({
            topic: topic ?? familyHint ?? null,
            query: content.value.slice(0, 500),
          });
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
          void runAsyncExtraction(extractor, normInput, runId, timeoutMs);
          return successResponse(
            makeResult(
              'knowledge_graph.ingest',
              { status: 'processing' as const, run_id: runId },
              Date.now() - start,
            ),
          );
        }

        // Sync path
        updateRunStatus(runId, 'classifying');
        const extractor = new KnowledgeGraphExtractor(cfg);
        let extraction: Awaited<ReturnType<KnowledgeGraphExtractor['extract']>>;
        try {
          extraction = await extractor.extract(normInput, runId, { totalTimeoutMs: timeoutMs });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          updateRunStatus(runId, 'failed', { lastError: msg });
          return errorResponse(new Error(`Extraction failed: ${msg}`));
        }

        emitEventsFromResult(extraction, runId);

        return successResponse(
          makeResult(
            'knowledge_graph.ingest',
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
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.ingest.';
        return null;
      },
    },

    // ── query ────────────────────────────────────────────────────────────
    {
      name: 'query',
      description:
        'Query the knowledge graph by entity ID, entity label, or full-text search. ' +
        'Exactly one of query, entity_id, or entity_label is required. ' +
        'Returns connected nodes, edges, and traversal metadata.',
      schema: querySchema,
      handler: async (args) => {
        const start = Date.now();
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
        } = args as {
          family_id?: string;
          entity_type?: string;
          min_confidence?: number;
          run_id?: string;
          after?: string;
          before?: string;
          depth: number;
          limit: number;
          cursor?: string;
        };

        const nodeOpts: Record<string, unknown> = {};
        if (args.entity_id !== undefined) nodeOpts.entityId = args.entity_id;
        if (args.entity_label !== undefined) nodeOpts.label = args.entity_label;
        if (
          args.query !== undefined &&
          args.entity_id === undefined &&
          args.entity_label === undefined
        ) {
          nodeOpts.search = args.query;
        }
        if (entity_type !== undefined) nodeOpts.type = entity_type;
        if (family_id !== undefined) nodeOpts.familyId = family_id;
        if (min_confidence !== undefined) nodeOpts.minConfidence = min_confidence;
        if (run_id !== undefined) nodeOpts.runId = run_id;
        if (after !== undefined) nodeOpts.after = after;
        if (before !== undefined) nodeOpts.before = before;
        nodeOpts.limit = limit;
        if (cursor !== undefined) nodeOpts.cursor = cursor;

        const nodeResult = queryNodes(nodeOpts);
        const disambiguated = args.entity_label !== undefined && nodeResult.nodes.length > 1;

        const seenEdgeIds = new Set<string>();
        const allEdges = new Map<string, unknown>();
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
          }
          frontier = nextFrontier;
        }

        const checkpoint = getLatestCompatibleCheckpoint(1);
        let projectionAgeMs = 0;
        if (checkpoint !== null) {
          projectionAgeMs = Date.now() - new Date(checkpoint.createdAt).getTime();
        }

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
            'knowledge_graph.query',
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
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled) return 'Set KG_ENABLED=true to use knowledge_graph.query.';
        return null;
      },
    },

    // ── entity_lookup_batch ──────────────────────────────────────────────
    {
      name: 'entity_lookup_batch',
      description:
        'Batch resolve up to 100 entity IDs to labeled nodes with type, confidence, aliases, and family membership.',
      schema: entityLookupBatchSchema,
      handler: async (args) => {
        const start = Date.now();
        const {
          entity_ids: entityIds,
          entity_label: entityLabel,
          limit,
        } = args as {
          entity_ids?: string[];
          entity_label?: string;
          limit: number;
        };

        const nodes: {
          id: string;
          label: string;
          type: string;
          extraction_confidence: number;
          aliases: string[];
          primary_family_id: string | null;
        }[] = [];
        const notFound: string[] = [];

        if (entityIds !== undefined) {
          for (const id of entityIds) {
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
        } else if (entityLabel !== undefined) {
          const result = queryNodes({ search: entityLabel, limit });
          for (const node of result.nodes) {
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
            'knowledge_graph.entity_lookup_batch',
            { nodes, not_found: notFound, warnings: [] },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.entity_lookup_batch.';
        return null;
      },
    },

    // ── status ───────────────────────────────────────────────────────────
    {
      name: 'status',
      description:
        'Knowledge graph health and status. Returns event count, projection age, ' +
        'storage size, node/edge/family counts, and active/failed run stats.',
      schema: statusSchema,
      handler: async () => {
        const start = Date.now();
        const eventCount = countEvents();
        const db = getKgDb();

        const checkpoint = getLatestCompatibleCheckpoint(1);
        const lastProjectionBuilt = checkpoint?.createdAt ?? null;
        const projectionAgeMs =
          lastProjectionBuilt !== null ? Date.now() - new Date(lastProjectionBuilt).getTime() : 0;
        const projectionVersion = checkpoint?.projectionVersion ?? 0;

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

        let families = 0;
        let nodes = 0;
        let edges = 0;
        if (db !== null) {
          try {
            families =
              (
                db.prepare('SELECT COUNT(*) as cnt FROM kg_families').get() as
                  | { cnt: number }
                  | undefined
              )?.cnt ?? 0;
            nodes =
              (
                db.prepare('SELECT COUNT(*) as cnt FROM kg_nodes').get() as
                  | { cnt: number }
                  | undefined
              )?.cnt ?? 0;
            edges =
              (
                db.prepare('SELECT COUNT(*) as cnt FROM kg_edges').get() as
                  | { cnt: number }
                  | undefined
              )?.cnt ?? 0;
          } catch {
            // tables may be empty
          }
        }

        let activeRuns = 0;
        let failedRuns = 0;
        let lastRunError: string | null = null;
        if (db !== null) {
          try {
            const activeRow = db
              .prepare(
                "SELECT COUNT(*) as cnt FROM kg_runs WHERE status IN ('extracting','classifying','projecting')",
              )
              .get() as { cnt: number } | undefined;
            activeRuns = activeRow?.cnt ?? 0;
            const failedRow = db
              .prepare("SELECT COUNT(*) as cnt FROM kg_runs WHERE status = 'failed'")
              .get() as { cnt: number } | undefined;
            failedRuns = failedRow?.cnt ?? 0;
            const lastErrRow = db
              .prepare(
                "SELECT last_error FROM kg_runs WHERE status = 'failed' AND last_error IS NOT NULL ORDER BY failed_at DESC LIMIT 1",
              )
              .get() as { last_error: string } | undefined;
            lastRunError = lastErrRow?.last_error ?? null;
          } catch {
            // table may be empty
          }
        }

        let pendingFamilyCount = 0;
        let pendingAssignmentCount = 0;
        let pendingExtractionCount = 0;
        let oldestPendingExtraction: string | null = null;
        let lastConsolidationAt: string | null = null;
        if (db !== null) {
          try {
            const pfRow = db.prepare('SELECT COUNT(*) as cnt FROM kg_pending_families').get() as
              | { cnt: number }
              | undefined;
            pendingFamilyCount = pfRow?.cnt ?? 0;
            const paRow = db.prepare('SELECT COUNT(*) as cnt FROM kg_pending_assignments').get() as
              | { cnt: number }
              | undefined;
            pendingAssignmentCount = paRow?.cnt ?? 0;
            const peRow = db
              .prepare('SELECT COUNT(*) as cnt FROM kg_pending_extractions WHERE run_id IS NULL')
              .get() as { cnt: number } | undefined;
            pendingExtractionCount = peRow?.cnt ?? 0;
            const oeRow = db
              .prepare(
                'SELECT queued_at FROM kg_pending_extractions WHERE run_id IS NULL ORDER BY queued_at ASC LIMIT 1',
              )
              .get() as { queued_at: string } | undefined;
            oldestPendingExtraction = oeRow?.queued_at ?? null;
            const lcRow = db
              .prepare(
                'SELECT MAX(created_at) as latest FROM kg_projection_checkpoints WHERE compatible = 1',
              )
              .get() as { latest: string } | undefined;
            lastConsolidationAt = lcRow?.latest ?? null;
          } catch {
            // tables or queries may be unavailable
          }
        }

        return successResponse(
          makeResult(
            'knowledge_graph.status',
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
              write_queue_depth: 0,
            },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.status.';
        return null;
      },
    },

    // ── rebuild ──────────────────────────────────────────────────────────
    {
      name: 'rebuild',
      description:
        'Rebuild the six projection tables (nodes, edges, families, sources, node_families, event_refs) ' +
        'from the append-only event store. Supports incremental or full genesis rebuild.',
      schema: rebuildSchema,
      handler: async (args) => {
        const start = Date.now();
        const rebuildOpts: Record<string, unknown> = { full: true };
        if (args.from_event_id !== undefined) rebuildOpts.fromEventId = args.from_event_id;
        if (args.validate) rebuildOpts.validate = true;
        const result = rebuildProjection(rebuildOpts);

        return successResponse(
          makeResult(
            'knowledge_graph.rebuild',
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
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.rebuild.';
        return null;
      },
    },

    // ── family_list ──────────────────────────────────────────────────────
    {
      name: 'family_list',
      description:
        'List all knowledge graph families with node counts, related families, ' +
        'and merge candidates. Paginated.',
      schema: familyListSchema,
      handler: async (args) => {
        const start = Date.now();
        const famOpts: Record<string, unknown> = {};
        if (args.cursor !== undefined) famOpts.cursor = args.cursor;
        famOpts.limit = (args as { limit: number }).limit;
        const result = queryFamilies(famOpts);
        const db = getKgDb();

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
            logger.warn({ err }, 'batch query failed in family_list');
          }
        }

        const families = result.families.map((f) => {
          const nodeCount = nodeCountMap.get(f.id) ?? 0;
          const mergeCandidates = mergeCandidatesMap.get(f.id) ?? [];
          let relatedFamilies: { relation_id: string; family_id: string; relation_type: string }[] =
            [];
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
            'knowledge_graph.family_list',
            {
              families,
              next_cursor: result.nextCursor,
              total: result.total,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.family_list.';
        return null;
      },
    },

    // ── family_get ───────────────────────────────────────────────────────
    {
      name: 'family_get',
      description:
        'Retrieve full family detail including description, created_at, last_activity, ' +
        'related families, merge candidates, and optionally entities and runs.',
      schema: familyGetSchema,
      handler: async (args) => {
        const start = Date.now();
        const { family_id, include_entities, include_runs } = args as {
          family_id: string;
          include_entities: boolean;
          include_runs: boolean;
        };

        const family = getFamily(family_id);
        if (family === null) {
          return errorResponse(new Error(`Family "${family_id}" not found`));
        }

        const db = getKgDb();

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
              relatedFamilies = (parsed as Record<string, unknown>[]).map(
                (rf: Record<string, unknown>) => ({
                  relation_id: (rf.relation_id as string | undefined) ?? '',
                  family_id: (rf.family_id as string | undefined) ?? '',
                  label:
                    (rf.label as string | undefined) ?? (rf.family_id as string | undefined) ?? '',
                  relation_type: (rf.relation_type as string | undefined) ?? '',
                }),
              );
            }
          } catch {
            // malformed JSON
          }
        }

        let mergeCandidates: { family_id: string; label: string; confidence: number }[] = [];
        if (db !== null) {
          try {
            const mergeRows = db
              .prepare(
                'SELECT family_b, confidence FROM kg_family_merge_candidates WHERE family_a = ?',
              )
              .all(family_id) as { family_b: string; confidence: number | null }[];
            mergeCandidates = mergeRows.map((r) => ({
              family_id: r.family_b,
              label: r.family_b,
              confidence: r.confidence ?? 0,
            }));
          } catch {
            // query failed
          }
        }

        let entities: { id: string; label: string; type: string; confidence: number }[] | undefined;
        if (include_entities && db !== null) {
          try {
            const rows = db
              .prepare(
                `SELECT n.id, n.label, n.type, n.extraction_confidence
                 FROM kg_nodes n
                 JOIN kg_node_families nf ON n.id = nf.node_id
                 WHERE nf.family_id = ?
                 ORDER BY n.label ASC`,
              )
              .all(family_id) as {
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

        let runs:
          | { run_id: string; topic: string; started_at: string; status: string }[]
          | undefined;
        if (include_runs && db !== null) {
          try {
            const rows = db
              .prepare(
                `SELECT DISTINCT r.run_id, r.topic, r.started_at, r.status
                 FROM kg_runs r
                 JOIN kg_node_families nf ON r.run_id = nf.run_id
                 WHERE nf.family_id = ?
                 ORDER BY r.started_at DESC`,
              )
              .all(family_id) as {
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
            'knowledge_graph.family_get',
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
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.family_get.';
        return null;
      },
    },

    // ── family_merge ─────────────────────────────────────────────────────
    {
      name: 'family_merge',
      description:
        'Merge one family into another. One-way and irreversible. ' +
        'Always run with dry_run:true first to preview affected entity and run counts.',
      schema: familyMergeSchema,
      handler: async (args) => {
        const start = Date.now();
        const { from_id, into_id, reason, dry_run } = args as {
          from_id: string;
          into_id: string;
          reason: string;
          dry_run: boolean;
        };

        const fromFamily = getFamily(from_id);
        const intoFamily = getFamily(into_id);

        if (fromFamily === null) {
          return errorResponse(new Error(`Source family "${from_id}" not found`));
        }
        if (intoFamily === null) {
          return errorResponse(new Error(`Target family "${into_id}" not found`));
        }
        if (from_id === into_id) {
          return errorResponse(new Error('Cannot merge a family into itself'));
        }

        const db = getKgDb();
        let affectedEntityCount = 0;
        let affectedRunCount = 0;
        let dbUnavailable = false;

        if (db !== null) {
          try {
            const eRow = db
              .prepare('SELECT COUNT(*) as cnt FROM kg_node_families WHERE family_id = ?')
              .get(from_id) as { cnt: number } | undefined;
            affectedEntityCount = eRow?.cnt ?? 0;
            const rRow = db
              .prepare(
                'SELECT COUNT(DISTINCT run_id) as cnt FROM kg_node_families WHERE family_id = ?',
              )
              .get(from_id) as { cnt: number } | undefined;
            affectedRunCount = rRow?.cnt ?? 0;
          } catch (err: unknown) {
            logger.error(
              { err, tool: 'knowledge_graph.family_merge', fromId: from_id },
              'Failed to query affected counts',
            );
          }
        } else {
          dbUnavailable = true;
        }

        if (dry_run) {
          return successResponse(
            makeResult(
              'knowledge_graph.family_merge',
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

        const event = {
          timestamp: new Date().toISOString(),
          eventType: 'FAMILY_MERGED' as const,
          eventVersion: 1,
          runId: 'manual',
          batchId: null,
          actor: 'user',
          entityId: into_id,
          entityType: 'family',
          payload: JSON.stringify({
            from_id,
            into_id,
            reason,
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
            'knowledge_graph.family_merge',
            {
              merged_entity_count: affectedEntityCount,
              dry_run: false,
            },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.family_merge.';
        return null;
      },
    },

    // ── run_list ─────────────────────────────────────────────────────────
    {
      name: 'run_list',
      description:
        'List knowledge graph runs with optional filters (family, topic, status, temporal range) and cursor-based pagination.',
      schema: runListSchema,
      handler: async (args) => {
        const start = Date.now();
        const listOpts: Record<string, unknown> = {};
        const { family_id, topic, status, after, before, limit, cursor } = args as {
          family_id?: string;
          topic?: string;
          status?: string;
          after?: string;
          before?: string;
          limit: number;
          cursor?: string;
        };

        if (family_id !== undefined) listOpts.familyId = family_id;
        if (topic !== undefined) listOpts.topic = topic;
        if (status !== undefined) {
          listOpts.status = status;
        } else {
          listOpts.excludeStatuses = ['rolled_back'];
        }
        if (after !== undefined) listOpts.after = after;
        if (before !== undefined) listOpts.before = before;
        listOpts.limit = limit;
        if (cursor !== undefined) listOpts.cursor = cursor;

        const result = listRuns(listOpts);
        const db = getKgDb();

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
            // query failed
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
            'knowledge_graph.run_list',
            {
              runs,
              next_cursor: result.nextCursor,
              total: result.total,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.run_list.';
        return null;
      },
    },

    // ── run_rollback ─────────────────────────────────────────────────────
    {
      name: 'run_rollback',
      description:
        'Roll back a run by emitting a RUN_ROLLED_BACK event. Pure-run-local events vanish from ' +
        'projection on rebuild; cross-run mutations appear in the compensation plan for manual review. ' +
        'Always use dry_run:true first to preview the compensation plan.',
      schema: runRollbackSchema,
      handler: async (args) => {
        const start = Date.now();
        const { run_id, dry_run } = args as { run_id: string; dry_run: boolean };

        const run = getRun(run_id);
        if (run === null) {
          return errorResponse(new Error(`Run "${run_id}" not found`));
        }
        if (run.status === 'rolled_back') {
          return successResponse(
            makeResult(
              'knowledge_graph.run_rollback',
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
        const compensationPlan: {
          original_event_id: string;
          original_event_type: string;
          rollback_class: string;
          compensation_type: string;
          description: string;
        }[] = [];
        let compensatedEventCount = 0;

        if (db !== null) {
          try {
            const events = db
              .prepare(
                'SELECT id, event_type FROM kg_events WHERE run_id = ? AND event_type != ? ORDER BY timestamp ASC',
              )
              .all(run_id, 'RUN_ROLLED_BACK') as { id: string; event_type: string }[];

            const COMPENSATION_MAP: Record<string, string> = {
              ENTITY_MERGED: 'ENTITY_SPLIT',
              FAMILY_CLASSIFIED: 'FAMILY_REATTRIBUTED',
              FAMILY_CREATED: 'FAMILY_RETIRED',
            };

            for (const ev of events) {
              if (ev.event_type === 'NODE_ADDED' || ev.event_type === 'EDGE_ADDED') {
                compensatedEventCount++;
              } else if (ev.event_type in COMPENSATION_MAP) {
                compensatedEventCount++;
                const compensationType = COMPENSATION_MAP[ev.event_type];
                if (compensationType === undefined) continue;
                compensationPlan.push({
                  original_event_id: ev.id,
                  original_event_type: ev.event_type,
                  rollback_class: 'cross_run_mutation',
                  compensation_type: compensationType,
                  description: `Compensate ${ev.event_type} event ${ev.id} from run ${run_id}`,
                });
              }
            }
          } catch {
            // query failed
          }
        }

        if (dry_run) {
          return successResponse(
            makeResult(
              'knowledge_graph.run_rollback',
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

        const event = {
          timestamp: new Date().toISOString(),
          eventType: 'RUN_ROLLED_BACK' as const,
          eventVersion: 1,
          runId: run_id,
          batchId: null,
          actor: 'user',
          entityId: null,
          entityType: null,
          payload: JSON.stringify({
            run_id,
            compensated_event_count: compensatedEventCount,
            compensation_plan: compensationPlan,
          }),
          payloadHash: null,
        };

        const emitted = appendEvents([event]);
        if (emitted.length === 0) {
          return errorResponse(new Error('Failed to emit RUN_ROLLED_BACK event (DB not ready)'));
        }

        updateRunStatus(run_id, 'rolled_back', {
          entityCount: run.entityCount,
          edgeCount: run.edgeCount,
        });

        return successResponse(
          makeResult(
            'knowledge_graph.run_rollback',
            {
              status: 'completed' as const,
              compensated_event_count: compensatedEventCount,
              compensation_plan: compensationPlan,
              warnings: [],
            },
            Date.now() - start,
          ),
        );
      },
      configIssue: (cfg) => {
        if (!cfg.knowledgeGraph.enabled)
          return 'Set KG_ENABLED=true to use knowledge_graph.run_rollback.';
        return null;
      },
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════════════

export function registerKnowledgeGraphTool(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  registerFamily(server, knowledgeGraphFamily, cfg, kgHook);
}

/**
 * Action-level capability report for health checks.
 * Returns per-action availability with remediation hints.
 */
export function knowledgeGraphCapabilities(cfg: SearchConfig) {
  return knowledgeGraphFamily.actions.map((a) => ({
    name: `knowledge_graph.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
