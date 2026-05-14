# V7.0.0 — Longitudinal Knowledge Graph

**Date:** 2026-05-15
**Status:** Approved, pending implementation plan
**Replaces:** V5.0.0 "Persistent Corpus Indexes" (retired — superseded by this design)

---

## Context

Version history to date:

| Version | Feature | Status |
|---|---|---|
| V4.0.0 | Deep Research Orchestration Engine | ✅ Shipped |
| V5.0.0 | Persistent Corpus Indexes | ❌ Retired — replaced by this design |
| V6.0.0 | HTTP Dashboard + Tailscale Integration | ✅ Shipped (undocumented in ROADMAP.md) |
| **V7.0.0** | **Longitudinal Knowledge Graph** | 📐 This spec |

The V5 "corpus indexes" abstraction is retired. The knowledge graph is strictly more capable: a current corpus is a projection of the event log, so building corpus indexes first and adding a graph layer later would mean two persistence abstractions for one underlying need. This design replaces both.

---

## What This Is

A persistent, event-sourced knowledge graph that accumulates longitudinal "micro-snapshots" of web discourse on a topic. Each research run (or batch of passive tool calls) captures the state of the web at a point in time. Runs accumulate into named **families** — clusters of related research. The graph grows over months and years, handling contradictions, redundancy, and coverage gaps structurally rather than flattening everything to uniform confidence.

**Nodes:** concepts, claims, sources, people, orgs, methods, datasets, works
**Edges:** supports | contradicts | explains | implements
**Families:** LLM-classified clusters of related runs; family taxonomy is itself event-sourced

---

## Architecture Overview

Three layers with clear separation:

```
search-mcp tool calls
        │
        ▼
KnowledgeGraphHook  ─── SessionAccumulator (pending_extraction SQLite)
        │
        ▼
KnowledgeGraphExtractor  ◄── LLM (structured extraction + canonicalization)
        │
        ▼
kg_events  (append-only SQLite, source of truth)
        │
        ▼
Projection Rebuild  ──► kg_nodes, kg_edges, kg_families  (read-optimised views)
        │
        ▼
MCP Tools  (graph_query, family_list, snapshot_list, ...)
```

LightRAG/RAG-Anything is **not** in the write path. It may be wired as a downstream read-side projection for hybrid retrieval in V7.1+, without touching the event store.

---

## Section 1: Core Data Model

### Event Store

Append-only SQLite table — the single source of truth. Every graph write is an event. No updates, no deletes.

```sql
CREATE TABLE kg_events (
  id            TEXT PRIMARY KEY,   -- ULID (sortable, no clock skew)
  timestamp     TEXT NOT NULL,      -- ISO-8601
  event_type    TEXT NOT NULL,      -- e.g. NODE_ADDED (clean, no version suffix)
  event_version INTEGER NOT NULL DEFAULT 1,
  run_id        TEXT NOT NULL,      -- atomic rollback unit
  entity_id     TEXT,
  entity_type   TEXT,               -- concept|claim|source|person|org|method|dataset|work
  payload       TEXT NOT NULL       -- JSON, schema per event_type+event_version
);

CREATE INDEX kg_events_run_id    ON kg_events(run_id);
CREATE INDEX kg_events_type      ON kg_events(event_type);
CREATE INDEX kg_events_entity_id ON kg_events(entity_id);
CREATE INDEX kg_events_timestamp ON kg_events(timestamp);
```

`run_id` is the unit of rollback. A deep_research call = one `run_id`. A batch of passive session calls = one `run_id`. There is no separate `snapshot_id` — a snapshot IS a run; the `SNAPSHOT_CREATED` event for a run carries its metadata and shares its `run_id`.

### Event Type Catalogue (v1)

| Event | Payload summary |
|---|---|
| `NODE_ADDED` | label, type, extraction_confidence, evidence, evidence_verbatim |
| `NODE_RELABELED` | old_label, new_label, reason |
| `NODE_ATTRIBUTE_UPDATED` | attribute, old_value, new_value |
| `EDGE_ADDED` | from_id, to_id, type, evidence_strength, evidence, evidence_verbatim |
| `EDGE_REMOVED` | edge_id, reason (tombstone — physical deletes never happen) |
| `CONFIDENCE_UPDATED` | entity_id, old_val, new_val, source_ids |
| `CONTRADICTION_FLAGGED` | entity_ids[], description |
| `ENTITY_MERGED` | from_id, into_id, reason, evidence |
| `ENTITY_SPLIT` | merged_event_id, reason, restored_label |
| `CLAIM_EXTRACTED` | raw_extraction, source_id, extractor_version |
| `SOURCE_RETRACTED` | source_id, reason |
| `SOURCE_CHANGED` | source_id, url, old_content_hash, new_content_hash |
| `EXTRACTION_FAILED` | input_summary, error, extractor_version |
| `SNAPSHOT_CREATED` | topic, query, source_count, session_mode |
| `FAMILY_CLASSIFIED` | entity_id, family_id, classifier_version, confidence |
| `FAMILY_CREATED` | label, description, classifier_version |
| `FAMILY_RELATED` | family_a, family_b, relation_type, evidence |
| `FAMILY_RELATION_REMOVED` | family_a, family_b, reason |
| `FAMILY_RENAMED` | old_label, new_label, reason |
| `FAMILY_MERGED` | from_id, into_id, reason |
| `RUN_ROLLED_BACK` | run_id (idempotency marker) |

**Versioning relationship:**
- `event_version` (on the row) = payload schema version; bumps when the JSON shape changes
- `extractor_version` (in the payload) = logic version; bumps when the extraction prompt changes without changing schema shape
- Extractor 1.x series → `event_version` 1; a prompt change that adds a required field bumps both
- Projection builder uses per-version adapter functions: `normalizeToLatest(event)` dispatches by `event_version`, returns a canonical shape. No conditionals in projection logic — add a new adapter per old version as versions accumulate.

**Cross-family edges:** not a distinct event type. `EDGE_ADDED` carries `from_id`/`to_id`; cross-family-ness is derived at projection time by joining against node family memberships.

### Projection Layer

Four SQLite tables rebuilt from events — never written to directly:

```sql
CREATE TABLE kg_nodes (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  canonical_label   TEXT,
  type              TEXT NOT NULL,
  extraction_confidence REAL,
  family_id         TEXT,
  aliases           TEXT,   -- JSON array of all labels merged into this node
  first_seen_run_id TEXT,
  last_updated      TEXT,
  metadata          TEXT    -- JSON
);

CREATE TABLE kg_edges (
  id               TEXT PRIMARY KEY,
  from_id          TEXT NOT NULL,
  to_id            TEXT NOT NULL,
  type             TEXT NOT NULL,
  evidence_strength REAL,
  evidence         TEXT,
  evidence_verbatim INTEGER,   -- boolean
  run_id           TEXT,
  created_at       TEXT
);

CREATE TABLE kg_families (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  description      TEXT,
  created_at       TEXT,
  last_activity    TEXT,
  run_count        INTEGER,   -- COUNT(DISTINCT run_id) from events
  related_families TEXT        -- JSON array of {family_id, relation_type}
);

CREATE TABLE kg_projection_snapshots (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  event_cursor TEXT NOT NULL,  -- last event id included in this snapshot
  nodes_json   TEXT NOT NULL,
  edges_json   TEXT NOT NULL
);
```

**Rebuild strategy:** drop-and-refill inside a single SQLite transaction. Readers see either the old complete projection or the new one — never a partially-built state. `ENTITY_MERGED` tombstones retire the `from_id` row during fill; `EDGE_REMOVED` tombstones exclude the edge row.

Rebuild always starts from the most recent `kg_projection_snapshots` entry + delta events since that cursor — never from genesis.

**Refresh triggers:** primary = run completion (graph is in a coherent state; mid-run projections are misleading). Fallback = daily or every 500 events for long-running or failed runs.

### Working-State Tables (not event-sourced)

```sql
-- Candidate families not yet solidified
CREATE TABLE kg_pending_families (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  description TEXT,
  entity_ids  TEXT,   -- JSON array
  run_ids     TEXT,   -- JSON array, distinct
  created_at  TEXT
);

-- Queued family assignments awaiting solidification
CREATE TABLE kg_pending_assignments (
  entity_id  TEXT,
  family_id  TEXT,
  run_id     TEXT,
  queued_at  TEXT
);

-- Durable session accumulator for passive tool calls
CREATE TABLE kg_pending_extractions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  run_id      TEXT,             -- null until batch flush
  tool_name   TEXT NOT NULL,
  content     TEXT NOT NULL,    -- normalised extraction input JSON
  source_url  TEXT,
  content_hash TEXT,            -- for dedup within session
  queued_at   TEXT NOT NULL
);
```

---

## Section 2: Extractor Pipeline

### LLM Extraction Schema

Entities carry `local_id`; relationships reference them. Confidence is decomposed into two orthogonal dimensions. Verbatim evidence is post-extraction validated.

```typescript
const EntityZ = z.object({
  local_id:              z.string(),   // pass-scoped, e.g. "e1"
  label:                 z.string(),
  type:                  z.enum([
    'concept', 'claim', 'source', 'person', 'org',
    'method', 'dataset', 'work'
  ]),
  extraction_confidence: z.number().min(0).max(1),
    // "how confident are you this entity is correctly identified from the source text,
    //  independent of source reliability"
  evidence:              z.string(),   // verbatim quote from source
  evidence_verbatim:     z.boolean(),  // set by extractor post-validation, not by LLM
});

const RelationshipZ = z.object({
  from_id:          z.string(),        // references EntityZ.local_id
  to_id:            z.string(),
  type:             z.enum(['supports', 'contradicts', 'explains', 'implements']),
  evidence_strength: z.number().min(0).max(1),
    // "how strongly does this evidence support the relationship claim"
  evidence:         z.string(),
  evidence_verbatim: z.boolean(),
});

const ExtractionResultZ = z.object({
  entities:      z.array(EntityZ),
  relationships: z.array(RelationshipZ),
});
```

**Post-extraction validation:**
1. All `from_id`/`to_id` in relationships must resolve to a `local_id` in the same pass
2. `evidence` is substring-checked against source text (light whitespace/punctuation normalisation). Mismatch sets `evidence_verbatim: false` and applies a confidence penalty (×0.6) — partial extraction is still useful, just flagged as unciteable.
3. Zod validation failures on the LLM response → `EXTRACTION_FAILED` event, not an exception.

### CLAIM_EXTRACTED → NODE_ADDED Pipeline

These are two distinct event types serving different purposes:

- `CLAIM_EXTRACTED` = raw extraction output + provenance + extractor_version. Always emitted, even when the entity already exists in the graph. Preserves full extraction history.
- `NODE_ADDED` = new canonical node created after canonicalization. Only emitted when the entity is new to the graph.

One `CLAIM_EXTRACTED` produces zero or more `NODE_ADDED` events (zero if the entity canonicalises to an existing node, one if it's new, more if the LLM extraction produced multiple distinct entities from one claim).

### Canonicalization

Alias-aware to prevent duplicates after merges. Each `kg_node` has an `aliases` column — all labels ever merged into this node via `ENTITY_MERGED` events.

1. Embed the new entity label
2. Search against current canonical labels AND all aliases (not just canonical labels)
3. Type-aware similarity thresholds:
   - `person`, `org`: 0.75 — short labels have higher false-merge risk; surface more candidates
   - all other types: 0.85
4. LLM judgment on candidates → `ENTITY_MERGED { from_id, into_id, reason, evidence }` if same, `NODE_ADDED` if new

**Bad-merge recovery:** `ENTITY_SPLIT { merged_event_id, reason, restored_label }` — carries the ID of the `ENTITY_MERGED` event it reverses. Projection rebuild resurrects the retired node and re-assigns its edges.

**Cost note:** canonicalization is currently one LLM call per entity-with-candidates. When real usage reveals cost from this, the lever is batching (one call per 50 candidates). Defer until cost is observed.

### Operating Modes

**Run mode** (deep_research): synchronous. One `run_id`. `SNAPSHOT_CREATED` emitted at start. Extraction runs after synthesis. Projection rebuild triggered on completion.

**Session mode** (passive tool calls): `kg_pending_extractions` is written to immediately on each tool call. Flushed on session close, 20 items, or 5 minutes idle — whichever comes first. All items in the batch share one `run_id`. Topic inferred by family classifier from accumulated content.

**Content dedup:** keyed by `content_hash`, not URL. Same URL returning different content → `SOURCE_CHANGED` event, not a skip. Identical hash within a session → skip extraction, bound LLM cost.

**Precedence:** if a passive tool call fires during an active run-mode session, it attaches to the active `run_id` rather than buffering in the session accumulator. Run-mode takes precedence for context coherence.

**Timeout handling:** `graph_ingest` with `sync: true` has a `timeout_ms` parameter (default 30 000). On timeout: returns `{ status: 'processing', run_id }`. Extraction continues in the background; the caller can poll `graph_status` or `snapshot_list`.

---

## Section 3: Family Manager

### Two-Pass Classifier

**Pass 1 — per run (assignment + creation):** runs after extraction events commit. Decides whether new entities belong to an existing family or should seed a new candidate. These are the same decision viewed from two angles and run together.

**Pass 2 — periodic / threshold-triggered (relation detection):** runs every 5 runs (configurable) or when cross-family edge counts cross a threshold. Gets a wider family slice than pass 1. Emits `FAMILY_RELATED`, `FAMILY_RELATION_REMOVED`, and merge proposals.

Relation detection is separated from assignment because: spurious relations fragment the graph globally; the classifier needs broader context than a single run provides; and failure modes differ (bad assignments are local and recoverable, bad relations are not).

The classifier always reads from the **previous** projection — projection rebuild is step 4, after both classifier passes. This is intentional: the classifier sees a consistent, slightly stale projection, never a partially-rebuilt one.

### Pass 1 Input / Output

```typescript
const FamilySummaryZ = z.object({
  id:          z.string(),
  label:       z.string(),
  description: z.string(),
  representative_entities: z.array(z.object({
    label: z.string(),
    type:  z.string(),   // included for disambiguation
  })).max(5),
});

// Top-K families by embedding similarity to run topic/query (default K=10)
const Pass1InputZ = z.object({
  run_entities:       z.array(z.object({
    entity_id:             z.string(),
    label:                 z.string(),
    type:                  z.string(),
    extraction_confidence: z.number(),
  })),
  run_metadata:       z.object({ topic: z.string(), query: z.string() }),
  candidate_families: z.array(FamilySummaryZ),
});

const Pass1OutputZ = z.object({
  assignments: z.array(z.object({
    entity_id: z.string(),
    family_id: z.string(),   // existing or provisional candidate ID
  })),
  new_candidates: z.array(z.object({
    provisional_id: z.string(),
    label:          z.string(),
    description:    z.string(),
    entity_ids:     z.array(z.string()),
  })),
});
```

### Solidification — AND Threshold

Pass 1 output is queued into `kg_pending_families` / `kg_pending_assignments`, not emitted as events. A candidate solidifies when:

```
distinct run_ids >= 2  AND  entity_count >= 5
```

**Why AND, not OR:** OR allows a single dense run to mint a family. A confidently-hallucinated cluster would solidify on first appearance. The OR failure mode it was avoiding — clusters trapped in pending because nobody re-ran the topic — is addressed instead by a single-run override: if all entities in the candidate have `extraction_confidence >= 0.85`, one run is sufficient.

Both thresholds are configurable in `KnowledgeGraphConfig.solidification`.

**On solidification, the event sequence is:**

1. `FAMILY_CREATED { family_id, label, description, classifier_version }`
2. `FAMILY_CLASSIFIED × N` — batch of all queued assignments for this family
3. `kg_pending_families` + `kg_pending_assignments` rows deleted

The event log reads as a coherent artifact: family exists, then everything decided to belong to it. No projection-masking. Entities with no solidified family have no `FAMILY_CLASSIFIED` event — absence is honest.

### Family Lifecycle Events

Family metadata is fully event-sourced — `kg_families` is a projection, not a primary store. `run_count` is computed as `COUNT(DISTINCT run_id)` for entities in the family. `related_families` materialises from `FAMILY_RELATED` minus `FAMILY_RELATION_REMOVED`.

```typescript
// FAMILY_RELATED relation_type semantics:
type FamilyRelationType =
  | 'adjacent'    // symmetric — related topic, no direction
  | 'contradicts' // symmetric — emit once, render bidirectionally
  | 'parent'      // directional — emit on the broader family
  | 'child'       // directional — emit on the narrower family; always paired with parent
  | 'supersedes'; // directional — requires temporal evidence (pass 2 only, not pass 1)
```

`parent`/`child` are always emitted as a pair pointing in opposite directions. `supersedes` requires that the classifier sees run timestamps showing the superseding family's claims post-date the superseded family's — this context is only available in pass 2.

### Consolidation Pass

Over-fragmentation is inevitable. The consolidation pass runs on a low-frequency background schedule (default: weekly). It performs a **full-population** embedding search — not top-K — to find families that have drifted apart in embedding space but should merge. Proposals above a confidence threshold are auto-merged; below it, they surface in `family_list.merge_candidates`. Manual trigger (`graph_consolidate`) ships in V7.1+.

---

## Section 4: MCP Tool Surface

### StructuredWarning

```typescript
type WarningCode =
  | 'PROJECTION_STALE'
  | 'EXTRACTION_PARTIAL'
  | 'EVIDENCE_UNVERIFIED'
  | 'FAMILY_PENDING'
  | 'ROLLBACK_FAMILY_REATTRIBUTED'
  | 'QUERY_TRUNCATED';

interface StructuredWarning {
  code:     WarningCode;
  severity: 'info' | 'warn' | 'error';
  message:  string;
  source?:  string;
}
```

### V7.0.0 Tool Set

| Tool | Description |
|---|---|
| `graph_ingest` | Ingest content into the knowledge graph |
| `graph_query` | Semantic search, entity lookup, relationship traversal |
| `entity_lookup_batch` | Resolve a list of entity IDs → labeled nodes in one call |
| `graph_status` | Health, event count, projection age, pending state, storage |
| `graph_rebuild` | On-demand projection rebuild |
| `family_list` | All families with stats and merge candidates (from background consolidation) |
| `family_get` | Full family detail: entities, sources, run history, related families |
| `family_merge` | Manually emit `FAMILY_MERGED` (remediation for mis-clustering) |
| `snapshot_list` | Filterable, paginated list of research run snapshots |
| `run_rollback` | Compensating-event rollback of a run, with dry-run mode |

**Deferred V7.1+:** `graph_query_temporal`, `graph_diff`, `graph_consolidate`, `graph_export`.

### Tool Schemas

**`family_list`:**

```typescript
// Input
{ cursor?: string, limit?: number }   // default limit 50

// Output
{
  families: {
    id: string, label: string, description: string,
    run_count: number, node_count: number, last_activity: string,
    related_families: { family_id: string, relation_type: string }[],
    merge_candidates: { family_id: string, label: string, confidence: number }[],
      // populated by background consolidation pass; empty until first consolidation runs
  }[],
  next_cursor: string | null,
  total:       number,
}
```

**`family_get`:**

```typescript
// Input
{ family_id: string, include_entities?: boolean, include_runs?: boolean }

// Output
{
  id: string, label: string, description: string,
  created_at: string, last_activity: string, run_count: number,
  related_families: { family_id: string, label: string, relation_type: string }[],
  merge_candidates: { family_id: string, label: string, confidence: number }[],
  entities?: { id: string, label: string, type: string, confidence: number }[],
  runs?:     { run_id: string, topic: string, timestamp: string }[],
}
```

**`graph_rebuild`:**

```typescript
// Input — none

// Output
{
  rebuilt_at:       string,   // ISO-8601
  events_processed: number,
  duration_ms:      number,
}
```

**`graph_ingest`:**

```typescript
// Input
{
  content:      { type: 'text', value: string }
               | { type: 'url',  value: string },
  topic?:       string,
  family_hint?: string,   // soft prior: pre-filters candidate families for classifier;
                          // not authoritative — classifier may still assign elsewhere
  sync?:        boolean,  // default true
  timeout_ms?:  number,   // default 30_000; on timeout returns status:'processing' + run_id
}

// Output (completed)
{
  status:       'completed',
  run_id:       string,
  entity_count: number,
  edge_count:   number,
  assignments:  { entity_id: string, label: string, type: string,
                  family_id: string | null }[],
  warnings:     StructuredWarning[],
}

// Output (timed out)
{ status: 'processing', run_id: string }
```

**`graph_query`:**

Precedence when multiple input fields are provided: `entity_id` > `entity_label` > `query`. Providing conflicting fields returns an error.

```typescript
// Input
{
  query?:          string,
  entity_id?:      string,
  entity_label?:   string,   // alias-aware; if >1 match, returns all + disambiguated:true
  family_id?:      string,
  entity_type?:    string,
  min_confidence?: number,
  run_id?:         string,   // restrict to entities introduced by this run
  run_id_after?:   string,   // restrict to entities introduced after this run (inclusive)
  depth?:          number,   // default 1, max 3
  limit?:          number,   // default 20
  cursor?:         string,
}

// Output
{
  nodes: {
    id: string, label: string, type: string,
    extraction_confidence: number, aliases: string[],
    family_id: string | null, first_seen_run_id: string,
  }[],
  edges: {
    id: string, from_id: string, to_id: string,
    type: string, evidence_strength: number,
    evidence: string, evidence_verbatim: boolean,
  }[],
  disambiguated:  boolean,
  next_cursor:    string | null,
  total:          number,
  meta: { query_ms: number, projection_age_ms: number },
}
```

**`entity_lookup_batch`:**

```typescript
// Input
{ entity_ids: string[] }    // max 100

// Output
{
  nodes:     { id, label, type, extraction_confidence, aliases, family_id }[],
  not_found: string[],
}
```

**`snapshot_list`:**

```typescript
// Input
{
  family_id?: string,
  topic?:     string,    // substring match
  after?:     string,    // ISO-8601
  before?:    string,
  limit?:     number,    // default 20
  cursor?:    string,
}

// Output
{
  snapshots: {
    run_id: string, topic: string, query: string,
    timestamp: string, entity_count: number, edge_count: number,
    family_ids: string[], session_mode: boolean,
  }[],
  next_cursor: string | null,
  total:       number,
}
```

**`run_rollback`:**

```typescript
// A single planned or applied compensation action
interface CompensationEvent {
  original_event_id:   string,
  original_event_type: string,
  compensation_type:   'EDGE_REMOVED' | 'NODE_ATTRIBUTE_UPDATED' | 'ENTITY_SPLIT' | 'FAMILY_REATTRIBUTED',
  description:         string,
}

// Input
{ run_id: string, dry_run?: boolean }   // dry_run default false

// Output
{
  status: 'completed' | 'dry_run' | 'already_rolled_back',
  compensated_event_count: number,
  compensation_plan:       CompensationEvent[],
  warnings:                StructuredWarning[],
    // ROLLBACK_FAMILY_REATTRIBUTED if rolled-back run birthed a surviving family
    // (family persists; provenance re-attributed to earliest surviving member run)
}
```

Idempotency: first compensation writes `RUN_ROLLED_BACK { run_id }`. Subsequent calls detect the marker and return `already_rolled_back` without double-compensating. `dry_run: true` never writes the marker.

**`family_merge`:**

```typescript
// Input
{ from_id: string, into_id: string, reason: string }

// Output — emits FAMILY_MERGED, triggers projection rebuild
{ merged_entity_count: number, warnings: StructuredWarning[] }
```

**`graph_status`:**

```typescript
{
  event_count:               number,
  last_projection_built:     string,   // ISO-8601
  projection_age_ms:         number,
  pending_family_count:      number,
  pending_assignment_count:  number,
  pending_extraction_count:  number,
  storage_bytes:             number,
  families:                  number,
  nodes:                     number,
  edges:                     number,
}
```

---

## Section 5: Deep Research Integration

### Configuration

Added to `ConfigManager` (same encrypted config file as all other V6 config):

```typescript
interface KnowledgeGraphConfig {
  enabled:   boolean;             // default false; requires HTTP_PORT
  dbPath?:   string;              // default ~/.cache/search-mcp/kg/kg.sqlite
  projection: {
    maxEvents: number;            // default 500
    maxAgeMs:  number;            // default 86_400_000 (24h)
  };
  solidification: {
    minRuns:                number;  // default 2
    minEntities:            number;  // default 5
    highConfidenceOverride: number;  // default 0.85
  };
  session: {
    maxBufferItems: number;          // default 20
    maxIdleMs:      number;          // default 300_000 (5 min)
  };
  consolidation: {
    cadenceMs: number;               // default 604_800_000 (7 days)
  };
}
```

KG is opt-in and disabled when `enabled: false` or `HTTP_PORT` is unset. All existing tool behaviour is unchanged when KG is disabled.

### KnowledgeGraphHook

`src/knowledge/hook.ts` wraps the MCP tool dispatcher:

```
tool call received
  │
  ├─ KG disabled? → pass through, no side effects
  │
  ├─ is deep_research?
  │     → create run_id, mark session as "run active"
  │     → research pipeline runs (unchanged)
  │     → after synthesis: extractor runs synchronously over synthesis output
  │     → family classifier pass 1
  │     → commit events in single transaction
  │     → trigger projection rebuild
  │     → clear "run active" flag
  │     → append KG metadata to ToolResult.meta.knowledgeGraph
  │
  └─ any other tool?
        → if "run active": attach to active run_id
        → else: write to kg_pending_extractions (durable), flush on session rules
```

Tool results are unchanged. KG events are side effects, transparent to the caller.

### deep_research Hook — Step by Step

1. Hook creates `run_id` (ULID), emits `SNAPSHOT_CREATED { topic, query, run_id, session_mode: false }`
2. Existing research pipeline runs: gap analysis, multi-backend discovery, synthesis — **unchanged**. In-memory `KnowledgeBase` and `ClaimEdge[]` in `src/research/` continue as fast local working state during the session.
3. After synthesis: `KnowledgeGraphExtractor.extract(synthesisOutput, runId)` runs synchronously. The synthesis output is the extraction target — it is the richest artifact, already containing all claims and findings in structured form.
4. Canonicalization runs over extracted entities against existing `kg_nodes`
5. Family classifier pass 1 runs
6. All events committed in a single SQLite transaction under `run_id`
7. Projection rebuild triggered
8. `deep_research` returns its normal result; KG metadata appended to `meta.knowledgeGraph`:
   ```typescript
   { run_id: string, entity_count: number, edge_count: number,
     family_assignments: { label: string, family_id: string | null }[] }
   ```

### Relationship to Existing src/research/ Structures

`KnowledgeBase` (`src/research/knowledge.ts`) and `ClaimEdge[]` (`src/research/state.ts`) are **not replaced** in V7.0.0. They remain as fast in-session working state for the research pipeline. The KG is the persistence layer; the in-memory structures are the computation layer. They serve different purposes and coexist. This keeps the integration boundary clean and the risk low.

### Session Accumulator Lifecycle

The `SessionAccumulator` maps to the MCP transport session:
- **HTTP transport:** session starts on connection, ends on close. Accumulator keyed by session ID.
- **stdio transport:** accumulator keyed by process lifetime; flushed on graceful shutdown.

On flush: all buffered results are batch-extracted under a single `run_id` tagged with `session_mode: true` in `SNAPSHOT_CREATED`. Topic is inferred by the family classifier from accumulated content.

### Not in V7.0.0

- Extraction from intermediate research steps (individual search results, crawl pages mid-run)
- Structured consumption of `ClaimEdge[]` as extractor input (optimisation)
- KG-aware gap analysis (using the graph to detect what's been researched vs. not) — major capability, V7.1+
- LightRAG as downstream read-side projection

---

## Roadmap Update

| Version | Feature | Status |
|---|---|---|
| V4.0.0 | Deep Research Orchestration Engine | ✅ Shipped |
| V5.0.0 | Persistent Corpus Indexes | ❌ Retired — replaced by V7.0.0 |
| V6.0.0 | HTTP Dashboard + Tailscale Integration | ✅ Shipped |
| **V7.0.0** | **Longitudinal Knowledge Graph** | 📐 Specced |
| V7.1+ | graph_consolidate, graph_query_temporal, graph_diff, graph_export, KG-aware gap analysis, LightRAG projection | 🔲 Planned |

---

## File Layout

```
src/knowledge/
  store/
    events.ts          -- kg_events table, append + query
    projections.ts     -- kg_nodes, kg_edges, kg_families rebuild
    pending.ts         -- pending_families, pending_assignments, pending_extractions
  extractor/
    index.ts           -- KnowledgeGraphExtractor
    normalise.ts       -- ToolResult<T> → ExtractionInput
    schemas.ts         -- Zod schemas: EntityZ, RelationshipZ, ExtractionResultZ
    canonicalise.ts    -- alias-aware entity resolution
    versions/
      v1.ts            -- normalizeToLatest adapter for event_version 1
  families/
    classifier.ts      -- pass 1 (assignment + creation)
    relations.ts       -- pass 2 (relation detection)
    consolidation.ts   -- background consolidation pass
  hook.ts              -- KnowledgeGraphHook (wraps tool dispatcher)
  config.ts            -- KnowledgeGraphConfig type + defaults
src/tools/
  graph-ingest.ts
  graph-query.ts
  entity-lookup-batch.ts
  graph-status.ts
  graph-rebuild.ts
  family-list.ts
  family-get.ts
  family-merge.ts
  snapshot-list.ts
  run-rollback.ts
```
