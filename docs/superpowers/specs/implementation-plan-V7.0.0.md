# V7.0.0 — Longitudinal Knowledge Graph — Implementation Plan

**Created:** 2026-05-15
**Status:** In progress

> **Implementation note (2026-05-17):** The V7 knowledge graph MCP surface has been consolidated into a single `knowledge_graph` family tool. Historical references to standalone tools map to actions: `graph_ingest` → `knowledge_graph.ingest`, `graph_query` → `knowledge_graph.query`, `graph_status` → `knowledge_graph.status`, `graph_rebuild` → `knowledge_graph.rebuild`, while `entity_lookup_batch`, `family_list`, `family_get`, `family_merge`, `run_list`, and `run_rollback` are actions on the same family tool.

## Phase Structure

6 sequential phases. Each phase produces reviewable, testable output. Phase 1 must complete before Phase 2, etc.

---

## Phase 1: Foundation — Config, Schema, Event Store

**Goal:** SQLite database exists, event store append-only table works, config wired through the existing `SearchConfig` system.

### 1a. Configuration (`src/knowledge/config.ts`)
- Add `KnowledgeGraphConfig` interface (matches spec Section 5)
- Add `knowledgeGraph` field to `SearchConfig`
- Wire env vars: `KG_ENABLED`, `KG_DB_PATH`, `KG_PROJECTION_MAX_EVENTS`, etc.
- Default: `enabled: false`, `dbPath: ~/.cache/search-mcp/kg/kg.sqlite`

### 1b. Database Manager (`src/knowledge/store/db.ts`)
- SQLite WAL mode, busy timeout 5000ms
- `initializeSchema()` — create all tables from spec Section 1
- `getDb()` — singleton pattern (lazy init)
- Use `better-sqlite3` (already used in `corpusCache.ts`)

### 1c. Event Store (`src/knowledge/store/events.ts`)
- `appendEvents(events: KgEvent[])` — insert into `kg_events`, return event IDs
- ULID generation for event IDs (use existing ULID lib or add `ulid` package)
- Payload hash computation (sha256)
- `queryEvents(filters)` — filtered reads for projection rebuild
- `getLatestEventCursor()` — for checkpointing

### 1d. Run Management (`src/knowledge/store/runs.ts`)
- `createRun(params)` → insert `kg_runs` row
- `updateRunStatus(runId, status, metadata)`
- `getRun(runId)`
- `listRuns(filters)`
- `markStuckRunsFailed()` — startup recovery

### 1e. Pending Storage (`src/knowledge/store/pending.ts`)
- `appendExtraction(entry)` — write to `kg_pending_extractions`
- `flushExtractions(sessionId)` — group into run
- `getPendingExtractions(sessionId)`
- `getStaleExtractions(maxAgeMs)` — startup recovery
- Pending families/assignments CRUD

### 1f. Types (`src/knowledge/types.ts`)
- All interfaces: `KgEvent`, `KgRun`, `KgNode`, `KgEdge`, `KgFamily`, `KgSource`
- Event type enums
- `StructuredWarning` type
- `ExtractionInput`, `NormalizedEntity`, `NormalizedRelationship`

### Deliverables
- `src/knowledge/config.ts`
- `src/knowledge/types.ts`
- `src/knowledge/store/db.ts`
- `src/knowledge/store/events.ts`
- `src/knowledge/store/runs.ts`
- `src/knowledge/store/pending.ts`
- Tests for event store append/query
- Config tests

**Review check:** Schema matches spec Section 1 exactly. WAL mode confirmed. ULID generation works.

---

## Phase 2: Extractor Pipeline

**Goal:** LLM-powered extraction from content → canonicalized entities + relationships. Canonicalization with embedding-based dedup.

### 2a. Extractor Schemas (`src/knowledge/extractor/schemas.ts`)
- `LLMEntityZ`, `LLMRelationshipZ`, `LLMExtractionResultZ` (Zod v4)
- `NormalizedEntity`, `NormalizedRelationship` (post-validation)
- `validateExtraction(raw, sourceText)` — Zod + evidence substring check
- Relationship type-pair constraints validation

### 2b. Content Normalizer (`src/knowledge/extractor/normalise.ts`)
- `normalizeToolResult(toolName, result) → ExtractionInput`
- Per-tool adapters for: web_search, web_read, web_crawl, semantic_crawl, reddit, youtube, github, academic
- Strip irrelevant fields, normalize to text+url+metadata shape

### 2c. LLM Extraction (`src/knowledge/extractor/index.ts`)
- `KnowledgeGraphExtractor` class
- `extract(content, runId)` → entities + relationships
- Uses existing `DeepResearchLlmClient` from `src/research/llm/chat.ts`
- Or a simplified `KgLlmClient` wrapper (may be needed if DR client is too coupled)
- Prompt: entity extraction from text with evidence
- Parse + validate + apply confidence penalties for non-verbatim evidence

### 2d. Canonicalization (`src/knowledge/extractor/canonicalise.ts`)
- `canonicalize(entities, existingNodes)` → `(newNodes, merges)`
- Embedding-based lookup against `kg_embeddings` table
- Type-aware similarity thresholds (person/org 0.75, others 0.85)
- LLM judgment for close candidates
- Emits `NODE_ADDED` or `ENTITY_MERGED` events

### 2e. Event Version Adapters (`src/knowledge/extractor/versions/v1.ts`)
- `normalizeToLatest(event)` dispatches by `event_type + event_version`
- V1 is current; scaffolding for future versions

### 2f. Embeddings Store (`src/knowledge/store/embeddings.ts`)
- `storeEmbedding(objectId, objectType, model, embedding, contentHash)`
- `findSimilar(label, type, threshold)` — returns candidates
- Uses existing embedding provider from `src/rag/embedding.ts`

### Deliverables
- `src/knowledge/extractor/schemas.ts`
- `src/knowledge/extractor/normalise.ts`
- `src/knowledge/extractor/index.ts`
- `src/knowledge/extractor/canonicalise.ts`
- `src/knowledge/extractor/versions/v1.ts`
- `src/knowledge/store/embeddings.ts`
- Tests for extraction validation, canonicalization

**Review check:** Post-extraction validation works. Canonicalization correctly deduplicates.

---

## Phase 3: Projection Layer

**Goal:** Rebuild projection tables from the event log. Checkpoints enable incremental rebuilds.

### 3a. Projection Builder (`src/knowledge/store/projections.ts`)
- `rebuildProjection(opts)` — drop-and-refill inside transaction
- Event replay with `normalizeToLatest`
- Builds: `kg_nodes`, `kg_edges`, `kg_families`, `kg_sources`, `kg_node_families`, `kg_event_refs`
- Rollback semantics: skip `pure_run_local` events when `RUN_ROLLED_BACK` exists
- `cross_run_mutation` compensation handling

### 3b. Checkpoints (`src/knowledge/store/checkpoints.ts`)
- `createCheckpoint(eventCursor)` — save projection state
- `getLatestCompatibleCheckpoint(projectionVersion)` 
- `invalidateCheckpoints()` — on schema version change
- Genesis rebuild when no compatible checkpoint exists

### 3c. Projection Queries (`src/knowledge/store/projections.ts` — read path)
- `queryNodes(filters)` — with pagination
- `queryEdges(filters)` 
- `getNode(id)` — includes aliases
- `getEdgesForNode(nodeId, depth)`
- `queryFamilies(filters)`

### 3d. Rebuild Triggers
- Run completion (async after extractor)
- Every 500 events (configurable)
- 24h fallback timer
- On-demand via `knowledge_graph` action `rebuild`

### Deliverables
- `src/knowledge/store/projections.ts` (build + query)
- `src/knowledge/store/checkpoints.ts`
- Tests for rebuild, checkpoint, rollback semantics

**Review check:** Genesis rebuild produces correct output. Checkpoint incremental works. Rollback correctly excludes events.

---

## Phase 4: Family Manager

**Goal:** Two-pass classifier, solidification threshold, consolidation pass.

### 4a. Pass 1 Classifier (`src/knowledge/families/classifier.ts`)
- LLM-based classification of entities into families
- Accepts staged delta (current-run entities) + previous projection
- Top-K candidate families via embedding similarity
- Output: assignments + new candidates → queued in pending tables

### 4b. Solidification (`src/knowledge/families/classifier.ts` — Logic)
- `solidifyCandidates()` — checks AND threshold (≥2 runs, ≥5 entities)
- High-confidence single-run override logic
- Emits `FAMILY_CREATED` + `FAMILY_CLASSIFIED` events
- Cleans up pending tables

### 4c. Pass 2 Relations (`src/knowledge/families/relations.ts`)
- Runs every 5 runs or cross-family edge threshold
- Detects: adjacent, contradicts, parent/child, supersedes
- Temporal evidence requirement for `supersedes`
- Emits `FAMILY_RELATED`, `FAMILY_RELATION_REMOVED`

### 4d. Consolidation (`src/knowledge/families/consolidation.ts`)
- Weekly background pass
- Embedding similarity scan with ANN threshold (200 families)
- Auto-merge above confidence threshold
- Below threshold → `kg_family_merge_candidates`

### Deliverables
- `src/knowledge/families/classifier.ts`
- `src/knowledge/families/relations.ts`  
- `src/knowledge/families/consolidation.ts`
- Tests for solidification thresholds, pass 2 detection

**Review check:** Families correctly solidify after 2 runs. Supersedes requires temporal evidence.

---

## Phase 5: MCP Tools

**Goal:** All 10 graph tools registered and functional.

### 5a. Tool Registration
Each tool follows the pattern: standalone registration via `server.registerTool()` with Zod schema + handler (matching the patterns in `src/tools/standalone/`).

### 5b. Individual Tools

| # | Tool | File | Description |
|---|------|------|-------------|
| 1 | `knowledge_graph.ingest` | `src/tools/families/knowledgeGraph.ts` | Ingest text/URL, sync/async, idempotency |
| 2 | `knowledge_graph.query` | `src/tools/families/knowledgeGraph.ts` | Entity lookup, semantic search, traversal |
| 3 | `knowledge_graph.entity_lookup_batch` | `src/tools/families/knowledgeGraph.ts` | Resolve entity IDs → labeled nodes |
| 4 | `knowledge_graph.status` | `src/tools/families/knowledgeGraph.ts` | Health, run state, projection age |
| 5 | `knowledge_graph.rebuild` | `src/tools/families/knowledgeGraph.ts` | On-demand projection rebuild |
| 6 | `knowledge_graph.family_list` | `src/tools/families/knowledgeGraph.ts` | All families with stats + merge candidates |
| 7 | `knowledge_graph.family_get` | `src/tools/families/knowledgeGraph.ts` | Full family detail |
| 8 | `knowledge_graph.family_merge` | `src/tools/families/knowledgeGraph.ts` | Manual FAMILY_MERGED emission |
| 9 | `knowledge_graph.run_list` | `src/tools/families/knowledgeGraph.ts` | Filterable run listing |
| 10 | `knowledge_graph.run_rollback` | `src/tools/families/knowledgeGraph.ts` | Compensating-event rollback |

### Deliverables
- 10 tool files in `src/tools/`
- Registration in `src/server.ts`
- Tool tests

**Review check:** Each tool's input schema matches spec Section 4. Warnings included in all outputs.

---

## Phase 6: Deep Research Integration & Session Hook

**Goal:** KG extraction fires after deep research completes. Passive tool calls accumulate for batch extraction.

### 6a. KnowledgeGraphHook (`src/knowledge/hook.ts`)
- `KnowledgeGraphHook` class
- `onToolCall(toolName, args, result)` — passive capture
- `onDeepResearchComplete(runId, synthesisOutput)` — active extraction
- Hook failure isolation: never fail the original tool call
- Session accumulator logic

### 6b. Deep Research Wiring
- Modify `src/tools/deepResearch.ts` `handleStart`:
  - After orchestrator promise resolves:
  - Call `kgHook.onDeepResearchComplete(jobId, result)`
  - Updates `meta.knowledgeGraph` on result
- Modify `src/research/orchestrator.ts`:
  - After `run()` returns result: no changes needed if hook fires in `handleStart`

### 6c. Server Integration
- Modify `src/server.ts`:
  - Initialize `KnowledgeGraphHook` if config enabled
  - Pass hook to tool handlers via extra context
- Modify `src/tools/registry.ts`:
  - Accept optional `kgHook` parameter
  - Wrap handlers for passive capture
- Modify `src/index.ts`:
  - Startup recovery (flush stale extractions)

### 6d. Passive Capture Allowlist
- Configurable list of tool names (default from spec)
- Content scrubber pass before storing
- Dedup by `content_hash`

### Deliverables
- `src/knowledge/hook.ts`
- Modified `src/server.ts`
- Modified `src/tools/deepResearch.ts`
- Modified `src/tools/registry.ts`
- Modified `src/index.ts`
- Integration tests

**Review check:** Deep research completion triggers extraction. Passive calls accumulate correctly.

---

## Dependency Graph

```
Phase 1 (Foundation)
    ↓
Phase 2 (Extractor) ← depends on 1 (store, types, config)
    ↓
Phase 3 (Projection) ← depends on 1, 2 (events exist to project)
    ↓
Phase 4 (Families) ← depends on 3 (needs projection to read)
    ↓
Phase 5 (Tools) ← depends on 3, 4 (needs query + family APIs)
    ↓
Phase 6 (Integration) ← depends on 2, 3 (extractor + projection)
```

## Risk Items

1. **better-sqlite3 native addon** — already used, but need to verify it works with WAL mode in the existing setup
2. **LLM extraction quality** — prompt engineering critical; plan for prompt iteration
3. **Embedding provider availability** — canonicalization needs embeddings; graceful degradation if provider is down
4. **Projection rebuild performance** — with many events, rebuild could be slow; checkpoints mitigate this
5. **Zod v4 compatibility** — ensure all schemas use zod/v4 as the codebase does
