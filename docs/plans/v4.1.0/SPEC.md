# V4.1.0: Agent-Enhanced Deep Research Engine

> **Status**: Spec — Ready for implementation · **Priority**: High
> **Depends On**: V4.0.0 (existing deep research pipeline, implemented), V4.1.0 Sprint 0 substrate (completed)
> **Replaces**: V4.0.0 EDA loop + gap analysis + synthesis (incrementally)

---

## 1. Purpose

V4.0.0 established a deep research state machine with phase-gated pipeline. V4.1.0 transforms it into an **agent-guided research engine** by replacing the rigid phase pipeline with a tight search/read/reason loop, stateful action constraints, and gap-driven iteration.

The core change is architectural: move from "phase pipeline with gap patches" to "bounded action loop with explicit agenda, gates, memory, and trace."

### Key Gaps Addressed

| Gap                      | Current Behavior                                               | Target Behavior                                                                        |
| ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Synthesis quality**    | JSON bullet points (`findings: string[]`)                      | Flowing prose with inline `[N]` citation markers                                       |
| **Gap lifecycle**        | `gapTargets: string[]` — untyped, no lifecycle                 | Typed `GapTarget` with activation/resolution/defer/abandon                             |
| **Action selection**     | Scattered mutable booleans (`gates.allowX = false`)            | `computeGates()` from state/budget/evaluation each iteration                           |
| **Search persistence**   | Same sub-questions re-queried on failure                       | Alternative queries, backend pivoting, failure mode tracking                           |
| **Citation chasing**     | Not done                                                       | Extraction flags citations, schedules follow-up discovery                              |
| **Source ranking**       | Implicit single score                                          | Dual scores: read-priority vs evidence-weight                                          |
| **Knowledge injection**  | Raw findings dumped into LLM context                           | Selected, compressed `KnowledgeItem` with token budget                                 |
| **Trace/Diary/Progress** | Two drifting systems (diary in state, progress in progress.ts) | Unified `TraceEvent` substrate                                                         |
| **Output format**        | Structured JSON + bullet points                                | Narrative prose with inline citations, structured fields for confidence/contradictions |

---

## 2. Core Architecture

### Loop

```
loop:
  activeTarget ← agenda.nextTarget(step)
  gates ← computeGates(state, budget, lastEvaluation, sourceStats, activeTarget)
  action ← llm.decide(state, gates, activeTarget)
  result ← execute(action)
  evaluation ← evaluate(result, activeTarget)
  agenda.update(evaluation, activeTarget)
  trace.append(action, result, evaluation)
  knowledge.ingest(result)
  step++
until: budget exhausted OR no open targets remain
```

### Five Supporting Systems

| System            | Module             | Owns                                                                                                                 |
| ----------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Agenda**        | `agenda.ts`        | Gap lifecycle: open → active → resolved/abandoned. Max N attempts, dedup, cycle detection.                           |
| **ActionGates**   | `actionGates.ts`   | `computeGates()` from state/budget/failures. Budget-aware. Reset per gap, not globally.                              |
| **Knowledge**     | `knowledge.ts`     | `KnowledgeItem` selection + compression. Bounded by token budget. `serp_hypothesis` not promoted without extraction. |
| **Trace**         | `trace.ts`         | One event substrate for diary + progress + timeline. Factual only (no hidden reasoning). MCP-safe public timeline.   |
| **SourceRanking** | `sourceRanking.ts` | Dual scores: read-priority (what to read next) vs evidence-weight (how much to trust). Frequency ≠ truth.            |

### Canonical Types

```
EvaluationResult:
  pass: boolean           // Did the answer meet the bar?
  score: number           // 0-1
  missingDimensions: []   // What dimensions are still uncovered
  unsupportedClaims: []   // Claims without source backing
  contradictions: []
  requiredNextEvidence: []
  confidence: number
  reason: string          // Human-readable summary

FailureMode:
  'insufficient_sources' | 'low_authority_sources' |
  'contradiction_unresolved' | 'question_misread' | 'too_broad' |
  'stale_information' | 'missing_primary_source' |
  'extraction_failed' | 'overconfident_synthesis'
```

---

## 3. Sprint Breakdown

### Sprint 0: Substrate (Done)

5 new modules + 6 modified files. Foundation for all subsequent sprints.

**Delivered**: `agenda.ts`, `actionGates.ts`, `trace.ts`, `knowledge.ts`, `sourceRanking.ts` + updated types, prompts, synthesizer, state.

### Sprint 1: Working Loop with Gates + Agenda

Replace the existing EDA loop's gap management and action selection.

**Changes**:

- Wire `Agenda` into `ResearchOrchestrator` — replace `gapTargets: string[]` with `Agenda.nextTarget()/activate()/resolve()/defer()/abandon()`
- Wire `computeGates()` into the EDA loop — replace scattered `gates.allowX` booleans
- Refactor EDA loop to operate on ONE active target at a time (not batch all sub-questions)
- Add `generate_queries` action option (basic — existing query expansion, not LLM rewriting yet)
- Add `Trace.append()` calls at key loop boundaries
- Add `KnowledgeBase.ingestFindings()` after extraction phase
- Add `SourceRanking.rankSource()` to discovery sort
- Update `ORCHESTRATOR_DECIDE` prompt to include gate info + active gap context

**Outcome**: The system no longer re-queries the same way on failure. Gaps have lifecycle. Gates prevent obvious waste. Source ordering improves.

**Files touched**: `orchestrator.ts`, `state.ts`, `discovery.ts`, `gapAnalysis.ts`, `llm/prompts.ts`, `llm/chat.ts`

### Sprint 2: Query Rewriting + Source Ranking (P4 + P9)

Improve source quality through intentional query generation and dual-score ranking.

**Changes**:

- Rich query generation: LLM generates alternate phrasings, backend-specific targets, recency constraints
- Backend-neutral `recency` metadata (not Google `tbs`)
- `DiscoveryEngine` accepts explicit query lists from LLM-generated strategies
- Dual-score ranking applied during discovery: `readPriorityScore` for read ordering, `evidenceWeight` for synthesis weighting
- Configurable `maxPerHostname` (2 default, 4 for official docs domains)
- Query diversity enforcement: no two queries with same intent

**Outcome**: The system generates diverse, targeted queries instead of re-runs. Source quality improves noticeably.

**Files touched**: `discovery.ts`, `sourceRanking.ts`, `types.ts`, `orchestrator.ts`, `llm/prompts.ts`, `config.ts`

### Sprint 3: Failure Analysis + Gaps Complete (P6 + P1 completion)

Add failure analysis to gap targets, retry limits, abandonment logic.

**Changes**:

- `GapAttempt` metadata on gap targets (answer, evaluation, evidenceDelta, step)
- `FailureMode` typed analysis attached to failed evaluations
- Retry limits: no target attempted > N times without new evidence
- Abandonment: targets abandoned with reason when retries exhausted
- Missing-dimension enqueueing: failed evaluations create new gap targets for uncovered dimensions
- `defer()` used for temporarily blocked targets (not abandoned)
- Trace records each gap lifecycle transition

**Outcome**: Failed answers produce actionable strategy changes, not silence. The agenda genuinely adapts.

**Files touched**: `agenda.ts`, `actionGates.ts`, `orchestrator.ts`, `state.ts`, `types.ts`, `trace.ts`

### Sprint 4: Knowledge + Trace + Synthesis (P3 + P7 + P10)

Unified trace rendering, knowledge conversation injection, and prose synthesis.

**Changes**:

- `KnowledgeBase.renderAsConversation()` produces bounded user/assistant pairs for LLM context
- `ORCHESTRATOR_SYNTHESIS` already updated (Sprint 0) — now the LLM actually receives knowledge items
- `buildStateSummary()` includes compressed knowledge messages (top-K, token-budget bounded)
- `Trace.renderDiary()` included in state summary for trajectory awareness
- `Trace.publicTimeline()` replaces manual `ResearchProgress[]` construction
- Diary rendered from trace events, not duplicated state
- Progress events emitted from trace, not manual progress calls

**Outcome**: The LLM gets enriched, compressed context. Progress reporting is structured, not double-logged.

**Files touched**: `knowledge.ts`, `trace.ts`, `llm/synthesis.ts`, `llm/prompts.ts`, `orchestrator.ts`, `progress.ts`

### Sprint 5: Clustering + Language Detection (P5 + P8)

Cross-backend SERP clustering and multilingual support.

**Changes**:

- `SearchCluster` as discovery artifact (separate from SourceEntry)
- SERP insight stored as `serp_hypothesis` KnowledgeItem — NOT promoted to finding without extraction
- Language detection on input query → set answer language
- Optional multilingual query generation: search in both original language and English
- Language profile included in synthesis context

**Outcome**: Polish for cross-backend and multilingual scenarios.

**Files touched**: `types.ts`, `discovery.ts`, `knowledge.ts`, `orchestrator.ts`, `llm/prompts.ts`, `state.ts`

---

## 4. Out of Scope

- **Vibe/persona in research prompts**: Style applied only at final synthesis if at all
- **Hidden CoT in trace**: Trace events are factual — observable actions and results only
- **Raw Finding→conversation-pair mapping**: KnowledgeItem intermediate always used
- **Google-specific `tbs` in core types**: Backend-neutral recency only
- **Failure analysis as general knowledge**: Always attached to gap target, not global
- **Pure LLM agent replacement**: Hybrid approach preserves pipeline's budget management, parallel discovery, and structural guardrails

---

## 5. Budget Implications

Each sprint adds LLM calls. Budget-aware gates control this:

- **Sprint 1**: Minimal increase — gates and agenda don't add LLM calls
- **Sprint 2**: +1-2 LLM calls per gap iteration (query rewriting)
- **Sprint 3**: +1 LLM call per failed evaluation (failure analysis)
- **Sprint 4**: No new LLM calls — better context, same calls
- **Sprint 5**: +0-1 LLM call per query (language detection)

The `computeGates()` function enforces:

- Block `discover` when source backlog > extract capacity
- Block `extract` when remaining budget too low
- Force `synthesize` when near exhaustion
- Block retry if active gap already consumed too much budget

---

## 6. Testing Strategy

| Sprint | Test Focus                                                                                   |
| ------ | -------------------------------------------------------------------------------------------- |
| 1      | Agenda lifecycle (activate/resolve/defer/abandon), gate computation edge cases               |
| 2      | Query diversity (no duplicate intents), ranking correctness (readPriority vs evidenceWeight) |
| 3      | Retry limits, abandonment triggers, missing-dimension enqueueing                             |
| 4      | Knowledge token-budget enforcement, trace→diary rendering, public timeline completeness      |
| 5      | Language detection accuracy, SERP hypothesis isolation                                       |
