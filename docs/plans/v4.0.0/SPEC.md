# V4.0.0: Deep Research Orchestration Engine

> **Status**: Spec draft · **Priority**: High  
> **Depends On**: V3.3.x (existing search/crawl/RAG tools)  
> **Replaces**: V4.0.0 "persistent corpus indexes" → pushed to V5.0.0

---

## 1. Purpose

The Deep Research Orchestration Engine is a new MCP tool (`deep_research`) that answers complex, open-ended, multi-source questions through adaptive search, extraction, evidence tracking, and source-weighted synthesis.

It is **not** a browsing agent that accumulates raw text. It is a **research state machine**: decomposing the user query, discovering sources broadly, extracting evidence deeply, maintaining bounded structured state, identifying gaps, and synthesizing findings with explicit confidence and uncertainty.

**Design goal**: Produce high-quality research outputs while keeping context usage, cost, and epistemic drift under control.

---

## 2. Core Principles

| Principle                              | Description                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Evidence quality over volume**       | More sources are not inherently better unless they improve confidence, resolve contradictions, or fill a gap.                                                                  |
| **Raw output is ephemeral**            | Crawl results, search pages, extracted docs are processed immediately, distilled into structured notes, then discarded from active context.                                    |
| **Structured state is durable memory** | Claims, evidence summaries, source metadata, confidence, contradictions, open questions — kept in a normalized schema, not a growing text document.                            |
| **Adaptive planning**                  | The initial decomposition is a starting hypothesis, revised after seeing the source landscape (Phase 1.5).                                                                     |
| **Confidence propagation**             | Confidence flows from source → claim → synthesis. The system distinguishes strong evidence, plausible claims, anecdotal reports, disputed points, and unsupported speculation. |
| **Model routing by cognitive load**    | Cheap models for search/extraction, mid-tier for planning/gap analysis, frontier optional for final synthesis.                                                                 |

---

## 3. High-Level Pipeline

```
Phase 1:  Query Understanding & Decomposition
    │
Phase 1.5: Taxonomy Revision After Early Discovery
    │
Phase 2:  Parallel Broad Discovery (cheap workers)
    │
Phase 3:  Deep Sequential Extraction (cheap workers)
    │
Phase 4:  Structured State Update & Evidence Normalization
    │
Phase 5:  Adaptive Gap Filling ←──┐
    │                              │ (loop)
Phase 6:  State Audit & Citation   │
          Integrity Check          │
    │                              │
    └── if gaps remain & budget ───┘
    │
Phase 7:  Source-Weighted Synthesis
```

The system loops between Phase 5 and Phase 6 until budget exhausted, answer complete, or user stops early.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  deep_research MCP tool                                  │
│  (src/tools/deepResearch.ts)                             │
├─────────────────────────────────────────────────────────┤
│  Orchestrator (src/research/orchestrator.ts)             │
│  ┌────────────┬───────────┬───────────┬───────────────┐ │
│  │ Decomposer │ Discovery │Extraction │  Gap Analysis  │ │
│  │  (phase 1) │ (phase 2) │ (phase 3) │  (phase 5)     │ │
│  ├────────────┼───────────┼───────────┼───────────────┤ │
│  │  Auditor   │ Synthesizer│ State    │  Budget        │ │
│  │  (phase 6) │ (phase 7)  │ Engine   │  Tracker       │ │
│  └────────────┴───────────┴───────────┴───────────────┘ │
├─────────────────────────────────────────────────────────┤
│  Existing tool layer (web_search, web_crawl,             │
│  semantic_crawl, academic, github, reddit, etc.)         │
└─────────────────────────────────────────────────────────┘
```

### Module Map

| Module                   | File                           | Responsibility                                                                        |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| **Types**                | `src/research/types.ts`        | All research state types, schemas                                                     |
| **State Engine**         | `src/research/state.ts`        | Structured state: add findings, update confidence, detect contradictions, gap queries |
| **Budget Tracker**       | `src/research/budget.ts`       | Token/source/time budget tracking, stop heuristics                                    |
| **Decomposer**           | `src/research/decomposer.ts`   | Query type classification, sub-question generation, initial plan                      |
| **Taxonomy**             | `src/research/taxonomy.ts`     | Phase 1.5: revise sub-question tree after early discovery                             |
| **Discovery**            | `src/research/discovery.ts`    | Phase 2: parallel multi-backend search, source scoring/dedup                          |
| **Extraction**           | `src/research/extraction.ts`   | Phase 3: top-N source crawl, passage retrieval, claim extraction, note distillation   |
| **Gap Analysis**         | `src/research/gapAnalysis.ts`  | Phase 5: identify gaps, generate targeted follow-up tasks                             |
| **Audit**                | `src/research/audit.ts`        | Phase 6: citation integrity, confidence calibration, drift detection                  |
| **Synthesizer**          | `src/research/synthesizer.ts`  | Phase 7: narrative answer with confidence labels                                      |
| **Progressive Renderer** | `src/research/progress.ts`     | Stream intermediate state as structured progress updates                              |
| **Orchestrator**         | `src/research/orchestrator.ts` | State machine driving phases 1–7 with loop control                                    |
| **Tool**                 | `src/tools/deepResearch.ts`    | MCP tool registration, input/output schema                                            |
| **Config**               | `src/config.ts` (amend)        | Deep research config: model routing, defaults, budget limits                          |
| **Health**               | `src/health.ts` (amend)        | Probe for deep_research capability                                                    |

---

## 5. Data Model

### 5.1 ResearchState — The Durable Object

```typescript
interface ResearchState {
  /** Original user query */
  query: string;

  /** Current taxonomy revision */
  taxonomy: ResearchTaxonomy;

  /** All sub-questions */
  subQuestions: SubQuestion[];

  /** Source registry — every source ever considered */
  sources: SourceRegistry;

  /** Extracted findings */
  findings: Finding[];

  /** Contradictions detected */
  contradictions: Contradiction[];

  /** Open questions / gaps */
  openQuestions: OpenQuestion[];

  /** Gap resolution status */
  gaps: GapRecord[];

  /** Claim relationship graph */
  claimGraph: ClaimEdge[];

  /** Current phase in the pipeline */
  currentPhase: ResearchPhase;

  /** Budget tracking */
  budget: BudgetState;

  /** Flags */
  flags: {
    taxonomyRevised: boolean;
    audited: boolean;
    loopCount: number;
  };
}
```

### 5.2 SubQuestion

```typescript
interface SubQuestion {
  id: string;
  text: string;
  classification: QueryClassification;
  evidenceType: EvidenceType;
  preferredSources: SourceType[];
  toolStrategy: ToolStrategy[];
  freshnessRequirement: FreshnessRequirement;
  failureModes: string[];
  budgetPriority: number; // 1 (highest) to 5
  status:
    | 'pending'
    | 'in_progress'
    | 'sufficient'
    | 'low_confidence'
    | 'contradictory'
    | 'unresolvable';
}
```

### 5.3 SourceRegistry

```typescript
interface SourceEntry {
  id: string;
  title: string;
  url: string;
  author?: string;
  organization?: string;
  publishedDate?: string;
  accessDate: string;
  sourceType: SourceType;
  sourceConfidencePrior: number; // 0–1
  domain: string;
  isPrimary: boolean;
  relevantSubQuestions: string[];
  extractionStatus: 'pending' | 'extracted' | 'failed';
  limitations?: string;
  subQuestionId: string;
}
```

### 5.4 Finding

```typescript
interface Finding {
  id: string;
  claim: string;
  normalizedClaim: string;
  subQuestionIds: string[];
  sourceIds: string[];
  evidenceSummary: string;
  evidenceExcerpt?: string;
  evidenceDirectness: EvidenceDirectness;
  confidence: number; // 0–1
  confidenceLabel: ConfidenceLabel;
  corroboratingSourceIds: string[];
  contradictingSourceIds: string[];
  caveats?: string;
  scope?: string;
  freshnessSensitive: boolean;
  lastUpdated: string;
  claimType: ClaimType; // primary | secondary | anecdotal
  createdAt: string;
}
```

### 5.5 Contradiction

```typescript
interface Contradiction {
  id: string;
  claimA: string;
  claimB: string;
  sourceIdsA: string[];
  sourceIdsB: string[];
  contradictionType: ContradictionType;
  likelyExplanation?: string;
  resolutionStatus: 'unresolved' | 'partially_resolved' | 'resolved' | 'apparent_only';
  confidenceImpact: number; // how much it lowers confidence in related claims
  followUpSearchRecommended?: string;
}
```

### 5.6 Confidence Model

```typescript
type ConfidenceLabel =
  | 'well-corroborated' // 0.85–1.0
  | 'likely' // 0.70–0.85
  | 'plausible-but-thin' // 0.50–0.70
  | 'speculative' // 0.30–0.50
  | 'unsupported-or-disputed'; // below 0.30
```

Confidence combines:

- Source confidence prior (by source type)
- Evidence directness (direct > near-direct > secondary > anecdotal > speculative)
- Corroboration count across independent sources
- Specificity of claim
- Recency (if freshness-sensitive)
- Whether contradictory evidence exists

### 5.7 BudgetProfile

```typescript
type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive';

interface BudgetProfile {
  depth: ResearchDepth;
  maxSources: number;
  maxExtractions: number;
  maxGapLoops: number;
  maxToolCalls: number;
  maxTokens: number;
  maxTimeMs: number;
  costModel: 'cheap' | 'mixed' | 'frontier';
}
```

| Profile      | Sources | Extractions | Gap Loops | Cost Model |
| ------------ | ------- | ----------- | --------- | ---------- |
| `quick`      | 5–10    | 5           | 1         | cheap      |
| `standard`   | 15–25   | 15          | 2         | mixed      |
| `deep`       | 30–60   | 30          | 3         | mixed      |
| `exhaustive` | 60+     | 50          | 5         | frontier   |

---

## 6. Phase Details

### Phase 1: Query Understanding & Decomposition

**Model**: Mid-tier (orchestrator)

Classifies query type and generates 3–7 sub-questions.

Query classifications:

- `explainer` — understand a topic
- `comparative` — tradeoffs, differences, rankings
- `technical` — mechanisms, implementation details, architecture
- `applied-practitioner` — what people actually use in production
- `historical-timeline` — how something evolved
- `market-ecosystem` — current players, products, adoption
- `literature-review` — academic/research-backed coverage
- `decision-support` — recommendation based on constraints

Each sub-question gets: text, classification, evidence type, preferred source types, tool strategy, freshness requirement, failure modes, budget priority.

### Phase 1.5: Taxonomy Revision

**Model**: Mid-tier

After first discovery pass, reviews whether original decomposition fits the source landscape. Prevents early framing bias. Outputs: updated sub-question tree, revised source strategy, newly discovered research angles.

### Phase 2: Parallel Broad Discovery

**Model**: Cheap workers (one per sub-question, parallelizable)

Each worker performs broad retrieval using assigned tools:

- Multi-backend web search
- RRF-fused results
- Academic search (ArXiv, Semantic Scholar)
- GitHub repository/code search
- Reddit/HN/forum search
- Official documentation search
- News search for time-sensitive topics

Returns 5–10 source candidates per sub-question with: title, URL, snippet, source type, estimated quality, estimated relevance, freshness, reason for inclusion.

Dedup at three levels: URL-level, document-level, claim-level. Preserves diversity (academic + implementation + official docs + practitioner).

### Phase 3: Deep Sequential Extraction

**Model**: Cheap worker

Selects top-N sources per budget profile. For each source:

1. Fetch via `web_crawl` (Crawl4AI) or `web_read` (Readability fallback)
2. Clean boilerplate, navigation, cookie banners
3. Chunk semantically (heading/section-aware)
4. Run passage retrieval against relevant sub-questions
5. Extract claim-level findings
6. Distill into structured `Finding` objects
7. **Discard raw crawl output**

### Phase 4: Structured State Update

Findings are added to `ResearchState`. The state engine:

- Deduplicates similar claims
- Attaches confidence scores
- Links corroborating/contradicting sources
- Updates sub-question status
- Identifies potential contradictions

### Phase 5: Adaptive Gap Filling

**Model**: Mid-tier for analysis, cheap workers for execution

Orchestrator reviews state and identifies gaps:

- Unanswered sub-questions
- Low-confidence claims needing corroboration
- Contradictions requiring resolution
- Missing source types
- Missing recency

Generates targeted follow-up tasks. Loops through Phase 2–5 while:

- Budget remains
- Expected information gain justifies cost
- Pool not saturated

### Phase 6: State Audit & Citation Integrity

**Model**: Mid-tier

Checks:

- Every claim has source support
- Source IDs correctly attached
- Confidence labels match evidence quality
- Duplicate claims merged
- Contradictions accurately represented
- Caveats not dropped
- Weak claims not laundered through repetition
- Source diversity adequate
- Taxonomy hasn't drifted

### Phase 7: Source-Weighted Synthesis

**Model**: Mid-tier or frontier

Transforms structured state into narrative answer:

- Direct answer with confidence labels
- Key findings by theme
- Tradeoffs and implications
- Contradictions and uncertainties
- Source-quality notes
- What remains unknown
- Recommendations (if decision-support)

---

## 7. Model Routing

| Cognitive Task                     | Model Tier          |
| ---------------------------------- | ------------------- |
| Search query generation            | cheap               |
| Tool execution                     | cheap               |
| Result triage                      | cheap               |
| Boilerplate removal                | cheap               |
| Chunk-level extraction             | cheap               |
| First-pass note updates            | cheap               |
| Query decomposition                | mid-tier            |
| Taxonomy revision                  | mid-tier            |
| Gap analysis                       | mid-tier            |
| Contradiction classification       | mid-tier            |
| State audit                        | mid-tier            |
| Synthesis planning                 | mid-tier            |
| Confidence calibration             | mid-tier            |
| Final synthesis (normal)           | mid-tier            |
| Complex synthesis                  | frontier (optional) |
| Ambiguous contradiction resolution | frontier (optional) |
| High-stakes reasoning              | frontier (optional) |

Each model sees only what it needs. Cheap workers never receive full research state. Gap analysis receives compressed state. Synthesizer receives citation map + findings, not raw crawl output.

---

## 8. Progressive Rendering

The tool streams structured progress updates during execution:

```typescript
type ResearchProgress =
  | { phase: 'decomposition'; plan: ResearchPlan }
  | { phase: 'discovery'; sources: { subQuestionId: string; count: number }[] }
  | { phase: 'extraction'; completed: number; total: number }
  | { phase: 'findings'; findings: Finding[] }
  | { phase: 'taxonomy_revision'; taxonomy: ResearchTaxonomy }
  | { phase: 'contradictions'; contradictions: Contradiction[] }
  | { phase: 'gap_analysis'; gaps: GapRecord[] }
  | { phase: 'synthesis'; outline: string }
  | { phase: 'limitations'; limitations: string[] }
  | { phase: 'complete' };
```

In MCP, this is delivered via JSON-RPC notifications or accumulated in the tool response's `meta.timeline` field.

**MVP approach**: Accumulate progress updates in an array on the result metadata, not streaming notifications. This is simpler and works with all MCP clients.

```typescript
interface ResearchMeta {
  tool: 'deep_research';
  durationMs: number;
  timestamp: string;
  timeline: ResearchProgress[];
}
```

---

## 9. Budgeting & Stopping

Stopping heuristics (checked after each gap loop):

1. No high-priority open gaps remain
2. Most major claims are corroborated (confidence >= "likely")
3. Contradictions resolved or clearly explained
4. New sources mostly duplicate known claims
5. Final answer can satisfy requested depth
6. Remaining uncertainty can be clearly communicated

---

## 10. Failure Mode Safeguards

| Failure Mode                       | Mitigation                                                 |
| ---------------------------------- | ---------------------------------------------------------- |
| Context swamp                      | Raw results ephemeral; structured notes durable            |
| Early framing bias                 | Phase 1.5 taxonomy revision                                |
| Source laundering                  | Claim-level confidence + periodic audit                    |
| Citation drift                     | Citation integrity check before synthesis                  |
| Over-deduplication                 | Preserve source diversity; dedup at claim level            |
| False confidence from weak sources | Corroboration requires independent evidence                |
| Overweighting academic sources     | Separate source confidence, evidence directness, relevance |
| Overweighting anecdotes            | Label anecdotal clearly; seek corroboration                |
| Stale information                  | Recency policy + claim-level TTL                           |
| Hallucinated notes                 | Every finding requires source linkage                      |
| Overstated certainty               | Confidence labels flow into synthesis                      |

---

## 11. MVP Scope

The MVP includes all 7 phases but simplifies:

- **State engine**: Core CRUD on findings, sources, contradictions. No full claim graph — lightweight adjacency tracking.
- **Discovery**: Wraps existing web_search, academicSearch, redditSearch, hackernewsSearch, github tools. No vertical adapters yet.
- **Extraction**: Uses semantic_crawl and web_crawl. Simple claim extraction rule-based (not LLM).
- **Gap analysis**: Rule-based gap detection (missing sources, low confidence). LLM gap analysis deferred.
- **Audit**: Source existence check, confidence label match. No full cross-claim audit.
- **Synthesis**: Template-based narrative builder with confidence prose.
- **Model routing**: Single model (orchestrator's model) for all cognitive tasks. Multi-model routing deferred.

### MVP Priority Order

1. Types + State Engine
2. Budget Tracker
3. Query Decomposer (template-based, not LLM)
4. Discovery (wraps existing tools)
5. Extraction (wraps semantic_crawl)
6. Gap Analysis (simple rule-based)
7. State Audit (basic)
8. Progressive Renderer
9. Synthesizer (template-based)
10. Tool registration + wiring

---

## 12. Config Changes

New config section in `SearchConfig`:

```typescript
interface DeepResearchConfig {
  enabled: boolean; // default false
  defaultDepth: ResearchDepth; // default 'standard'
  maxDepth: ResearchDepth; // default 'deep'
  maxToolCalls: number; // default 200
  maxTokens: number; // default 500_000
  maxTimeMs: number; // default 300_000 (5 min)
}
```

Env vars: `DEEP_RESEARCH_ENABLED`, `DEEP_RESEARCH_DEFAULT_DEPTH`, etc.

---

## 13. Estimated Scope

| Layer             | Files                          | Est. LOC |
| ----------------- | ------------------------------ | -------- |
| Types             | `src/research/types.ts`        | ~200     |
| State Engine      | `src/research/state.ts`        | ~300     |
| Budget Tracker    | `src/research/budget.ts`       | ~100     |
| Decomposer        | `src/research/decomposer.ts`   | ~200     |
| Taxonomy          | `src/research/taxonomy.ts`     | ~100     |
| Discovery         | `src/research/discovery.ts`    | ~350     |
| Extraction        | `src/research/extraction.ts`   | ~350     |
| Gap Analysis      | `src/research/gapAnalysis.ts`  | ~200     |
| Audit             | `src/research/audit.ts`        | ~150     |
| Synthesizer       | `src/research/synthesizer.ts`  | ~300     |
| Progress          | `src/research/progress.ts`     | ~80      |
| Orchestrator      | `src/research/orchestrator.ts` | ~400     |
| Tool registration | `src/tools/deepResearch.ts`    | ~200     |
| Config (amend)    | `src/config.ts`                | ~30      |
| Health (amend)    | `src/health.ts`                | ~20      |
| Tests             | `test/research/`               | ~600     |

**Total MVP**: ~3,180 LOC new code  
**Full V4.0.0**: ~3,580 LOC (with multi-model routing, enhanced audit)

---

## 14. Integration Points

| Existing Component                                   | Integration                                          |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `web_search`                                         | Discovery phase — multi-backend search               |
| `web_crawl` / `web_read`                             | Extraction phase — fetch source content              |
| `semantic_crawl`                                     | Extraction phase — chunk + embed + retrieve passages |
| `academicSearch`                                     | Discovery phase — academic source discovery          |
| `arxivSearch`                                        | Discovery phase — direct ArXiv search                |
| `hackernewsSearch`                                   | Discovery phase — HN discovery                       |
| `redditSearch` / `redditComments`                    | Discovery + extraction — practitioner signals        |
| `githubRepo` / `githubRepoFile` / `githubRepoSearch` | Discovery — code/implementation sources              |
| `stackoverflowSearch`                                | Discovery — Q&A evidence                             |
| `health_check`                                       | Report deep_research health                          |
| `config.ts`                                          | Add DeepResearchConfig                               |
| `src/server.ts`                                      | Register deep_research tool                          |
