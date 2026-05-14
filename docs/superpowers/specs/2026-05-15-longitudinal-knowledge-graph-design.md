# V7.0.0 — Longitudinal Knowledge Graph

**Date:** 2026-05-15  
**Status:** Approved, pending implementation plan  
**Replaces:** V5.0.0 "Persistent Corpus Indexes" (retired — superseded by this design)

---

## Context

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

```
search-mcp tool calls
        │
        ▼
KnowledgeGraphHook  ─── SessionAccumulator (kg_pending_extractions SQLite)
        │
        ▼
KnowledgeGraphExtractor  ◄── LLM (structured extraction + canonicalization)
        │
        ▼
kg_events  (append-only SQLite, source of truth)
        │
        ▼
Projection Rebuild  ──► kg_nodes, kg_edges, kg_families, kg_sources, kg_node_families
        │
        ▼
MCP Tools  (graph_query, family_list, run_list, ...)
```

LightRAG/RAG-Anything is **not** in the write path. It may be wired as a downstream read-side projection for hybrid retrieval in V7.1+.

---

## Section 1: Core Data Model

### Event Store

Append-only SQLite table — the single source of truth. Every graph write is an event. No updates, no deletes.

```sql
CREATE TABLE kg_events (
  id            TEXT PRIMARY KEY,   -- ULID (sortable, no clock skew)
  timestamp     TEXT NOT NULL,      -- ISO-8601
  event_type    TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  run_id        TEXT NOT NULL,      -- atomic rollback unit
  batch_id      TEXT,               -- groups events in the same transaction
  actor         TEXT NOT NULL DEFAULT 'system',  -- system|user|classifier|rollback
  entity_id     TEXT,
  entity_type   TEXT,
  payload       TEXT NOT NULL,      -- JSON, schema per event_type+event_version
  payload_hash  TEXT                -- sha256(payload) for integrity checks
);

CREATE INDEX kg_events_run_id    ON kg_events(run_id);
CREATE INDEX kg_events_type      ON kg_events(event_type);
CREATE INDEX kg_events_entity_id ON kg_events(entity_id);
CREATE INDEX kg_events_timestamp ON kg_events(timestamp);
CREATE INDEX kg_events_batch_id  ON kg_events(batch_id);
```

`run_id` is the unit of rollback. A deep_research call = one `run_id`. A batch of passive session calls = one `run_id`. There is no separate `snapshot_id` — a snapshot IS a run.

**Concurrency:** SQLite WAL mode required. All event commits and projection rebuilds serialise through a single writer queue. Projection rebuild builds into temp tables inside a transaction, then swaps atomically. Busy timeout: 5 000 ms.

### Event Type Catalogue (v1)

IDs are explicit in payloads — every event that creates an entity, edge, family, or source includes its object ID in the payload. Do not rely on the `entity_id` column as the sole ID reference.

| Event | Payload summary | Rollback class |
|---|---|---|
| `RUN_STARTED` | run_id, topic, query, session_mode, artifact_paths | `audit_only` |
| `RUN_COMPLETED` | run_id, entity_count, edge_count, source_count, duration_ms | `audit_only` |
| `RUN_FAILED` | run_id, error_summary, extractor_version | `audit_only` |
| `PROJECTION_REBUILT` | event_cursor, duration_ms, projection_version, schema_version | `audit_only` |
| `NODE_ADDED` | **node_id**, label, type, extraction_confidence, source_id | `pure_run_local` |
| `NODE_RELABELED` | **node_id**, old_label, new_label, reason | `cross_run_mutation` |
| `NODE_METADATA_UPDATED` | **node_id**, field, old_value, new_value | `cross_run_mutation` |
| `EXTRACTION_CONFIDENCE_REVISED` | **node_id**, old_val, new_val, source_ids | `cross_run_mutation` |
| `EDGE_ADDED` | **edge_id**, from_id, to_id, type, evidence_strength, evidence, source_id | `pure_run_local` |
| `EDGE_REMOVED` | **edge_id**, reason | see note* |
| `RELATIONSHIP_STRENGTH_REVISED` | **edge_id**, old_val, new_val, source_ids | `cross_run_mutation` |
| `CONTRADICTION_FLAGGED` | claim_a_id, claim_b_id, contradiction_type, evidence_ids[], resolution_status | `pure_run_local` |
| `ENTITY_MERGED` | from_id, **into_id**, reason, evidence | `cross_run_mutation` |
| `ENTITY_SPLIT` | **split_node_id**, merged_event_id, reason, restored_label | `cross_run_mutation` |
| `CLAIM_EXTRACTED` | raw_extraction, **source_id**, extractor_version | `audit_only` |
| `EXTRACTION_FAILED` | input_summary, error_summary, extractor_version | `audit_only` |
| `SOURCE_ADDED` | **source_id**, url, canonical_url, domain, source_kind, content_hash, retrieved_at | `pure_run_local` |
| `SOURCE_CHANGED` | **source_id**, url, old_content_hash, new_content_hash, retrieved_at | `cross_run_mutation` |
| `SOURCE_RETRACTED` | **source_id**, reason_type, reason, observed_at | `cross_run_mutation` |
| `FAMILY_CLASSIFIED` | entity_id, **family_id**, classifier_version, confidence | `pure_run_local` |
| `FAMILY_CREATED` | **family_id**, label, description, classifier_version | see note† |
| `FAMILY_RELATED` | **relation_id**, family_a, family_b, relation_type, evidence | `pure_run_local` |
| `FAMILY_RELATION_REMOVED` | **relation_id**, reason | `cross_run_mutation` |
| `FAMILY_RENAMED` | **family_id**, old_label, new_label, reason | `cross_run_mutation` |
| `FAMILY_MERGED` | from_id, **into_id**, reason | `cross_run_mutation` |
| `RUN_ROLLED_BACK` | run_id | `audit_only` |

\*`EDGE_REMOVED` is `pure_run_local` if the edge was added in the same run; `cross_run_mutation` if it predates the run. Resolved at rollback time from the original edge's `run_id`.

†`FAMILY_CREATED` is `pure_run_local` if no subsequent run's entities adopt the family before rollback. If later runs have `FAMILY_CLASSIFIED` events pointing to the family, it becomes `cross_run_mutation` and requires compensation.

**Versioning:**
- `event_version` (on the row) = payload schema version; bumps when JSON shape changes
- `extractor_version` (in payload) = logic version; bumps when extraction prompt changes without changing schema
- Projection builder uses per-version adapter functions: `normalizeToLatest(event)` dispatches by `event_type + event_version`

**`SOURCE_RETRACTED` reason_type values:**
`publisher_retraction | content_removed | retrieval_failed | user_invalidated | duplicate | replaced | malicious | low_quality`

**Contradiction taxonomy:**
```typescript
type ContradictionType =
  | 'direct'               // mutually exclusive claims
  | 'temporal'             // true at different times
  | 'scope'                // different applicability domains
  | 'numeric'              // conflicting quantitative claims
  | 'source_disagreement'  // two sources report opposing facts
  | 'terminology';         // same label, different meaning

type ContradictionResolutionStatus =
  | 'unresolved' | 'resolved' | 'superseded' | 'source_error' | 'scope_distinction';
```

### Rollback Projection Semantics

| Class | Projection rule | Compensation needed? |
|---|---|---|
| `pure_run_local` | Projection ignores these events when `RUN_ROLLED_BACK { run_id }` exists | No |
| `cross_run_mutation` | Requires explicit compensation events before projection excludes them | Yes |
| `audit_only` | Always visible in event history; never projected to graph tables | No |

**Compensation required for `cross_run_mutation` events:**

| Original event | Compensation |
|---|---|
| `ENTITY_MERGED` (pre-existing `from_id`) | `ENTITY_SPLIT` — projection resurrects `from_id`, re-assigns pre-merge edges |
| `FAMILY_CREATED` (adopted by surviving runs) | `FAMILY_CLASSIFIED` with surviving run's run_id; family persists with re-attributed provenance |
| `FAMILY_CREATED` (zero surviving members) | No compensation; projection ignores via run filter |
| `SOURCE_CHANGED`, `SOURCE_RETRACTED` | Flagged for manual review; no automatic compensation |

**V7.0 ENTITY_SPLIT rule:** split restores the original node and its pre-merge edges. Evidence and aliases added to `into_id` after the merge remain on `into_id`. A `ROLLBACK_FAMILY_REATTRIBUTED` warning is emitted for any post-merge evidence that cannot be cleanly split. V7.1+ can accept `reattribute_event_ids[]` for explicit migration.

### Projection Layer

```sql
CREATE TABLE kg_nodes (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  canonical_label       TEXT,
  type                  TEXT NOT NULL,
  extraction_confidence REAL,
  primary_family_id     TEXT,   -- convenience; authoritative membership is kg_node_families
  aliases               TEXT,   -- JSON array; projected kg_aliases table deferred to V7.1+
  first_seen_run_id     TEXT,
  last_updated          TEXT,
  metadata              TEXT    -- JSON
);

CREATE TABLE kg_edges (
  id                TEXT PRIMARY KEY,
  from_id           TEXT NOT NULL,
  to_id             TEXT NOT NULL,
  type              TEXT NOT NULL,
  evidence_strength REAL,
  evidence          TEXT,
  evidence_verbatim INTEGER,   -- boolean
  source_id         TEXT,
  run_id            TEXT,
  created_at        TEXT
);

CREATE TABLE kg_families (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  description      TEXT,
  created_at       TEXT,
  last_activity    TEXT,
  run_count        INTEGER,
  related_families TEXT    -- JSON [{relation_id, family_id, relation_type}]
);

-- Multi-membership: authoritative family assignment per node
CREATE TABLE kg_node_families (
  node_id            TEXT NOT NULL,
  family_id          TEXT NOT NULL,
  confidence         REAL,
  is_primary         INTEGER NOT NULL DEFAULT 0,  -- exactly one row per node has is_primary=1
  run_id             TEXT,
  classifier_version TEXT,
  PRIMARY KEY (node_id, family_id)
);

-- Source provenance projection
CREATE TABLE kg_sources (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  canonical_url   TEXT,
  title           TEXT,
  domain          TEXT,
  source_kind     TEXT,   -- primary_doc|official_release|research_paper|documentation|
                          -- news|blog|forum|social|code_repo|package_registry|unknown
  authority_score REAL,   -- populated by future scoring pass; null until then
  run_id          TEXT NOT NULL,
  retrieved_at    TEXT NOT NULL,
  published_at    TEXT,           -- from source metadata if available
  content_hash    TEXT NOT NULL,  -- sha256 of normalised extracted content
  raw_hash        TEXT,           -- sha256 of raw response bytes
  tool_name       TEXT
);

-- Event-to-entity reference index (projected; enables fast audit trails)
CREATE TABLE kg_event_refs (
  event_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,   -- node|edge|family|source|run
  ref_id   TEXT NOT NULL
);
CREATE INDEX kg_event_refs_ref_id   ON kg_event_refs(ref_id);
CREATE INDEX kg_event_refs_event_id ON kg_event_refs(event_id);
```

**Rebuild strategy:** drop-and-refill inside a single SQLite transaction. Readers see either the old complete projection or the new one — never a partially-built state.

**Rebuild triggers:**
- Primary: run completion (`kg_runs.status → completed`)
- Fallback: every 500 events, or 24 hours (for long-running or failed runs)

**KG tools ignore incomplete runs** — projection tables reflect only runs with `status = completed | rolled_back`. Runs in any other status are invisible to read tools unless a debug flag is passed.

### Projection Checkpoints and Genesis Rebuild

```sql
CREATE TABLE kg_projection_checkpoints (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  event_cursor       TEXT NOT NULL,    -- ULID of last event included
  projection_version INTEGER NOT NULL, -- bumped when projection logic changes
  schema_version     INTEGER NOT NULL, -- bumped when table schema changes
  event_count        INTEGER NOT NULL,
  checksum           TEXT NOT NULL,    -- sha256(sorted canonical node+edge ids)
  compatible         INTEGER NOT NULL DEFAULT 1  -- 0 = stale/invalid
);
```

Normal rebuild: start from the latest checkpoint where `compatible = 1` and `projection_version` matches current code. If no compatible checkpoint exists, rebuild from genesis.

**Genesis rebuild is always available and must always work.** It is the escape hatch for projection bugs, schema migrations, and corrupted checkpoints. Projection code may never assume a checkpoint exists.

### Working-State Tables

```sql
-- Durable run lifecycle tracking
CREATE TABLE kg_runs (
  run_id         TEXT PRIMARY KEY,
  status         TEXT NOT NULL,   -- queued|extracting|canonicalizing|classifying|
                                  -- committed|projecting|completed|failed|rolled_back
  topic          TEXT,
  query          TEXT,
  session_mode   INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  failed_at      TEXT,
  last_error     TEXT,
  entity_count   INTEGER,
  edge_count     INTEGER,
  source_count   INTEGER,
  artifact_paths TEXT   -- JSON: {result_path, source_manifest_path, synthesis_path}
);

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
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  run_id       TEXT,             -- null until batch flush
  tool_name    TEXT NOT NULL,
  content      TEXT NOT NULL,    -- normalised extraction input JSON
  source_url   TEXT,
  content_hash TEXT,             -- sha256 of normalised content, for dedup
  queued_at    TEXT NOT NULL
);

-- Proposed family merges from consolidation (not events)
CREATE TABLE kg_family_merge_candidates (
  family_a              TEXT NOT NULL,
  family_b              TEXT NOT NULL,
  confidence            REAL,
  reason                TEXT,
  generated_at          TEXT NOT NULL,
  consolidation_version TEXT,
  PRIMARY KEY (family_a, family_b)
);

-- Embedding cache (not event-sourced; invalidated when label or model changes)
CREATE TABLE kg_embeddings (
  object_id       TEXT NOT NULL,
  object_type     TEXT NOT NULL,   -- node|family|alias
  embedding_model TEXT NOT NULL,
  embedding       BLOB NOT NULL,   -- raw float32 array
  content_hash    TEXT NOT NULL,   -- hash of text embedded; mismatch = stale
  created_at      TEXT NOT NULL,
  PRIMARY KEY (object_id, embedding_model)
);
```

---

## Section 2: Extractor Pipeline

### LLM Extraction Schema

Two schema levels: the **LLM output schema** (what the model returns) and the **internal normalised schema** (what is committed to events). `evidence_verbatim` is **never** in the LLM output — it is set post-extraction by the extractor after substring validation, not supplied by the model.

**LLM output schema:**

```typescript
const LLMEntityZ = z.object({
  local_id:              z.string(),   // pass-scoped, e.g. "e1"
  label:                 z.string(),
  type:                  z.enum([
    'concept', 'claim', 'source', 'person', 'org',
    'method', 'dataset', 'work'
  ]),
  extraction_confidence: z.number().min(0).max(1),
    // "how confident are you this entity is correctly identified from the source text,
    //  independent of source reliability"
  evidence:              z.string(),   // intended verbatim quote from source text
});

const LLMRelationshipZ = z.object({
  from_id:           z.string(),   // references LLMEntityZ.local_id
  to_id:             z.string(),
  type:              z.enum(['supports', 'contradicts', 'explains', 'implements']),
  evidence_strength: z.number().min(0).max(1),
    // "how strongly does this evidence support the relationship claim"
  evidence:          z.string(),
});

const LLMExtractionResultZ = z.object({
  entities:      z.array(LLMEntityZ),
  relationships: z.array(LLMRelationshipZ),
});
```

**Internal normalised schema (post-validation):**

```typescript
interface NormalizedEntity extends z.infer<typeof LLMEntityZ> {
  evidence_verbatim: boolean;  // set by substring check below
}
interface NormalizedRelationship extends z.infer<typeof LLMRelationshipZ> {
  evidence_verbatim: boolean;
}
```

**Post-extraction validation:**
1. All `from_id`/`to_id` in relationships must resolve to a `local_id` in the same pass
2. `evidence` substring-checked against source text (light whitespace/punctuation normalisation):
   - Match → `evidence_verbatim: true`
   - Mismatch → `evidence_verbatim: false`, `extraction_confidence` × 0.6
   - Non-verbatim entity: flagged as unciteable; may still create a node
   - Non-verbatim edge: `evidence_strength` downgraded; if **all** evidence for an edge is non-verbatim, strength is capped at 0.4
3. Zod validation failure on LLM response → `EXTRACTION_FAILED` event, not an exception. Payload stores only a sanitised error summary — never raw LLM output (which may be large or contain source verbatim text).

**Relationship type-pair constraints** (invalid pairs → warning + edge dropped):

| from type | to type | allowed edge types |
|---|---|---|
| source | claim | supports, contradicts |
| claim | claim | supports, contradicts, explains |
| work | method | implements |
| method | concept | implements, explains |
| *(others)* | *(others)* | any |

### CLAIM_EXTRACTED → NODE_ADDED Pipeline

- `CLAIM_EXTRACTED` = raw extraction output + provenance. Always emitted, even when the entity already exists. Preserves full extraction history.
- `NODE_ADDED` = new canonical node after canonicalization. Only emitted when the entity is new.

One `CLAIM_EXTRACTED` → zero or more `NODE_ADDED` events.

### Canonicalization

Alias-aware to prevent duplicates after merges. Each `kg_node` carries an `aliases` JSON column — all labels ever merged into this node via `ENTITY_MERGED`.

1. Embed the new entity label
2. Search `kg_embeddings` against canonical labels AND all aliases
3. Type-aware similarity thresholds: `person`/`org` → 0.75; all others → 0.85
4. LLM judgment on candidates → `ENTITY_MERGED` if same, `NODE_ADDED` if new

**Bad-merge recovery:** `ENTITY_SPLIT { split_node_id, merged_event_id, reason, restored_label }`. V7.0 projection rule: restores original node and its pre-merge edges. Post-merge evidence/aliases remain on `into_id`; a `ROLLBACK_FAMILY_REATTRIBUTED` warning is emitted for any post-merge evidence that cannot be cleanly split.

**Idempotency:** `graph_ingest` accepts an optional `idempotency_key`. Internal passive flushes derive one from `session_id + sorted_content_hash_list + flush_window`. If a non-failed run with the same key already exists, returns the existing `run_id` without re-ingesting.

### Temporal Attribution

Four timestamps are distinct and must not be conflated:

| Field | Meaning | Where stored |
|---|---|---|
| `run.started_at` | When the research run began | `kg_runs.started_at` |
| `source.retrieved_at` | When the source URL was fetched | `kg_sources.retrieved_at` |
| `source.published_at` | When the source was published (from metadata) | `kg_sources.published_at` |
| claim temporal scope | When the claim's subject applies | V7.1+ — not modelled in V7.0 |

In V7.0, `supersedes` family relations (pass 2 only) require temporal evidence at the source level: the superseding family's sources must have `published_at` (or `retrieved_at` as fallback) post-dating the superseded family's.

### Source Authority

`kg_sources.source_kind` classifies the source. `authority_score` is nullable in V7.0 — populated by a future scoring pass (V7.1+). Primary V7.0 use: when two claims contradict and their source_kinds differ (e.g. `official_release` vs `blog`), that context is available through `evidence_ids` in `CONTRADICTION_FLAGGED`. Automatic authority scoring is deferred.

### Passive Capture Allowlist

KG passive capture fires only for these tool categories (configurable):

**Captured by default:**
`web_search`, `web_read`, `web_crawl`, `semantic_crawl`, `semantic_youtube`, `semantic_reddit`, `academic_search`, `arxiv_search`, `hackernews_search`, `stackoverflow_search`, `github_repo`, `github_repo_file`, `github_repo_search`, `github_trending`, `semantic_github_code`, `reddit_search`, `reddit_comments`, `youtube_search`, `youtube_transcript`, `npm_search`, `pypi_search`, `producthunt_search`, `patent_search`, `podcast_search`

**Not captured:**
Config tools, dashboard API tools, Gmail/Calendar/Drive/Notion (user-private data), all `graph_*`/`family_*`/`run_*`/`entity_*` tools (prevents circular ingestion), any tool whose output triggers the content scrubber's secret/PII patterns.

Before writing to `kg_pending_extractions`, content passes through the existing `contentScrubber`. Detected secrets or PII suppress the extraction.

### Operating Modes

**Run mode** (deep_research): `kg_runs` row inserted with `status: 'extracting'` before anything else. `RUN_STARTED` emitted. After synthesis, extractor runs. On success: `RUN_COMPLETED` emitted, `kg_runs.status → 'completed'`. On failure: `RUN_FAILED` emitted, `kg_runs.status → 'failed'`.

**Session mode** (passive tool calls): `kg_pending_extractions` written immediately on each allowed tool call. Flushed on session close, 20 items, or 5 minutes idle. All items in the batch share one `run_id`.

**Content dedup:** keyed by `content_hash` of normalised extracted content — not raw bytes, not URL. Same URL + different content → `SOURCE_CHANGED`. Identical hash within session → skip.

**Precedence:** passive call during active run-mode → attaches to active `run_id`.

**Startup recovery:** on startup, scan `kg_pending_extractions` for rows older than `maxIdleMs`. Group by `session_id` and flush as recovery runs. `kg_runs` rows stuck in non-terminal status (`extracting`, `canonicalizing`, `classifying`, `projecting`) are marked `failed` with `last_error: 'process_restart'`.

**Hook failure isolation:**
- Passive capture failure: log warning + metric; never fail the tool call
- Explicit `graph_ingest` failure: structured error in tool result
- `deep_research` KG failure: append warning to `meta.knowledgeGraph`; return normal research result

---

## Section 3: Family Manager

### Two-Pass Classifier

**Pass 1 — per run:** runs after extraction events commit. Reads previous projection + current-run entities (passed as staged delta — does not wait for projection rebuild). Decides family assignment and seeds candidates.

**Pass 2 — periodic:** every 5 runs (global counter, V7.0 simplification) or when cross-family edge counts cross a threshold. Emits `FAMILY_RELATED`, `FAMILY_RELATION_REMOVED`, merge proposals. Separated from pass 1 because spurious relations fragment the graph globally and require wider context to assess.

The classifier always reads from the **previous** projection — projection rebuild is step 4, after both passes. Current-run entities are provided as an explicit staged delta.

### Pass 1 Input / Output

```typescript
const FamilySummaryZ = z.object({
  id:          z.string(),
  label:       z.string(),
  description: z.string(),
  representative_entities: z.array(z.object({
    label: z.string(),
    type:  z.string(),
  })).max(5),
});

const Pass1InputZ = z.object({
  run_entities:       z.array(z.object({
    entity_id:             z.string(),
    label:                 z.string(),
    type:                  z.string(),
    extraction_confidence: z.number(),
  })),
  run_metadata:       z.object({ topic: z.string(), query: z.string() }),
  candidate_families: z.array(FamilySummaryZ),  // top-K by embedding similarity, default K=10
});

const Pass1OutputZ = z.object({
  assignments: z.array(z.object({
    entity_id: z.string(),
    family_id: z.string(),
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

Pass 1 output is queued into `kg_pending_families`/`kg_pending_assignments`, not emitted as events. A candidate solidifies when:

```
distinct run_ids >= 2  AND  entity_count >= 5
```

**High-confidence single-run override** — one run is sufficient **only if all hold:**
- All entities: `extraction_confidence >= 0.85`
- `evidence_verbatim` ratio >= 0.7
- At least 3 distinct source IDs in the run
- `entity_count >= 5`

Note: `extraction_confidence` is extraction quality, not source reliability. A high-confidence extraction from a single unreliable source can still satisfy this check. The multi-source requirement reduces but does not eliminate the risk. Multi-run threshold is the safer default path.

**On solidification:**
1. `FAMILY_CREATED { family_id, label, description, classifier_version }`
2. `FAMILY_CLASSIFIED × N` (batch for all queued assignments)
3. `kg_pending_families` + `kg_pending_assignments` rows deleted

Event log is clean: family exists, then entities belong to it. Entities without a solidified family have no `FAMILY_CLASSIFIED` event — absence is honest.

### Multi-Membership

Entities can belong to multiple families. `kg_nodes.primary_family_id` is a convenience column. Authoritative membership is `kg_node_families` (one row per `(node_id, family_id)` pair; `is_primary = 1` on exactly one row per node). `FAMILY_CLASSIFIED` events are emitted for each assignment — an entity may have multiple events pointing to different families.

### Family Lifecycle Events

```typescript
type FamilyRelationType =
  | 'adjacent'    // symmetric
  | 'contradicts' // symmetric
  | 'parent'      // directional; emit on broader family
  | 'child'       // directional; always paired with parent
  | 'supersedes'; // directional; temporal evidence required (pass 2 only)
```

`FAMILY_RELATED` and `FAMILY_RELATION_REMOVED` both reference a stable `relation_id` from the original `FAMILY_RELATED` event.

**`FAMILY_MERGED` is one-way in V7.0.** There is no `FAMILY_SPLIT`. The `family_merge` tool accepts `dry_run: true` as a safety check. Merged families cannot be split (V7.1+).

### Consolidation Pass

Low-frequency background schedule (default: weekly). Scans for merge candidates via embedding similarity.

**Scale guard:** full-population pairwise similarity is O(n²). Below 200 families: fine. Above that threshold, switch to ANN/HNSW with candidate blocking. V7.0 implementation must enforce this threshold; consolidation code should guard against unchecked O(n²) paths at runtime.

Proposals above confidence threshold → auto-merged (`FAMILY_MERGED` emitted). Below threshold → inserted into `kg_family_merge_candidates`, surfaced in `family_list.merge_candidates`.

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
  | 'QUERY_TRUNCATED'
  | 'RUN_INCOMPLETE'
  | 'SOURCE_RETRACTED'
  | 'CONSOLIDATION_PENDING';

interface StructuredWarning {
  code:     WarningCode;
  severity: 'info' | 'warn' | 'error';
  message:  string;
  source?:  string;
}
```

All graph read tools include `warnings: StructuredWarning[]` in their output.

### V7.0.0 Tool Set

| Tool | Description |
|---|---|
| `graph_ingest` | Ingest content into the knowledge graph |
| `graph_query` | Semantic search, entity lookup, relationship traversal |
| `entity_lookup_batch` | Resolve a list of entity IDs → labeled nodes |
| `graph_status` | Health, run state, projection age, storage |
| `graph_rebuild` | On-demand projection rebuild |
| `family_list` | All families with stats and merge candidates |
| `family_get` | Full family detail: entities, sources, run history, relations |
| `family_merge` | Manually emit `FAMILY_MERGED` |
| `run_list` | Filterable, paginated list of research runs |
| `run_rollback` | Compensating-event rollback with dry-run mode |

**Deferred V7.1+:** `graph_query_temporal`, `graph_diff`, `graph_consolidate`, `graph_export`.

### Tool Schemas

**`graph_ingest`:**

```typescript
// Input
{
  content:          { type: 'text', value: string } | { type: 'url', value: string },
  topic?:           string,
  family_hint?:     string,
  sync?:            boolean,      // default true
  timeout_ms?:      number,       // default 30_000
  idempotency_key?: string,
}

// Output (completed)
{
  status:       'completed',
  run_id:       string,
  entity_count: number,
  edge_count:   number,
  assignments:  { entity_id: string, label: string, type: string, family_id: string | null }[],
  warnings:     StructuredWarning[],
}

// Output (timed out / sync:false)
{ status: 'processing', run_id: string }
```

Timeout does not lose the job. Run row in `kg_runs` persists; caller polls `graph_status` or `run_list`.

**`graph_query`:**

Exactly **one** of `entity_id`, `entity_label`, or `query` must be provided. Zero or more than one returns a validation error.

```typescript
// Input
{
  query?:          string,
  entity_id?:      string,
  entity_label?:   string,    // alias-aware; >1 match → all returned + disambiguated:true
  family_id?:      string,
  entity_type?:    string,
  min_confidence?: number,
  run_id?:         string,    // restrict to entities introduced by this run
  after?:          string,    // ISO-8601; entities first seen after this timestamp
  before?:         string,    // ISO-8601; entities first seen before this timestamp
  depth?:          number,    // default 1, max 3
  limit?:          number,    // default 20
  cursor?:         string,
}

// Output
{
  nodes: {
    id: string, label: string, type: string,
    extraction_confidence: number, aliases: string[],
    primary_family_id: string | null, first_seen_run_id: string,
  }[],
  edges: {
    id: string, from_id: string, to_id: string,
    type: string, evidence_strength: number,
    evidence: string, evidence_verbatim: boolean,
  }[],
  disambiguated:  boolean,
  next_cursor:    string | null,
  total:          number,
  warnings:       StructuredWarning[],
  meta: { query_ms: number, projection_age_ms: number },
}
```

**`entity_lookup_batch`:**

```typescript
// Input
{ entity_ids: string[] }   // max 100

// Output
{
  nodes:     { id, label, type, extraction_confidence, aliases, primary_family_id }[],
  not_found: string[],
  warnings:  StructuredWarning[],
}
```

**`run_list`:**

```typescript
// Input
{
  family_id?: string,
  topic?:     string,    // substring match
  status?:    string,
  after?:     string,    // ISO-8601
  before?:    string,
  limit?:     number,    // default 20
  cursor?:    string,
}

// Output
{
  runs: {
    run_id: string, topic: string, status: string,
    started_at: string, completed_at: string | null,
    entity_count: number, edge_count: number,
    family_ids: string[], session_mode: boolean,
  }[],
  next_cursor: string | null,
  total:       number,
  warnings:    StructuredWarning[],
}
```

**`graph_status`:**

```typescript
{
  event_count:               number,
  last_projection_built:     string | null,
  projection_age_ms:         number,
  projection_version:        number,
  pending_family_count:      number,
  pending_assignment_count:  number,
  pending_extraction_count:  number,
  oldest_pending_extraction: string | null,
  storage_bytes:             number,
  families:                  number,
  nodes:                     number,
  edges:                     number,
  active_runs:               number,
  failed_runs:               number,
  last_run_error:            string | null,
  last_consolidation_at:     string | null,
  write_queue_depth:         number,
}
```

**`graph_rebuild`:**

```typescript
// Input
{
  full?:          boolean,   // default false; force genesis rebuild
  from_event_id?: string,    // rebuild from this event cursor
  validate?:      boolean,   // default false; verify checksum after rebuild
}

// Output
{
  rebuilt_at:       string,
  events_processed: number,
  duration_ms:      number,
  from_genesis:     boolean,
  checksum?:        string,   // present when validate:true
}
```

**`family_list`:**

```typescript
// Input
{ cursor?: string, limit?: number }   // default 50

// Output
{
  families: {
    id: string, label: string, description: string,
    run_count: number, node_count: number, last_activity: string,
    related_families: { relation_id: string, family_id: string, relation_type: string }[],
    merge_candidates: { family_id: string, label: string, confidence: number }[],
  }[],
  next_cursor: string | null,
  total:       number,
  warnings:    StructuredWarning[],
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
  related_families: { relation_id: string, family_id: string, label: string, relation_type: string }[],
  merge_candidates: { family_id: string, label: string, confidence: number }[],
  entities?: { id: string, label: string, type: string, confidence: number }[],
  runs?:     { run_id: string, topic: string, started_at: string, status: string }[],
  warnings:  StructuredWarning[],
}
```

**`run_rollback`:**

```typescript
type RollbackClass = 'pure_run_local' | 'cross_run_mutation';

interface CompensationEvent {
  original_event_id:   string,
  original_event_type: string,
  rollback_class:      RollbackClass,
  compensation_type:   'ENTITY_SPLIT' | 'FAMILY_REATTRIBUTED' | 'FAMILY_RETIRED' | 'SOURCE_MANUAL_REVIEW',
  description:         string,
}

// Input
{ run_id: string, dry_run?: boolean }

// Output
{
  status:                  'completed' | 'dry_run' | 'already_rolled_back',
  compensated_event_count: number,
  compensation_plan:       CompensationEvent[],
  warnings:                StructuredWarning[],
}
```

`pure_run_local` events require no compensation — they vanish from projection once `RUN_ROLLED_BACK` is emitted. Only `cross_run_mutation` events appear in `compensation_plan`.

**`family_merge`:**

```typescript
// Input
{ from_id: string, into_id: string, reason: string, dry_run?: boolean }

// Output (dry_run:true)
{ dry_run: true, affected_entity_count: number, affected_run_count: number }

// Output (dry_run:false)
{ merged_entity_count: number, warnings: StructuredWarning[] }
```

One-way and irreversible in V7.0. Always run with `dry_run: true` first.

---

## Section 5: Deep Research Integration

### Configuration

```typescript
interface KnowledgeGraphConfig {
  enabled:   boolean;             // default false
  dbPath?:   string;              // default ~/.cache/search-mcp/kg/kg.sqlite
  projection: {
    maxEvents: number;            // default 500
    maxAgeMs:  number;            // default 86_400_000 (24h)
  };
  solidification: {
    minRuns:           number;    // default 2
    minEntities:       number;    // default 5
    highConfidenceOverride: number;  // default 0.85
    minVerbatimRatio:  number;    // default 0.7 (single-run override)
    minSourceCount:    number;    // default 3 (single-run override)
  };
  session: {
    maxBufferItems: number;       // default 20
    maxIdleMs:      number;       // default 300_000 (5 min)
    captureStdio:   boolean;      // default true
  };
  consolidation: {
    cadenceMs:    number;         // default 604_800_000 (7 days)
    annThreshold: number;         // default 200; above this family count, use ANN
  };
}
```

**KG vs HTTP_PORT:**
- `enabled: true` is independent of `HTTP_PORT` — graph tools work in both HTTP and stdio modes
- Dashboard admin UI requires `HTTP_PORT`
- Passive stdio session accumulation requires `enabled: true` AND `session.captureStdio: true`

### KnowledgeGraphHook

```
tool call received
  │
  ├─ KG disabled? → pass through
  │
  ├─ tool in passive allowlist?
  │     → run active: attach to active run_id
  │     → no active run: write to kg_pending_extractions, flush on session rules
  │     → KG failure: log warning + metric; NEVER fail the tool call
  │
  ├─ is deep_research?
  │     → insert kg_runs row (status: 'extracting'), emit RUN_STARTED
  │     → research pipeline runs (unchanged)
  │     → after synthesis: KnowledgeGraphExtractor.extract(synthesisOutput, runId)
  │     → family classifier pass 1
  │     → commit events in single SQLite transaction; update kg_runs → 'completed'; emit RUN_COMPLETED
  │     → trigger projection rebuild (async; does not block return)
  │     → on KG failure: update kg_runs → 'failed'; emit RUN_FAILED; append warning to meta.knowledgeGraph; return normal research result
  │     → clear run-active flag
  │
  └─ is graph/family/run/entity tool?
        → execute directly; KG failure = structured error in result
```

### deep_research Hook — Step by Step

1. Create `run_id` (ULID), insert `kg_runs` row (`status: 'extracting'`), emit `RUN_STARTED { run_id, topic, query, session_mode: false, artifact_paths }`
2. Existing research pipeline: gap analysis, multi-backend discovery, synthesis — **unchanged**. In-memory `KnowledgeBase` and `ClaimEdge[]` in `src/research/` remain as fast working state.
3. After synthesis: `KnowledgeGraphExtractor.extract(synthesisOutput, runId)`. Synthesis is the extraction target — richest available artifact.
4. Canonicalization over extracted entities
5. Family classifier pass 1
6. All events committed in single SQLite transaction; `kg_runs.status → 'committed'`; `RUN_COMPLETED` emitted
7. Projection rebuild triggered (async)
8. `deep_research` returns normal result; KG metadata in `meta.knowledgeGraph`:
   ```typescript
   {
     run_id:             string,
     entity_count:       number,
     edge_count:         number,
     family_assignments: { label: string, family_id: string | null }[],
     warnings:           StructuredWarning[],
   }
   ```

### Session Accumulator Lifecycle

- **HTTP transport:** accumulator keyed by session ID; flushed on connection close
- **stdio transport:** accumulator keyed by process lifetime; flushed on graceful shutdown

On flush: all buffered results batch-extracted under one `run_id` with `session_mode: true`.

**Startup recovery:** scan `kg_pending_extractions` for rows older than `maxIdleMs`. Group by `session_id`; flush as recovery runs. `kg_runs` rows stuck in non-terminal status marked `failed` with `last_error: 'process_restart'`.

### Not in V7.0.0

- Extraction from intermediate research steps (individual search results, crawl pages)
- Structured consumption of `ClaimEdge[]` as extractor input — V7.1+
- KG-aware gap analysis — V7.1+
- LightRAG as downstream read-side projection — V7.1+
- Structured claim modeling (subject/predicate/object, temporal scope, modality) — V7.1+
- Source snapshot versioning (source identity vs content snapshot distinction) — V7.1+
- Projected `kg_aliases` table (V7.0: JSON column on `kg_nodes`) — V7.1+
- `kg_edge_evidence` (separate many-to-one evidence table) — V7.1+
- Automatic authority scoring — V7.1+

---

## Roadmap Update

| Version | Feature | Status |
|---|---|---|
| V4.0.0 | Deep Research Orchestration Engine | ✅ Shipped |
| V5.0.0 | Persistent Corpus Indexes | ❌ Retired — replaced by V7.0.0 |
| V6.0.0 | HTTP Dashboard + Tailscale Integration | ✅ Shipped |
| **V7.0.0** | **Longitudinal Knowledge Graph** | 📐 Specced |
| V7.1+ | graph_consolidate, graph_query_temporal, graph_diff, graph_export, KG-aware gap analysis, structured claim modeling, source snapshot versioning, LightRAG projection | 🔲 Planned |

---

## File Layout

```
src/knowledge/
  store/
    events.ts          -- kg_events table, append + query
    projections.ts     -- kg_nodes, kg_edges, kg_families, kg_sources, kg_node_families, kg_event_refs rebuild
    runs.ts            -- kg_runs lifecycle
    checkpoints.ts     -- kg_projection_checkpoints, genesis rebuild logic
    pending.ts         -- kg_pending_families, kg_pending_assignments, kg_pending_extractions
    candidates.ts      -- kg_family_merge_candidates
    embeddings.ts      -- kg_embeddings cache
  extractor/
    index.ts           -- KnowledgeGraphExtractor
    normalise.ts       -- ToolResult<T> → ExtractionInput
    schemas.ts         -- LLMEntityZ, LLMRelationshipZ, NormalizedEntity, ...
    canonicalise.ts    -- alias-aware entity resolution
    temporal.ts        -- temporal attribution helpers
    versions/
      v1.ts            -- normalizeToLatest adapter for event_version 1
  families/
    classifier.ts      -- pass 1 (assignment + creation)
    relations.ts       -- pass 2 (relation detection)
    consolidation.ts   -- background consolidation pass
  hook.ts              -- KnowledgeGraphHook
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
  run-list.ts
  run-rollback.ts
```
