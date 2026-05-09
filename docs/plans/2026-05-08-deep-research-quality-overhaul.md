# Deep Research Quality Overhaul Plan

**Date:** 2026-05-08  
**Auditor findings source:** User audit of a Scientology deep-research run (446 inflated findings, source drift, zero gap loops, shallow source depth, missing key facets)

---

## Execution Status

Implemented in this branch:

- Stronger finding deduplication using token-containment plus provenance-aware merge thresholds.
- Query-aware source relevance scoring for discovery candidates and worker-ingested sources, with low-relevance sources marked discarded.
- Minimum gap-loop sanity passes per depth profile and earlier job gap-loop accounting.
- Institution-risk and Scientology-specific coverage facets for membership scale, finances, legal/current litigation, front groups, RPF, Lisa McPherson, ARS, and IRS-settlement coverage.
- Expanded authority-domain weighting for academic, legal, archive, and primary-government sources.
- Regression tests for repeated policy-definition dedup, gap-loop minimums, facet seeding, source-drift scoring, and short-acronym drift anchors.
- Reviewer follow-up fixes: discovery source entries now carry relevance/discard metadata, repeated duplicates merge in one pass, worker source relevance uses narrative/search-query context, and minimum-loop handling avoids empty no-op spins.

Still future work:

- Embedding/LLM clustering for genuinely semantic duplicates that share little wording.
- Configurable facet packs beyond the built-in institution/Scientology seed pack.
- Full benchmark harness metrics against saved deep-research runs once existing benchmark code typechecks.

## Problem Statement (per audit)

| #   | Audit Finding                                                  | Root Cause in Code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Severity |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A1  | **446 findings inflated by ~5× repetition**                    | `deduplicateFindings()` in `state.ts` only merges by combinedSimilarity > 0.65 on `normalizedClaim` — but same-claim restatements with different surface text (e.g. "Fair Game was a policy of…" vs "The Fair Game policy states…") score below threshold. Each sub-question worker re-extracts the same fact independently; no cross-sub-question dedup runs until post-process, and the merge keeps the older finding, absorbing source IDs but never reducing the count the user sees.            | Critical |
| A2  | **Source drift — irrelevant pages accepted**                   | `DiscoveryEngine` has no relevance gate at the URL/snippet level before source entry creation. The `scoreCandidates` function weighs `estimatedQuality` and `estimatedRelevance` but these are static defaults (0.5 for web, 0.6 for academic) with no query-aware signal. The `relevanceClassifier.ts` runs _after_ extraction — too late. Ohio Public Defender, Cornell Law, Peace Corps Facebook entered the pool because they shared surface keywords ("stipulation", "program") with the query. | Critical |
| A3  | **Zero gap loops**                                             | The `shouldContinueLoop()` heuristics in `gapAnalysis.ts` exit too eagerly: the "niche-topic escape" fires at `currentLoops >= 2 && wellCoveredRatio >= 0.3` — if just 30% of sub-questions have ≥ 3 sources from ≥ 2 types, it stops. For a topic like Scientology where certain sub-questions fill quickly (Wikipedia gives 3+ sources) while others get zero coverage, 30% well-covered is trivially met. No minimum loop count guard exists.                                                     | Critical |
| A4  | **Missing key facets**                                         | `QueryDecomposer` produces generic template-based sub-questions from classification alone. It has no topic-specific facet seeding. For well-documented subjects, domain-essential angles (membership discrepancy, RPF, Lisa McPherson, finances, front groups, legal evasion, ARS internet war, IRS settlement, defector testimony, current litigation) are never generated.                                                                                                                         | High     |
| A5  | **Source depth shallow — no academic/book/primary preference** | `sourceRanking.ts` authority domains are tech-focused (arXiv, GitHub, docs.python.org). No sociology/religious-studies/journalism domains. `classifySourceTier()` has no mechanism for domain-specific authority lists loaded from config or detected from query classification.                                                                                                                                                                                                                     | High     |
| A6  | **No cross-article dedup for findings from different workers** | Each `WorkerAgent` runs independently with its own extraction; findings are only deduped in `postProcessFindings()` which uses the same 0.65 threshold. Workers never see each other's findings, so they re-extract identical facts.                                                                                                                                                                                                                                                                 | High     |

---

## Solution Design — 6 Phased Workstreams

### Phase 1: Semantic Finding Deduplication (addresses A1, A6)

**Goal:** Reduce repeated-near-identical findings from 5× to <1.5× on well-documented topics.

**Current state:** `deduplicateFindings()` uses `combinedSimilarity(normalizedClaim_a, normalizedClaim_b) > 0.65` where combined = max(jaccard, trigram). This misses semantic near-duplicates where the same fact is restated differently.

**Changes:**

1.1. **Lower dedup threshold** — Change `combinedSimilarity` threshold from 0.65 to 0.55 in `deduplicateFindings()`. At 0.55, claims like "Fair Game was a policy of suppressing critics" and "The Fair Game policy authorized harassment of suppressive persons" will match (high trigram overlap on "fair game" + "policy" + "suppress"). Sanity check: add a test where two claims share >4 content words but differ in sentence structure and verify merge.

1.2. **Cross-worker dedup after each worker completes** — In `pipelineStrategy.ts`, after each worker finishes its `investigate()` call and before the next worker starts, run `ctx.state.postProcessFindings()` (or a lightweight `crossWorkerDedup()` that calls `deduplicateFindings()` only). This prevents the accumulation problem. Add `interWorkerDedup: boolean` flag to pipeline config (default `true`).

1.3. **Source-count weighted dedup** — When `mergeFindings(keepId, absorbId)`, prefer the finding with more sourceIds as the keeper (currently keeps the older one). This keeps the better-attributed version. Change the sort in `deduplicateFindings` to sort findings by `sourceIds.length` descending before the pairwise loop.

1.4. **Dedup across gap loops** — At the start of each gap loop iteration, call `ctx.state.postProcessFindings()` to re-merge any duplicates introduced by gap-fill workers.

**Files changed:** `src/research/state.ts`, `src/research/strategies/pipelineStrategy.ts`  
**New tests:** `test/research/finding-dedup.test.ts`

**Sanity checks:**

- [ ] Two findings with identical meaning but different surface text (trigram sim 0.4, Jaccard 0.3, combined 0.4 — current: no merge, new: no merge) → threshold 0.55 still won't catch these. Need semantic similarity or LLM. **Mitigation:** Add `_semanticDedupFallback` using `tokenOverlap` from `relevanceClassifier.ts` on full claim text (not normalized). If token overlap > 0.60 AND the two findings share ≥1 subQuestionId, mark for merge. This is a rule-based approximation of semantic similarity.
- [ ] Over-merging distinct findings that happen to share words. Test: "Revenue grew 12%" vs "Revenue target is 12 million" — these should NOT merge. Token overlap would be high, but the sub-question IDs likely differ. **Guard:** require shared subQuestionId OR high trigram/jaccard.
- [ ] Performance: pairwise dedup is O(n²). With 446 findings, that's ~100K comparisons. Each comparison is cheap (set operations). Acceptable. If findings exceed 1000, batch into sub-question groups first (only compare within same sub-question + cross-sub-question for findings that share ≥1 source domain).

---

### Phase 2: Source Relevance Gate (addresses A2)

**Goal:** Reject tangential sources before they enter the extraction pipeline, saving crawl budget.

**Current state:** Sources are scored and ranked but never gate-filtered at discovery time. The `relevanceClassifier.ts` scores findings (not sources) post-extraction. No query-aware snippet relevance check exists.

**Changes:**

2.1. **Add `scoreSourceRelevance(query, candidate) → { score, reason }`** — a new function in `src/research/sourceRelevanceGate.ts`. Uses the same `tokenOverlap` and `topicalDrift` logic from `relevanceClassifier.ts` but operates on `(query, candidate.title + candidate.snippet)` before source entry creation. Returns `{ score: 0-1, admissible: boolean }` where `admissible = score >= 0.30`. At 0.30, sources that share at least one meaningful content word with the query pass; pure keyword accidents ("stipulation" matching a legal dictionary) fail because they have near-zero overlap on the rest of the query. This is a conservative gate — it only blocks clearly irrelevant sources.

2.2. **Apply gate in `DiscoveryEngine.discover()`** — After `scoreCandidates` and `deduplicate`, filter candidates through `scoreSourceRelevance`. Log rejections at `info` level for auditability.

2.3. **Source drift detection** — If a source candidate's domain appears on a known-irrelevant-domain list (extendable via config), penalize heavily. Add `DRIFT_PENALTY_DOMAINS` config option (default: `[]`) — for the Scientology case, this would include `ohio.public.defender.gov`, `peacecorps.gov`, `facebook.com` (non-research). But since these are query-specific, the config approach is better than hardcoding.

2.4. **Reject sources where the query-specific entity terms (extracted by decomposer) are completely absent from title+snippet** — the decomposer already extracts entities. Pass them to discovery and use as a minimum-viability check. If zero entity terms appear, the source is flagged `low_relevance` and excluded from extraction (but still tracked in state with `usageStatus: 'discarded'` and `discardReason: 'low_relevance'`).

**Files changed:** `src/research/sourceRelevanceGate.ts` (new), `src/research/discovery.ts`, `src/research/types.ts`  
**New tests:** `test/research/source-relevance-gate.test.ts`

**Sanity checks:**

- [ ] A source about "legal stipulations" for a query about "Scientology Fair Game stipulation of evidence" — the word "stipulation" overlaps but the rest doesn't. Token overlap with full query will be <0.30 → correctly rejected.
- [ ] A source about "Lisa McPherson wrongful death case" for same query — "Lisa McPherson" and "wrongful death" overlap with entity terms → correctly accepted.
- [ ] A source about "Scientology membership numbers" — "Scientology" overlaps + "membership" appears in entity list → accepted.
- [ ] False positive rate: On technical queries (e.g., "what is TTT in linear attention"), stackoverflow answers about "test" will have high overlap → accepted (correctly, since they may discuss the technique). The gate is intentionally lenient at 0.30.

---

### Phase 3: Guaranteed Gap Loops + Mandatory Coverage Seeds (addresses A3, A4)

**Goal:** Gap loops always run at least N times per depth level; decomposition injects domain-essential facets.

**Current state:** `shouldContinueLoop()` returns `false` when `wellCoveredRatio >= 0.3 && currentLoops >= 2`. No minimum loop count. `QueryDecomposer` uses classification-specific templates only.

**Changes:**

3.1. **Minimum guaranteed gap loops** — Add `minGapLoops` to `BudgetProfile`: `{ quick: 1, standard: 2, deep: 3, exhaustive: 4, tree: 1 }`. In `shouldContinueLoop()`, add a first check:

```typescript
if (this.budget.snapshot().gapLoopsUsed < this.profile.minGapLoops) return true;
```

This ensures at least N gap loops execute regardless of the niche-topic escape heuristic.

3.2. **Coverage-aware loop exit** — Replace the `wellCoveredRatio >= 0.3` escape with a check that requires ALL sub-questions to have at least `thin` coverage (≥1 source, ≥1 domain) before allowing early exit:

```typescript
const allHaveSources = state.subQuestions.every((sq) => {
  const sqSources = state.sources.filter((s) => s.subQuestionId === sq.id);
  return sqSources.length >= 1;
});
if (!allHaveSources && currentLoops < maxGapLoops) return true;
```

3.3. **Topic-specific facet seeding in decomposer** — Add a new method to `QueryDecomposer`: `generateDomainFacets(query, classification, entities)`. This method maintains a registry of "well-documented domain hints" — when the query classification or entity list matches a known domain pattern, it appends mandatory sub-questions. The registry is data-driven (not hardcoded):

```typescript
const DOMAIN_FACET_REGISTRY: Record<string, string[]> = {
  religioncultsectorganizations: [
    'Membership numbers and discrepancies between official claims and independent estimates',
    'Internal discipline programs and rehabilitation efforts',
    'Major legal cases and wrongful death incidents',
    'Front organizations and affiliated programs operating under different names',
    'Current leadership legal situation and civil process evasion',
    'Financial scale, revenue, and real estate holdings',
    'Early internet suppression and anti-critical activities',
    'Tax-exempt status history and key government settlements',
    'Defector and apostate testimony',
    'Current ongoing litigation',
  ],
  // ... other domains extensible
};
```

The registry key is derived from entity extraction: if the decomposer detects entities like {"name": "Scientology", "domain": "religion"}, it builds the key "religioncultsectorganizations" from the domain + synonyms. This is a heuristic but it's the only practical way to seed domain facets without LLM.

3.4. **LLM-assisted facet generation** — When `ctx.llm` is available, add a second-pass decomposition prompt that includes: "Given the following initial sub-questions and the research query, identify 3-5 important facets that are completely missing. Consider: controversial aspects, financial dimensions, internal practices, legal history, membership data, defector accounts, current developments." This runs after the rule-based decomposition and adds the LLM-generated sub-questions as `budgetPriority: 2` (medium).

**Files changed:** `src/research/state.ts` (BudgetProfile), `src/research/gapAnalysis.ts`, `src/research/decomposer.ts`, `src/research/llm/prompts.ts`  
**New tests:** `test/research/gap-minimum-loops.test.ts`, `test/research/decomposer-facets.test.ts`

**Sanity checks:**

- [ ] minGapLoops: for `standard` depth, verify 2 loop iterations execute even when 30%+ sub-questions are well-covered early.
- [ ] Domain facet seeding: test that "Scientology" query generates sub-questions about membership numbers, finances, RPF, Lisa McPherson, etc.
- [ ] Domain facet for non-matching queries: "What is TTT in linear attention" — should NOT generate religion/cult facets. Verify registry doesn't false-match.
- [ ] LLM facet prompt: when LLM is unavailable, only rule-based facets are used; when available, the prompt adds 3-5 more. Verify graceful degradation.

---

### Phase 4: Source Depth Preference (addresses A5)

**Goal:** For well-documented topics, prefer peer-reviewed academic sources, book references, and primary documents over web-only sources.

**Current state:** `sourceRanking.ts` `AUTHORITY_DOMAINS` is tech-focused. No domain-adaptive authority lists. No mechanism to boost academic sources for non-tech queries. `classifySourceTier()` doesn't know whether the query is about a well-documented subject where deeper sources exist.

**Changes:**

4.1. **Domain-adaptive authority boosting** — Extend `AUTHORITY_DOMAINS` with non-tech domains:

```typescript
const ACADEMIC_DOMAINS = new Set([
  'jstor.org',
  'scholar.google.com',
  'semanticscholar.org',
  'researchgate.net',
  'academia.edu',
  'muse.jhu.edu',
  'tandfonline.com',
  'sagepub.com',
  'springer.com',
  'cambridge.org',
  'oup.com',
  'press.uchicago.edu',
  'books.google.com',
  'worldcat.org',
]);
```

Add `isAcademicDomain(domain)` check in `sourceRanking.ts` → `domainAuthorityScore()` returns 0.80 for academic domains (matching `.edu`).

4.2. **Academic-preference flag from decomposition** — When `QueryDecomposer` classifies a query as `literature-review` or `historical-timeline`, or when the LLM facet prompt identifies the topic as "well-documented", set a flag `preferAcademicSources: true` on the `SubQuestion[].preferredSources` arrays (add `'academic'` and `'pubmed'` if not already present). This activates `searchAcademic()` and `searchPubMed()` in `DiscoveryEngine.discoverForSubQuestion()`.

4.3. **Book search integration** — When `preferAcademicSources` is true, add a Google Books search path in discovery. Use the existing `webSearch` function with a `"site:books.google.com"` query modifier. This is lightweight — no new API key needed, just query crafting.

4.4. **Primary document preference in synthesis** — In `sourceQuality.ts` `classifySourceTier()`, add logic: if `source.sourceType === 'web'` and the domain is a `.gov` or `courts.*` domain, classify as Tier 2 (not Tier 3) — primary documents like court filings are high-quality even if they're "web" sourceType.

**Files changed:** `src/research/sourceRanking.ts`, `src/research/sourceQuality.ts`, `src/research/decomposer.ts`, `src/research/discovery.ts`  
**New tests:** `test/research/source-depth-preference.test.ts`

**Sanity checks:**

- [ ] Academic domain boosting: `domainAuthorityScore('jstor.org')` → 0.80 (not default 0.50).
- [ ] `.gov` and `courts.` domains classify as Tier 2, not Tier 3.
- [ ] For `literature-review` queries, `preferredSources` includes `'academic'`.
- [ ] Book search: when `preferAcademicSources` is true, `webSearch` is called with `"site:books.google.com {query}"`. Verify this doesn't fire for technical queries.

---

### Phase 5: Cross-Worker Dedup and Finding Attribution Integrity (addresses A1, A6)

**Goal:** Findings from different workers are deduplicated before final synthesis; findingCount reflects deduplicated reality.

**Current state:** `postProcessFindings()` runs once at the end. Workers don't share state. `findingCount` reports raw (pre-dedup) count.

**Changes:**

5.1. **Inter-worker dedup** — In `pipelineStrategy.ts`, after each worker completes in `spawnWorkers`, call `ctx.state.postProcessFindings()`. This runs `deduplicateFindings()` + `detectContradictions()` after each batch.

5.2. **Dedup count in progress reports** — Track `dedupMergedCount` in `ResearchState.flags` (or a new field `dedupStats: { merged: number; originalTotal: number }`). Report this in progress callbacks so the UI can show "446 findings → 95 unique after dedup".

5.3. **Finding provenance** — When `mergeFindings(keepId, absorbId)`, append a note to `keep.evidenceSummary`: `"[Merged with finding {absorbId} — {absorb.claim.slice(0, 80)}...]"`. This preserves audit trail.

**Files changed:** `src/research/state.ts`, `src/research/strategies/pipelineStrategy.ts`, `src/research/types.ts`  
**Tests:** in `test/research/finding-dedup.test.ts` (from Phase 1)

**Sanity checks:**

- [ ] After inter-worker dedup, verify `findingCount()` is lower than the sum of individual worker findings.
- [ ] `dedupStats.merged` is correctly incremented.
- [ ] Merged findings retain attribution notes in evidenceSummary.

---

### Phase 6: Integration Tests and Regression Suite

**Goal:** Verify the overhaul works end-to-end without breaking existing behavior.

**Changes:**

6.1. **Scenario test: "well-documented topic with known gaps"** — Create a test that simulates the Scientology scenario: a query where Wikipedia is easily found but critical facets (RPF, Lisa McPherson, finances) are missing. Verify:

- Minimum gap loops execute.
- Domain facets are seeded.
- Finding dedup reduces near-duplicate claims.
- Source relevance gate excludes clearly irrelevant pages.
- Academic sources are preferred when `preferAcademicSources` is set.

  6.2. **Scenario test: "technical query unchanged"** — A query like "implement TTT in PyTorch" should produce the same quality of results as before (no regressions from the relevance gate or dedup changes).

  6.3. **Regression test for existing bugs** — Include the findings from `context.md`:

- `findingCount` should reflect post-dedup count (fix the hardcoded 0 in `agentStrategy.ts`).
- `subQuestionCount` should use total, not batch (fix the bug in `pipelineStrategy.ts`).
- `sourceTypeCount` should not be hardcoded `undefined` in `deepResearch.ts`.

  6.4. **Benchmark runner** — Extend `scripts/run-benchmark.ts` to record `preDedupFindingCount`, `postDedupFindingCount`, `gapLoopCount`, `facetsGenerated`, `sourcesRejectedByRelevanceGate` as new metrics.

**Files changed:** `test/research/deep-research-overhaul.test.ts` (new), `test/research/strategy-integration.test.ts`, `scripts/run-benchmark.ts`, `src/tools/deepResearch.ts` (fix sourceTypeCount bug), `src/research/strategies/agentStrategy.ts` (fix findingCount bug), `src/research/strategies/pipelineStrategy.ts` (fix subQuestionCount bug)

**Sanity checks:**

- [ ] All existing tests still pass after changes.
- [ ] New scenario tests pass without mocking external APIs (use state-engine-only tests).
- [ ] Benchmark runner outputs new metrics columns.

---

## Implementation Order and Dependencies

```
Phase 1 (Dedup) ←── Phase 5 (Cross-worker dedup)
       ↓
Phase 2 (Relevance gate) ←── independent
       ↓
Phase 3 (Gap loops + facets) ←── depends on Phase 2 (gate ensures gap-fill workers don't waste budget)
       ↓
Phase 4 (Source depth) ←── independent
       ↓
Phase 6 (Integration) ←── depends on all above
```

**Recommended execution order:** 1 → 2 → 3 → 4 → 5 → 6  
Each phase includes: write failing tests → implement → verify tests pass → request code review.

---

## Risk Assessment

| Risk                                                      | Mitigation                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Lowering dedup threshold to 0.55 merges distinct findings | Require shared subQuestionId OR trigram > 0.50 in the pair. Test with adversarial pairs.                                                      |
| Source relevance gate rejects legitimately useful sources | Set gate threshold conservatively (0.30). Log all rejections. Allow per-query overrides.                                                      |
| Domain facet registry becomes stale or wrong              | Make registry data-driven (JSON config). Allow user-configurable additions. Fall back to LLM-generated facets when LLM is available.          |
| Minimum gap loops waste budget on already-complete topics | Combine with "all sub-questions have ≥1 source" check. After minLoops + allHaveSources, exit.                                                 |
| Cross-worker dedup slows pipeline                         | `deduplicateFindings()` is O(n²) but cheap (set operations). With <200 findings per worker pair, <20K comparisons — <10ms. Profile if needed. |
| Academic domain list needs curation                       | Make configurable. Default list covers major sociology/science publishers.                                                                    |

---

## Success Metrics (from audit)

| Metric                                                | Before           | Target                        |
| ----------------------------------------------------- | ---------------- | ----------------------------- |
| Finding dedup ratio (raw / unique)                    | 446 / ~95 = 4.7× | < 1.5×                        |
| Source drift (irrelevant sources reaching extraction) | 3+ per run       | 0 per run                     |
| Gap loops executed on "standard" depth                | 0                | ≥ 2                           |
| Missing essential facets (for well-documented topics) | 9/10 missing     | ≤ 2/10 missing                |
| Academic/book sources in final report                 | 0                | ≥ 3 per well-documented topic |
| Post-dedup finding count reported accurately          | No (hardcoded 0) | Yes                           |
