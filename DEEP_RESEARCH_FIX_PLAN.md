# Deep Research: Contradictions, Tool Diversity & Premature Termination Fix Plan

## Investigation Summary

Three compounding failures in the deep research pipeline. Root causes identified below.

---

## Root Cause 1: Contradictions Not Detected

### Symptom
`contradictions: []` in output even for fast-moving, contested topics.

### Why

**a) Detection runs at the wrong time.** Detection only happens after the gap loop completes, before synthesis. The `generateFromEvidencePool()` call in `contradictionGenerator.ts` (line ~436 of pipeline) covers date/version conflicts, benchmark disagreements, and source-quality-tier conflicts, but runs too late — after the gap loop, so discovered contradictions can't influence gap-filling. `detectContradictions()` in `state.ts` (line ~501) runs at the same post-loop stage. During the EDA loop itself, zero contradiction scanning occurs.

**b) Rule-based detection is too shallow (state.ts lines 674-834).** Only 4 patterns:
- Negation (`not`/`isn't`/`wasn't` on same topic)
- Directional (`improves` vs `reduces` on same topic)
- Numerical (significant % differences on same topic)
- Scope mismatch (different sub-questions claiming different things)

Missing entirely: conflicting benchmark numbers between labs, competing interpretations of same data, "A claims superiority over B" vs "B claims superiority over A", contradictory timelines, methodological disagreements.

**c) Source homogeneity.** When all findings come from web sources, cross-source-type triangulation doesn't happen. A company blog and an academic paper make different claims about the same thing — but if both are filed as "web", the contradiction isn't surfaced.

**d) No LLM-powered contradiction scanning.** The `contradiction_scan` action exists in the decide prompt but relies on the LLM choosing it. There's no proactive LLM call specifically designed to find contradictions.

### Fix

1. **Run contradiction detection inside the EDA loop**, not just at synthesis time. Call both `detectContradictions()` AND `generateFromEvidencePool()` at the start of each gap loop iteration.
2. **Add an LLM-powered contradiction scanner** that takes findings as input and explicitly hunts for epistemic tension. Must use batched/sampled findings, not O(n²) pairwise comparison.
3. **Add conflict-of-interest and source-perspective tags** to findings so the contradiction scanner can cross-reference.
4. **Trigger contradiction scan at the top of each gap loop iteration** in `pipelineStrategy.ts` after `computeSubQuestionCoverage()`. Inject findings into the `GapAnalyzer` input so contradiction-driven gaps are actionable.

---

## Root Cause 2: Workers Only Using Web Tools

### Symptom
Worker agents source nearly all content from web search despite prompt encouraging diversity.

### Why

**a) `executeSearches` lacks direct tool access for several source types.** Workers can call:
- `webSearch` ✓
- `academicSearch` ✓ (wraps ArXiv + Semantic Scholar)
- `githubSearch` ✓
- `redditSearch` ✓ (always-run)
- `hackernewsSearch` ✓ (always-run)
- `semanticYoutube` ✓ (always-run)
- `wikipediaSearch` — EXISTS in `ResearchTools` interface and `createResearchTools()` factory, but NEVER called in `executeSearches()`
- `pubmedSearch` — EXISTS in `ResearchTools` interface and `createResearchTools()` factory, but NEVER called in `executeSearches()`
- `stackoverflowSearch` — Does NOT exist in `ResearchTools`. There's a standalone `src/tools/stackoverflowSearch.ts` wrapping the Stack Exchange API, but it's not exposed to workers.

**b) Budget consumed by shared pool, not per-worker.** In `spawnWorkers()` (pipeline line ~540), `onToolCall` calls `ctx.budget.recordToolCall()` which consumes from the global orchestrator budget. When 5+ workers run concurrently each doing 3 search rounds + reads, the global 100-toolCall budget for `standard` depth is consumed in the initial worker phase — leaving nothing for diverse follow-up.

**c) Worker config is too tight.**
- `maxSearchRounds: 3` — only 3 search+browse cycles
- `maxPagesPerRound: 10` — only 10 pages read per round
- `maxSubThreadDepth: 1` — only 1 follow-up level

With these constraints, workers default to the cheapest path (web search) since it always works and requires no special handling.

### Fix

1. **Add `wikipediaSearch` tool** to ResearchTools interface and `executeSearches`.
2. **Add `pubmedSearch` tool** to ResearchTools interface and `executeSearches`.
3. **Add `stackoverflowSearch` tool** to ResearchTools interface and `executeSearches`.
4. **Give workers a per-worker tool call budget** separate from the global orchestrator budget, so worker diversity doesn't starve gap loops.
5. **Increase `maxSearchRounds` from 3 → 5** for standard depth and above.

---

## Root Cause 3: Jobs End Prematurely

### Symptom
Jobs exit early despite available budget, suggesting adaptive bands don't kick in.

### Why

**a) Gap loop counts are shockingly low.**

| Depth | maxGapLoops | Effect |
|---|---|---|
| quick | 1 | Single pass, barely any adaptation |
| standard | 2 | Initial pass + 2 gap fills = minimal iterating |
| deep | 3 | Some iteration, still tight |
| exhaustive | 5 | Reasonable |

For `standard` (the default): initial worker phase → gap loop 1 → gap loop 2 → synthesize. Two gap loops is barely enough to react to discovered issues.

**b) Extraction budget: a bug-in-waiting, not an active problem.** In the current LLM path, findings are added via `ctx.state.addFinding()` in `ingestWorkerReports()`, which does NOT call `recordExtraction()`. `recordExtraction()` is only called in `extraction.ts` (the rule-based path). So standard's `maxExtractions: 15` is not drained by worker findings today. However, if extraction accounting ever changes or the rule-based path runs, this becomes a problem. Fix as hygiene.

**c) `shouldContinueLoop()` has a premature stop condition.**

```typescript
// gapAnalysis.ts line 488+
const allSubQuestionsResolved =
  state.subQuestions.length > 0 &&
  state.subQuestions.every(sq => sq.status === 'sufficient' || sq.status === 'unresolvable');
if (allSubQuestionsResolved) return false;
```

Sub-questions can be marked `sufficient` by the LLM evaluator after shallow investigation. If all get marked sufficient after gap loop 1, the loop stops even when deeper investigation would find more nuance.

**d) No adaptive band mechanism exists.** Despite the user's mention, there's nothing that dynamically scales budget based on topic complexity, contradiction count, or source diversity. The budget profile is fixed at start. The `isConfidencePlateau` check is a stop condition, not an extension trigger.

### Fix

1. **Double gap loop counts**: quick: 1→2, standard: 2→4, deep: 3→6, exhaustive: 5→8.
2. **Separate extraction accounting from finding count** (hygiene). Only count explicit `recordExtraction()` calls, not finding ingestion.
3. **Add adaptive band extension**: when contradictions are detected or source diversity is low, automatically extend gap loop budget by +2. Thresholds should be profile-aware: a quick profile with 3 source types is acceptable; an exhaustive profile with 3 is not.
4. **Increase extraction budget** (hygiene): standard 15→30, deep 30→60.
5. **Add complexity-triggered budget extension**: if >3 contradictions found or source type count <3 after initial phase, double remaining gap loops.

---

## Implementation Plan

### Phase A: Tool Diversity (smallest change, highest impact)

1. **Wire `wikipediaSearch` into `executeSearches`** (`workerAgent.ts`)
   - Already exists in `ResearchTools` interface and `createResearchTools()` factory
   - Add as always-run search (like reddit/HN/YT) with circuit breaker

2. **Wire `pubmedSearch` into `executeSearches`** (`workerAgent.ts`)
   - Already exists in `ResearchTools` interface and `createResearchTools()` factory
   - Add as always-run search with circuit breaker

3. **Create and wire `stackoverflowSearch`** (`researchTools.ts`, `workerAgent.ts`)
   - Add `stackoverflowSearch(query, limit)` to `ResearchTools` interface
   - Implement in `createResearchTools()` wrapping the `research` family tool with `action: 'stackoverflow'`
   - Wire into `executeSearches()` as always-run search
   - Add `stackoverflow` to `sourceTypes` list in `WORKER_AGENT_INVESTIGATE` prompt

4. **Wire new tools into `executeSearches`** (`workerAgent.ts`)
   - Add `wikipedia`, `pubmed`, `stackoverflow` to always-run searches (like reddit/HN/YT)
   - Each with circuit breaker and graceful degradation

5. **Increase worker config**
   - `maxSearchRounds`: 3 → 5
   - `maxSubThreadDepth`: 1 → 2 (for standard+ depth)

### Phase B: Contradiction Pipeline

6. **Move contradiction detection into EDA loop** (`pipelineStrategy.ts`)
   - Call BOTH `ctx.state.detectContradictions()` AND `generateFromEvidencePool()` at the start of each gap loop iteration
   - Store contradictions incrementally
   - Inject findings into `GapAnalyzer` input so contradiction-driven gaps become gap-fill targets

7. **Create LLM-powered contradiction scanner** (`src/research/llm/contradictionScanner.ts`)
   - Takes sampled findings + source metadata (batching required — not O(n²))
   - System prompt: "Find ALL potential contradictions, disagreements, or conflicting claims. Be aggressive — flag even indirect or implicit conflicts."
   - Output: structured contradictions with type, confidence, source pairs
   - Runs during EDA loop alongside rule-based detection
   - **Scaling note:** With 100+ findings, pairwise comparison is 4950 pairs. Use batching by sub-question or recent-findings-only scope. Target ≤200 finding pairs per LLM call.

8. **Add source-perspective metadata to findings** (`state.ts`, `types.ts`)
   - `perspective`: 'vendor' | 'academic' | 'practitioner' | 'official' | 'community' | 'unknown'
   - `conflictOfInterest`: boolean
   - Set during worker report ingestion

9. **Add epistemic uncertainty tracking** (`types.ts`)
   - `epistemicStatus`: 'consensus' | 'contested' | 'emerging' | 'speculative' | 'unknown'
   - Set by LLM during extraction, falls back to rule-based

10. **Trigger contradiction scan at top of each gap loop iteration** (`pipelineStrategy.ts`)
    - After `computeSubQuestionCoverage()`, run both rule-based and LLM contradiction detection
    - Inject results into `GapAnalyzer` so contradictions become gap-fill targets
    - Do NOT use `computeGates()` from `actionGates.ts` — it's unused by `PipelineStrategy` and the pipeline uses a fixed `for` loop

### Phase C: Adaptive Bands & Budget Fixes

11. **Increase gap loop budgets** (`state.ts` BUDGET_PROFILES)
    - quick: maxGapLoops 1→2
    - standard: maxGapLoops 2→4
    - deep: maxGapLoops 3→6
    - exhaustive: maxGapLoops 5→8

12. **Increase extraction budgets** (`state.ts` BUDGET_PROFILES)
    - standard: maxExtractions 15→30
    - deep: maxExtractions 30→60

13. **Separate extraction accounting from finding count** (`state.ts`)
    - Only count explicit extraction operations (worker LLM synthesis calls)
    - Don't count worker report ingestion as extractions

14. **Add adaptive band extension** (`pipelineStrategy.ts`, `state.ts`)
    - After each gap loop evaluation: if contradictions >= 3 OR source type count < 4, extend maxGapLoops by +2
    - After gap loop 1: if findings < 10 total, extend maxGapLoops by +2 (thin coverage)

15. **Fix `shouldContinueLoop` premature stop** (`gapAnalysis.ts`)
    - Remove the `allSubQuestionsResolved` check — it prematurely stops when LLM marks things sufficient
    - Instead, check if >50% of sub-questions have >3 sources AND >2 source types
    - **Escape valve**: if a topic genuinely has few available source types (niche topic), skip the source-type diversity check after gap loop 2 to avoid infinite looping

16. **Give workers per-worker budget** (`workerAgent.ts`, `pipelineStrategy.ts`)
    - **Approach: pre-allocation pool.** Before `spawnWorkers()`, allocate a per-worker tool call pool from the global budget (e.g., 15 calls each). Workers deduct from their own pool. Unused calls are returned to the global budget after all workers complete.
    - Orchestrator records aggregate but doesn't gate on per-worker exhaustion
    - Simpler than per-worker BudgetTracker instances

---

## Rollout Strategy

1. **Phase A first** (tool diversity) — lowest risk, immediate visible impact
2. **Phase B second** (contradictions) — new module, needs testing
3. **Phase C last** (budget) — touches profiles, needs careful verification
4. All behind existing `DEEP_RESEARCH_ENABLED` flag
5. No user-facing schema changes; report format gets new fields (backward compat via optional fields)

## Verification

- `npm run typecheck`
- `npm run lint`
- Existing test suite: `npm test`
- **New: unit tests** for contradiction scanner (batched finding input), per-worker budget pre-allocation, and budget profile changes
- **New: integration test** — run a short research job on a contested topic, assert `contradictions.length > 0` and source type diversity > 2
- **New: metrics** — expose contradiction count in health/telemetry so the fix can be verified in production
- Manual: run `deep_research start` with a contested topic, verify contradictions array non-empty
- Manual: verify source type diversity >2 in worker investigations
- Manual: verify job doesn't exit prematurely with budget remaining
