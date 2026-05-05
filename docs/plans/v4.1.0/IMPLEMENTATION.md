# V4.1.0 Implementation Plan: Agent-Enhanced Deep Research

> **Status**: Spec settled · **Est. Scope**: ~1,500 LOC across 5 sprints
> **Execution**: Subagent-driven per sprint with review gates
> **Depends On**: V4.1.0 Sprint 0 substrate (completed — 5 new modules, 6 modified files)

---

## Overview

Five sprints on top of the Sprint 0 substrate. Each sprint produces a working, testable increment. Sprints are sequential — each depends on the previous.

### Conventions

- All new code follows ESM with `.js` extensions, strict TypeScript, exactOptionalPropertyTypes
- Existing `src/research/` layout
- Every sprint includes: implementation → typecheck → lint → review gate

---

## Sprint 1: Working Loop with Gates + Agenda

**Est. LOC**: ~400 changed
**Risk**: Medium
**Dependencies**: Sprint 0 substrate (complete)

### Goal

Wire the five Sprint 0 modules into the orchestrator. The EDA loop operates on one active gap target at a time, gates are computed from state each iteration, and trace events fire at key boundaries.

### 1a. Wire `Agenda` into orchestrator (orchestrator.ts)

Replace `state.gapTargets: string[]` usage with `Agenda` class.

**Changes**:

1. **Create `Agenda` instance** in `ResearchOrchestrator` constructor:
```typescript
private agenda: Agenda;

constructor(drCfg, llmConfig) {
  this.agenda = new Agenda();
  // ...
}
```

2. **Seed agenda from decomposition**: After decomposition creates sub-questions, enqueue each as a `GapTarget`:
```typescript
for (const sq of subQuestions) {
  this.agenda.enqueue({
    question: sq.text,
    priority: sq.budgetPriority,
    source: 'decomposition',
  });
}
```

3. **Replace the EDA loop's gap iteration**: Instead of processing all sub-questions in batch, get one active target:
```typescript
const target = this.agenda.nextTarget(step);
if (!target) {
  // No open targets — proceed to synthesis
  break;
}
this.agenda.activate(target.id);
```

4. **Update after extraction/discovery**: When a target is sufficiently answered:
```typescript
this.agenda.resolve(target.id, {
  answer: summary,
  evidenceSummary: evidenceSummary,
  confidence: aggregateConfidence,
});
```

5. **On evaluation failure**: Defer or abandon:
```typescript
if (evaluation.pass === false && !agenda.attemptsRemaining(target.id)) {
  agenda.abandon(target.id, `Exhausted ${MAX_ATTEMPTS} attempts`);
} else if (evaluation.pass === false) {
  agenda.defer(target.id, evaluation.reason);
}
```

6. **Enqueue new gaps from gap analysis**: When gap analysis identifies new dimensions:
```typescript
for (const gap of newGaps) {
  agenda.enqueue({
    question: gap.description,
    priority: gap.priority,
    parentId: currentTarget?.id,
    source: 'gap_analysis',
  });
}
```

**Files touched**: `orchestrator.ts`

### 1b. Wire `computeGates()` (orchestrator.ts + actionGates.ts)

Replace scattered `gates.allowX` boolean assignments with a single `computeGates()` call.

**Changes**:

1. **In the EDA loop body**, compute gates before LLM decision:
```typescript
const gates = computeGates({
  state: this.stateEngine.getState(),
  step: this.agenda.getStep(),
  lastAction: lastAction,
  lastEvaluation: lastEvaluation,
  budget: this.budgetTracker.snapshot(),
  sourceStats: { pending, extracted, failed },
  activeGap: target ? { id: target.id, attempts: target.attempts } : undefined,
});
```

2. **Pass gates into LLM decide prompt**: The `ORCHESTRATOR_DECIDE` prompt already lists available actions. Include gate reasons in the prompt context so the LLM understands WHY certain actions are blocked.

3. **Remove all scattered `gates.allowX = false`** assignments from the orchestrator. Everything flows from `computeGates()`.

**Files touched**: `orchestrator.ts`, `actionGates.ts` (verify interface), `llm/prompts.ts`

### 1c. Wire `Trace` (orchestrator.ts + trace.ts)

**Changes**:

1. **Create `Trace` instance** in `ResearchOrchestrator`:
```typescript
private trace: Trace = new Trace();
```

2. **Append events at key loop boundaries**:
- After discovery: `trace.append({ step, phase: 'discovery', action: 'search', result: '...' })`
- After extraction: `trace.append({ step, phase: 'extraction', action: 'extract', ... })`
- After evaluation: `trace.append({ step, phase: 'gap_analysis', action: 'evaluate', ... })`
- After gap resolution: `trace.append({ step, phase: 'gap_analysis', action: 'gap_resolved', ... })`
- On gate change: `trace.append({ step, phase: 'eda', action: '...', gateChanges: [...] })`

3. **Replace `state.diary` writes** with `trace.append()` calls. Leave `state.diary` as-is for backward compat; it can be removed in Sprint 4.

4. **Replace manual `ResearchProgress[]` construction** with `trace.publicTimeline()` for the output:
```typescript
result.timeline = this.trace.publicTimeline();
```

**Files touched**: `orchestrator.ts`, `progress.ts` (or replace usage)

### 1d. Wire `KnowledgeBase` (orchestrator.ts + knowledge.ts)

**Changes**:

1. **Create `KnowledgeBase` instance**:
```typescript
private knowledge: KnowledgeBase = new KnowledgeBase();
```

2. **After extraction phase**, ingest findings:
```typescript
this.knowledge.ingestFindings(state.findings, this.agenda.getStep());
```

3. **When a gap target is resolved**, ingest:
```typescript
this.knowledge.ingestGapResolution(target, this.agenda.getStep());
```

**Files touched**: `orchestrator.ts`

### 1e. Wire `SourceRanking` (discovery.ts + sourceRanking.ts)

**Changes**:

1. **In `DiscoveryEngine`**, after collecting candidates, apply ranking:
```typescript
const scores = rankSource(source, frequency);
const ranked = candidates
  .map(c => ({ ...c, readPriority: rankSource(c).readPriorityScore }))
  .sort((a, b) => b.readPriority - a.readPriority);
```

2. **Apply max-per-hostname** filter before returning:
```typescript
const hostnameCounts = new Map<string, number>();
return ranked.filter(c => {
  const hostname = new URL(c.url).hostname;
  const count = (hostnameCounts.get(hostname) ?? 0) + 1;
  hostnameCounts.set(hostname, count);
  return count <= maxPerHostname(hostname);
});
```

**Files touched**: `discovery.ts`, `sourceRanking.ts`

### 1f. Update prompts (llm/prompts.ts)

**Changes to `ORCHESTRATOR_DECIDE`**:

Add gate context to the prompt:
```
Available actions and their current status:
- answer: {allowed} — {reason}
- discover: {allowed} — {reason}
- extract: {allowed} — {reason}
...
Active target: "{target.question}" (attempt {attempts}/{max})
```

This replaces the generic action list with gate-aware information so the LLM doesn't pick blocked actions.

**Files touched**: `llm/prompts.ts`

### 1g. Acceptance Criteria

```
□ Agenda: enqueue → nextTarget picks correct priority target
□ Agenda: activate increments attempts, sets status to active
□ Agenda: resolve sets resolved status with answer
□ Agenda: defer bumps priority number (lower priority)
□ Agenda: abandon sets abandoned status
□ Agenda: dedup blocks duplicate by normalized text
□ Agenda: cycle detection blocks parentId == child's parentId
□ Gates: computeGates blocks answer after failed evaluation without new evidence
□ Gates: computeGates blocks discover when 50+ sources and no pending
□ Gates: computeGates forces synthesize when budget near exhaustion
□ Trace: append records events, renderDiary produces bounded text
□ Trace: publicTimeline produces valid ResearchProgress[]
□ Discovery: results filtered by maxPerHostname
□ Discovery: results sorted by readPriorityScore
□ typecheck clean
□ lint clean on touched files
```

---

## Sprint 2: Query Rewriting + Source Ranking

**Est. LOC**: ~350 changed
**Risk**: Medium
**Dependencies**: Sprint 1

### 2a. LLM-Powered Query Generation (llm/prompts.ts + orchestrator.ts)

New prompt: `ORCHESTRATOR_QUERY_GENERATE`

```
Given a research sub-question and the search strategies already attempted,
generate 3-5 alternative search queries. Each query should have a different
intent (e.g., overview, primary_source, contradiction, technical_detail,
case_study) and specify preferred backends.

Output JSON:
{
  "queries": [
    {
      "q": "search query string",
      "intent": "overview | primary_source | contradiction | technical_detail | case_study | statistics | criticism | official_docs",
      "rationale": "why this query angle",
      "recency": { "mode": "any | recent | date_range", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
      "preferredBackends": ["web", "academic", "github", "reddit", "hackernews", "stackoverflow"]
    }
  ]
}
```

### 2b. Backend-Neutral Recency (types.ts + discovery.ts)

Add `RecencySpec` to types:
```typescript
export interface RecencySpec {
  mode: 'any' | 'recent' | 'date_range';
  from?: string;
  to?: string;
}
```

Add adapter functions in `discovery.ts` that translate `RecencySpec` to backend-specific params:
- Exa: `startPublishedDate` / `endPublishedDate`
- Brave: `freshness` (day/week/month/year)
- SearXNG: `time_range`
- Google (if added later): `tbs`

### 2c. Intent Tracking in Discovery (discovery.ts + types.ts)

Track which intents have been tried per sub-question:
```typescript
interface IntentCoverage {
  subQuestionId: string;
  attemptedIntents: Set<string>;
}
```

When LLM generates new queries, filter out already-attempted intents.

### 2d. Dual-Score Ranking in Synthesis (synthesizer.ts or llm/synthesis.ts)

During synthesis, when computing confidence, incorporate `evidenceWeight` from `SourceRanking`:
```typescript
const evidenceWeight = rankSource(source).evidenceWeight;
// Weight findings by their sources' evidence weight
const weightedConfidence = finding.confidence * averageEvidenceWeight(finding.sourceIds);
```

**Files touched**: `types.ts`, `discovery.ts`, `llm/prompts.ts`, `llm/chat.ts`, `orchestrator.ts`, `synthesizer.ts`, `sourceRanking.ts`

### 2e. Acceptance Criteria

```
□ Query generation produces 3-5 queries with different intents
□ Duplicate intents filtered when already attempted
□ Recency spec translated correctly per backend
□ Discovery uses explicit queries when provided (instead of sub-question text)
□ Source ranking applied during discovery
□ Evidence weight used in synthesis confidence
□ typecheck clean
□ lint clean on touched files
```

---

## Sprint 3: Failure Analysis + Gaps Complete

**Est. LOC**: ~300 changed
**Risk**: Medium
**Dependencies**: Sprint 2

### 3a. GapAttempt Metadata (types.ts + agenda.ts)

```typescript
export interface GapAttempt {
  answer: string;
  evaluation: EvaluationResult;
  evidenceDelta: number;  // new sources/findings added this attempt
  step: number;
}
```

Add to `GapTarget`:
```typescript
attemptsList?: GapAttempt[];
```

Update `Agenda.activate()` to push a new attempt slot. Update `Agenda.resolve()` to populate the last attempt's data.

### 3b. Failure Analysis in Orchestrator (orchestrator.ts)

When evaluation fails:
1. Check `attemptsRemaining()`
2. If remaining: `defer()` with failure mode
3. If exhausted: `abandon()` with failure mode
4. If the failure mode is `missing_primary_source` or `insufficient_sources`, enqueue new targets for specific missing dimensions
5. Record `FailureMode` in trace

```typescript
function classifyFailure(evaluation: EvaluationResult): FailureMode {
  if (evaluation.missingDimensions.includes('primary_source')) return 'missing_primary_source';
  if (evaluation.unsupportedClaims.length > evaluation.requiredNextEvidence.length)
    return 'insufficient_sources';
  if (evaluation.contradictions.length > 2) return 'contradiction_unresolved';
  if (evaluation.score < 0.3) return 'too_broad';
  // ...
}
```

### 3c. Missing-Dimension Enqueueing (orchestrator.ts)

When failure analysis identifies missing dimensions, enqueue them as new gap targets:
```typescript
for (const dim of evaluation.missingDimensions) {
  this.agenda.enqueue({
    question: dim,
    priority: 1, // high priority
    parentId: target.id,
    source: 'failure_analysis',
  });
}
```

### 3d. Acceptance Criteria

```
□ GapAttempt stored correctly on target
□ Failure classification produces correct FailureMode
□ Retry exhausted → abandon with reason
□ Missing dimensions → new gap targets enqueued
□ Trace records each gap lifecycle transition (defer, abandon, resolve)
□ Failed answer without new evidence blocks answer gate
□ typecheck clean
□ lint clean on touched files
```

---

## Sprint 4: Knowledge + Trace + Synthesis Unified

**Est. LOC**: ~250 changed
**Risk**: Low
**Dependencies**: Sprint 3

### 4a. Knowledge Conversation Pairs (knowledge.ts + llm/synthesis.ts)

In `buildStateSummary()`, replace the raw finding-to-conversation-pair mapping (current P3-style code) with `KnowledgeBase.selectForSynthesis()`:

```typescript
// Old: iterate all findings, push user/assistant pairs
// New:
const knowledgeItems = this.knowledge.selectForSynthesis(
  maxItems: 20,
  maxTokens: 2000,
);
const conversationPairs = this.knowledge.renderAsConversation(knowledgeItems);
```

Key difference: the old code iterated ALL findings. The new code selects top-K by confidence, bounded by token budget.

### 4b. Diary from Trace (trace.ts + llm/synthesis.ts)

Replace `state.diary` reference in `buildStateSummary()` with `this.trace.renderDiary(15)`:

```typescript
// Old:
summary.diary = state.diary;
// New:
summary.diary = this.trace.renderDiary(15);
```

This keeps diary bounded (last 15 entries) and avoids duplication (diary was being written to `state.diary` AND stored separately).

### 4c. Timeline from Trace (orchestrator.ts)

Replace manual `result.timeline` construction with `trace.publicTimeline()`:

```typescript
// Old:
const timeline = [...this.progressEvents];
// New:
const timeline = this.trace.publicTimeline();
```

Remove or deprecate `progress.ts`.

### 4d. Prose Synthesis Validation

The `ORCHESTRATOR_SYNTHESIS` prompt was already updated in Sprint 0 to ask for narrative prose with inline `[N]` citations. In this sprint:

1. Add post-processing in `LlmSynthesizer.synthesize()` that resolves inline `[N]` markers to actual source IDs
2. Populate `sourceCitations` on each theme
3. Fall back gracefully when resolution fails (leave `[N]` as-is)

```typescript
private resolveCitations(report: ResearchReport, sources: SourceEntry[]): void {
  for (const theme of report.themes) {
    const citations: { id: string; url: string; title: string }[] = [];
    // Find [N] markers in narrative, resolve to sources by index
    const matches = theme.narrative.match(/\[(\d+)\]/g);
    if (matches) {
      for (const match of matches) {
        const idx = parseInt(match.slice(1, -1), 10) - 1;
        const source = sources[idx];
        if (source) citations.push({ id: source.id, url: source.url, title: source.title });
      }
    }
    theme.sourceCitations = citations;
  }
}
```

### 4e. Acceptance Criteria

```
□ Knowledge selectForSynthesis respects maxItems + maxTokens
□ Conversation pairs bounded by token budget (not all findings)
□ Diary rendered from trace events (last 15 entries), not state
□ Progress timeline from trace.publicTimeline()
□ Inline [N] citations resolved to source IDs
□ sourceCitations populated per theme
□ Fallback works when citation resolution fails
□ typecheck clean
□ lint clean on touched files
```

---

## Sprint 5: Clustering + Language Detection

**Est. LOC**: ~200 changed
**Risk**: Low
**Dependencies**: Sprint 4

### 5a. SERP Clustering (discovery.ts + knowledge.ts)

After collecting search results, cluster by SERP snippet similarity:

```typescript
interface SearchCluster {
  id: string;
  subQuestionId: string;
  insight: string;
  followupQuestion: string;
  sourceIds: string[];
  confidence: number;  // low — based on snippets only
  createdAtStep: number;
}
```

Store clusters in `ResearchState.searchClusters`. The key constraint: clusters are `serp_hypothesis` type in KnowledgeBase — they are NOT promoted to `finding` until extraction confirms them. This prevents snippet-based misinformation from entering the evidence base.

Add cluster inspection to state summary so the LLM can decide which clusters to prioritize for extraction.

### 5b. Language Detection (discovery.ts + llm/prompts.ts)

Before decomposition, detect input language:

```typescript
function detectLanguage(text: string): string {
  // Simple heuristic: check for non-Latin scripts
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u3040-\u309f]/.test(text)) return 'ja';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  // Default to English detection via character analysis
  // ...
}
```

Store in `state.language`.

When generating search queries, if language is non-English, optionally generate English variants:
```typescript
if (language !== 'en') {
  queries.push(translatedEnglishQuery);
}
```

Set answer language in synthesis context.

### 5c. Acceptance Criteria

```
□ Search clusters created from discovery results
□ Clusters stored as serp_hypothesis, not findings
□ Clusters available for extraction prioritization
□ Language detected before decomposition
□ Non-English queries get optional English variant
□ Answer language set correctly
□ typecheck clean
□ lint clean on touched files
```

---

## Effort Summary

| Sprint | New Files | Modified Files | Est. LOC | Risk | Value |
|--------|-----------|---------------|----------|------|-------|
| 1 | 0 | 6 | ~400 | Medium | Highest — loop behavior improvement |
| 2 | 0 | 6 | ~350 | Medium | High — source quality |
| 3 | 0 | 5 | ~300 | Medium | High — strategic adaptation |
| 4 | 0 | 4 | ~250 | Low | Medium — context quality |
| 5 | 0 | 4 | ~200 | Low | Low — polish |
| **Total** | **0** | **~8** | **~1,500** | — | — |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Agenda lifecycle bugs | Unit tests for each transition; integration test with orchestrator |
| Gate computation wrong | Property-based tests for edge cases (exhausted budget, 0 sources) |
| Query rewriting too expensive | Budget-aware gates block generation when low on tool calls |
| Citation chasing infinite loop | Max 2 levels deep; new citations only from unvisited URLs |
| Context window growth | Token-bounded knowledge selection; bounded diary; compact trace |
| LLM ignores gate constraints | Post-decision validation: if LLM picks blocked action, reject and force re-decide with explicit feedback |
