# Design Spec: Entity Extraction + Domain Router for Deep Research

**Date:** 2026-05-18
**Status:** Approved
**Scope:** Two standalone modules (`entityExtractor`, `domainRouter`) integrated into agent and pipeline strategies.

---

## 1. Problem Statement

The current deep-research system treats every query generically:

- **Agent strategy** (`AgentStrategy`) has hardcoded source-type hints in its system prompt ("For medical questions, include pubmed"), but the LLM must infer the domain from the query itself — leading to slow or incorrect first-step routing.
- **Pipeline strategy** (`PipelineStrategy`) always starts discovery with a default web search, regardless of whether the query is about a medical trial, a GitHub repo, or a current event.
- **Decomposition** (`ORCHESTRATOR_DECOMPOSE`) generates sub-questions from the raw query text without grounding in concrete entities, producing vague or redundant sub-questions.

LearningCircuit's `local-deep-research` solves this with:
1. **Entity extraction** (`BrowseCompQuestionGenerator._extract_entities`) — regex/LLM extraction of temporal, numerical, name, location, and descriptor entities, used to generate targeted search queries.
2. **Domain-aware routing** (`REACT_SYSTEM_PROMPT` tool-selection table) — a domain-to-backend mapping that sends medical queries to PubMed, scientific queries to arXiv, etc.

We will port both ideas into standalone, reusable TypeScript modules.

---

## 2. Goals

1. **Entity Extraction**: Extract concrete, searchable entities from any research query deterministically (no LLM required for the fast path).
2. **Domain Routing**: Classify the query domain and map it to ranked preferred backends, so both agent and pipeline strategies route intelligently on the first step.
3. **Integration**: Both modules must be usable by the agent strategy, pipeline strategy, and decomposition prompts without creating circular dependencies.
4. **Zero regressions**: Existing behavior remains unchanged when modules are not invoked.

---

## 3. Non-Goals

- Full NER (Named Entity Recognition) using spaCy or similar. We use lightweight regex + heuristics.
- LLM-based entity extraction as the default path. LLM fallback is optional and off by default.
- Replacing the existing `WORKER_AGENT_INVESTIGATE` prompt entirely. We augment it with structured inputs.
- UI changes. This is backend-only.
- Persistent storage of entity/router results. In-memory per-query only.

---

## 4. Architecture

```
User Query
    │
    ├─→ entityExtractor.extractEntities(query) ──→ ExtractedEntities
    │                                                  │
    ├─→ domainRouter.routeQuery(query, entities) ──→ DomainRoute
    │                                                  │
    │         ┌──────────────────────────────────────────┘
    │         │
    ▼         ▼
┌─────────────┐    ┌─────────────┐
│   Agent     │    │   Pipeline  │
│  Strategy   │    │  Strategy   │
│             │    │             │
│ ┌─────────┐ │    │ ┌─────────┐ │
│ │ System  │ │    │ │ Decomp  │ │
│ │ Prompt  │ │    │ │ Prompt  │ │
│ │injected │ │    │ │injected │ │
│ │entities │ │    │ │entities │ │
│ │ + route │ │    │ │ + route │ │
│ └─────────┘ │    │ └─────────┘ │
│             │    │             │
│ ┌─────────┐ │    │ ┌─────────┐ │
│ │ Initial │ │    │ │ Discover│ │
│ │ Queries │ │    │ │ Phase   │ │
│ │seeded   │ │    │ │prefers  │ │
│ │from     │ │    │ │route    │ │
│ │entities │ │    │ │backends │ │
│ └─────────┘ │    │ └─────────┘ │
└─────────────┘    └─────────────┘
```

---

## 5. Module 1: Entity Extractor

### 5.1 API

```ts
// src/research/entityExtractor.ts

export interface ExtractedEntities {
  temporal: string[];      // years, date ranges, months
  numerical: string[];     // stats, counts, percentages, units
  names: string[];         // proper nouns, orgs, products, people
  locations: string[];     // places, institutions, geographic features
  descriptors: string[];   // key topic terms (stopword-filtered)
}

/** Extract entities from a query using regex + heuristics. O(n) on query length. */
export function extractEntities(query: string): ExtractedEntities;

/** Expand "2018-2023" into ["2018","2019",...,"2023"]. */
export function expandTemporalRanges(entities: string[]): string[];

/** Generate search-query candidates from extracted entities. */
export function generateEntityBasedQueries(
  entities: ExtractedEntities,
  maxQueries?: number,
): string[];
```

### 5.2 Heuristic Patterns

| Category | Pattern | Example |
|----------|---------|---------|
| Temporal | `\b(19|20)\d{2}(?:\s*[-–]\s*(19|20)\d{2})?\b` | "2023", "2018–2023" |
| Numerical | `\b\d+(?:\.\d+)?(?:%\|ms\|MB\|km\|million\|billion)\b` | "84.5%", "300ms" |
| Names | Capitalized sequences of 2–4 words not starting a sentence | "Plastic Man", "Dartmouth College" |
| Locations | Capitalized word after preposition + location indicator | "in Pennsylvania", "at the Grand Canyon" |
| Descriptors | Lowercase content words (nouns, verbs, adjectives) after stopword removal | "fusion energy", "attention mechanism" |

### 5.3 Output Format

```ts
extractEntities("What is the latency of the new scheduler released by Google in 2024?")
// => {
//   temporal: ["2024"],
//   numerical: [],
//   names: ["Google"],
//   locations: [],
//   descriptors: ["latency", "scheduler", "released"]
// }
```

### 5.4 Query Generation

`generateEntityBasedQueries` produces candidates by:
1. Original query (always included)
2. Name + descriptor combinations (e.g. "Google scheduler")
3. Name + temporal (e.g. "Google 2024")
4. Descriptor-only for disambiguation (e.g. "scheduler latency 2024")

Deduplicated and capped at `maxQueries` (default 5).

---

## 6. Module 2: Domain Router

### 6.1 API

```ts
// src/research/domainRouter.ts

export type DomainCategory =
  | 'medical'
  | 'scientific'
  | 'technical'
  | 'current-events'
  | 'background-knowledge'
  | 'code'
  | 'community-opinion'
  | 'comparative'
  | 'how-to'
  | 'general';

export type SourceType =
  | 'web'
  | 'academic'
  | 'github'
  | 'reddit'
  | 'hackernews'
  | 'stackoverflow'
  | 'documentation'
  | 'news'
  | 'patent'
  | 'podcast'
  | 'producthunt'
  | 'youtube'
  | 'pubmed'
  | 'wikipedia';

export interface DomainRoute {
  category: DomainCategory;
  confidence: number;           // 0–1
  primaryBackends: SourceType[];
  secondaryBackends: SourceType[];
  reasoning: string;
}

/** Route a query to the best backends. Fast keyword path; optional LLM fallback. */
export function routeQuery(
  query: string,
  entities?: ExtractedEntities,
): DomainRoute;
```

### 6.2 Keyword Heuristic Mapping

| Domain | Keywords | Primary Backends | Secondary |
|--------|----------|------------------|-----------|
| medical | "treatment", "symptom", "clinical trial", "FDA", "drug" | pubmed, academic | web, wikipedia |
| scientific | "paper", "arxiv", "study", "hypothesis", "experiment" | academic, arxiv | web, github |
| technical | "API", "benchmark", "latency", "architecture" | github, documentation | academic, web |
| current-events | "today", "breaking", "just announced", "2024" | news, web | reddit, hackernews |
| background-knowledge | "what is", "define", "history of" | wikipedia, web | academic |
| code | "repo", "github", "npm", "library", "implementation" | github, stackoverflow | documentation, web |
| community-opinion | "reddit", "best", "vs", "review" | reddit, hackernews | youtube, web |
| comparative | "compare", "vs", "difference between" | web, reddit | academic, github |
| how-to | "how to", "tutorial", "guide", "setup" | documentation, stackoverflow | github, web |
| general | (fallback) | web | academic, wikipedia |

### 6.3 Confidence Scoring

- **Exact keyword match** in domain keyword list → +0.4 per match
- **Entity overlap** (e.g. temporal entities in current-events) → +0.2
- **Query prefix match** ("what is" → background-knowledge) → +0.3
- Cap at 1.0. If max confidence < 0.5, optionally call LLM for classification.

### 6.4 LLM Fallback (Optional)

If `confidence < 0.5` and the `ENABLE_DOMAIN_ROUTING_LLM_FALLBACK` env var is `true` and an LLM client is available, call `callWorker` with a lightweight classification prompt:

```
Classify this query into one category: medical, scientific, technical,
current-events, background-knowledge, code, community-opinion, comparative,
how-to, general. Return JSON: {"category": "...", "confidence": 0.0-1.0}
```

**Configuration**: `ENABLE_DOMAIN_ROUTING_LLM_FALLBACK` (default `false`) enables the LLM fallback path. When `true`, the system calls `callWorker` with `maxTokens: 500` and temperature `0.3`. If the call times out or errors, a warning is logged and the original heuristic classification result is used as the fallback.

**Performance note**: For ambiguous queries (confidence < 0.5), enabling the LLM fallback adds approximately 500–1000ms of latency. Keep this toggle off to preserve the fast path (sub-millisecond keyword heuristic).

---

## 7. Integration Plan

### 7.1 Agent Strategy (`src/research/strategies/agentStrategy.ts`)

**Changes:**
1. Import `extractEntities`, `routeQuery`, `generateEntityBasedQueries`.
2. In `analyze()`, before the ReAct loop:
   ```ts
   const entities = extractEntities(query);
   const route = routeQuery(query, entities);
   const seededQueries = generateEntityBasedQueries(entities, 3);
   ```
3. Inject into `buildSystemPrompt()`:
   - Add an `Extracted Entities` section to the system prompt.
   - Add a `Domain Classification` section with `primaryBackends`.
   - Pre-seed the first user message with `seededQueries` so the LLM starts from targeted queries instead of inventing its own.

### 7.2 Pipeline Strategy (`src/research/strategies/pipelineStrategy.ts`)

**Changes:**
1. In the decomposition phase, call `extractEntities(query)` and pass the result into the `ORCHESTRATOR_DECOMPOSE_V2` prompt.
2. In the discovery phase, use `routeQuery(query, entities)` to set the initial `preferredBackends` for the first discovery round.

### 7.3 Prompt Updates (`src/research/llm/prompts.ts`)

**New prompt:**
```ts
export const ORCHESTRATOR_DECOMPOSE_V2 = `...
Extracted entities from the query:
${JSON.stringify(entities, null, 2)}

Use these entities to ground your sub-questions. Each sub-question should
reference at least one extracted entity when relevant.
...`;
```

**Updated prompt:**
```ts
// WORKER_AGENT_INVESTIGATE — add domain route and entities preamble
`Query domain: ${route.category} (confidence: ${route.confidence})
Preferred source types: ${route.primaryBackends.join(', ')}
Extracted entities: ${JSON.stringify(entities)}

Plan a search strategy...`
```

### 7.4 Orchestrator (`src/research/orchestrator.ts`)

**Changes:**
- Optionally pre-extract entities in `run()` before strategy selection. If the query is short or entity-poor, skip extraction to save time.
- Pass `entities` and `route` into the `StrategyContext` so both strategies can access them.

---

## 8. Testing Plan

### 8.1 Unit Tests

**`test/research/entityExtractor.test.ts`** (~30 test cases)
- Temporal extraction: single year, year range, multiple years
- Numerical extraction: percentages, units, counts
- Name extraction: proper nouns, multi-word names, acronyms
- Location extraction: cities, countries, institutions
- Descriptor extraction: stopword filtering, multi-word descriptors
- `expandTemporalRanges`: "2018-2023" → 6 items
- `generateEntityBasedQueries`: deduplication, maxQueries cap

**`test/research/domainRouter.test.ts`** (~25 test cases)
- Keyword-based classification: one test per domain
- Confidence scoring: exact match vs partial match vs fallback
- Entity-influenced routing: temporal entities boost current-events
- LLM fallback path: mock LLM client returns classification
- Edge cases: empty query, very short query, ambiguous query

### 8.2 Integration Tests

**`test/research/agentStrategy.test.ts`** (augment existing)
- Verify that agent with entity extraction produces initial queries containing extracted entities.
- Verify that agent system prompt includes domain classification.

**`test/research/pipelineStrategy.test.ts`** (augment existing)
- Verify that pipeline discovery phase uses routed backends for the first round.

---

## 9. Performance & Budget

- `extractEntities`: O(n) regex scan, <1ms for typical queries.
- `routeQuery`: O(1) keyword lookup, <1ms for typical queries.
- Optional LLM fallback: ~1 worker call, ~500 tokens.
- No additional database queries, no network calls in the fast path.

---

## 10. Rollback Plan

Both modules are additive:
- Remove imports from `agentStrategy.ts` and `pipelineStrategy.ts` → revert to existing behavior.
- Delete `entityExtractor.ts` and `domainRouter.ts` → no other dependencies.
- Prompt changes are versioned (`ORCHESTRATOR_DECOMPOSE_V2` is new; old prompt remains).

---

## 11. Open Questions

1. Should `extractEntities` support non-English queries? The current regex patterns are English-centric.
2. Should extracted entities be persisted in `ResearchState` for later phases (e.g. gap analysis)?
3. Should the domain router learn from successful queries over time (adaptive routing)?

These are out of scope for v1 but noted for future enhancement.
