# Jina AI Pattern Integration Plan

## Overview

Integrate 10 high-value patterns from `jina-ai/node-DeepResearch` into our deep research engine (`src/research/`). Each item below is independently implementable, ordered by impact-to-effort ratio.

---

## P1: FIFO Gap Queue (Replace Recursive Sub-Questions)

### What
Replace the current EDA loop's gap system with a rotating FIFO queue. Currently, we iterate sub-questions sequentially (discovery → extraction → loop). Jina's approach: maintain a shared `gaps[]` queue, push sub-questions to back, rotate access via `gaps[totalStep % gaps.length]`, splice solved questions from front.

### Current State
- `state.ts`: `ResearchStateEngine` stores `gaps: GapRecord[]` and `openQuestions: string[]`
- `orchestrator.ts` EDA loop: iterates gaps via `GapAnalyzer.analyze()` → `GapFiller.fillGaps()` → re-discovery → re-extraction
- Sub-questions are treated as a fixed list from decomposition, not grown dynamically

### Changes
1. **`src/research/state.ts`**: Add `addGapTarget(question: string, parentQuestion?: string): string` — appends to `openQuestions[]` and returns ID. Add `popNextGapTarget(): string | undefined` — rotates through `openQuestions` FIFO. Add `markGapTargetResolved(id: string): void`.
2. **`src/research/types.ts`**: Add `ResolvedGap { id, question, parentQuestion, answer }` type. Extend `ResearchState` with `gapTargets: string[]` and `resolvedGaps: ResolvedGap[]`.
3. **`src/research/gapAnalysis.ts`**: Refactor `GapAnalyzer.analyze()` to push new gap targets (questions to answer) rather than just GapRecords. Add `GapFiller.pushGapTargets(questions: string[])` — dedup against existing `gapTargets` and `allQuestions`.
4. **`src/research/orchestrator.ts`**: In the EDA loop's EVALUATE step, instead of `gaps = analyzer.analyze()`, do: `const nextGap = this.state.popNextGapTarget()`. If no next gap exists, break to audit. If a gap exists, set `currentQuestion` to it and proceed. After an `answer` action, push new gap targets from LLM evaluation's `missingDimensions`.

### Files Changed
- `src/research/state.ts`
- `src/research/types.ts`
- `src/research/gapAnalysis.ts`
- `src/research/orchestrator.ts`

### Acceptance
- One sub-question answer feeds all other sub-questions (no isolation)
- New gap questions are pushed to the queue and serviced in order
- Circular references are prevented by dedup against all existing questions

---

## P2: Action Gating (Selective Action Disabling)

### What
Jina selectively disables actions based on state:
- `allowAnswer = false` after failed evaluation or immediately after `search`
- `allowReflect = false` when gaps already exceed limit
- `allowSearch = false` when too many URLs collected
- `allowRead = false` after failed visit
- `allowCoding = false` after coding attempt

### Current State
- `orchestrator.ts` EDA loop: action selection is either LLM-based (via `decideAction()`) or rule-based (`ruleBasedDecision()`). No per-step gating — the LLM can always choose any action.

### Changes
1. **`src/research/orchestrator.ts`**: Add action gate flags to the EDA loop:
   ```typescript
   let allowAnswer = true;
   let allowSearch = true;
   let allowExtract = true;
   let allowDiscover = true;
   ```
2. After each action execution, selectively disable:
   - After failed answer evaluation → `allowAnswer = false`
   - After search/discover with >50 sources → `allowSearch = false`
   - After extraction with low yield → `allowExtract = false`
3. Pass gates to `decideAction()` or `ruleBasedDecision()` — gate-ineligible actions are excluded.
4. **`src/research/llm/prompts.ts`**: Update `ORCHESTRATOR_DECIDE` prompt to document action gating behavior.

### Files Changed
- `src/research/orchestrator.ts`
- `src/research/llm/prompts.ts`

### Acceptance
- After a failed answer attempt, the next iteration is forced to `discover` or `extract`
- After discovering 50+ sources, `discover` is blocked and only `extract` / `fill_gaps` / `audit` are allowed
- Gates reset after budget exhaustion in `synthesizePartial`

---

## P3: Knowledge as Conversation Pairs

### What
Jina stores knowledge items as `{ question, answer, references, type }` and injects them as user/assistant conversation message pairs. This makes context fully LLM-native — no structured JSON parsing required.

### Current State
- Findings are stored as structured `Finding` objects with `claim`, `evidenceExcerpt`, `confidence`, etc.
- They are passed to the LLM synthesis prompt as JSON state summaries
- No direct conversation pair injection

### Changes
1. **`src/research/state.ts`**: Add `getKnowledgeMessages(): CoreMessage[]` — builds user/assistant pairs from findings:
   ```typescript
   findings.forEach(f => {
     messages.push({ role: 'user', content: `Research sub-question: ${f.claim}` });
     messages.push({
       role: 'assistant',
       content: `Evidence from ${f.sourceIds.length} source(s): ${f.evidenceExcerpt ?? f.evidenceSummary}`
     });
   });
   ```
2. **`src/research/llm/synthesis.ts`**: In `buildStateSummary()`, include the conversation messages as a `conversation` field alongside the structured summary. The `ORCHESTRATOR_SYNTHESIS` prompt should reference both.
3. **`src/research/llm/prompts.ts`**: Update `ORCHESTRATOR_SYNTHESIS` to describe the conversation format.

### Files Changed
- `src/research/state.ts`
- `src/research/llm/synthesis.ts`
- `src/research/llm/prompts.ts`

### Acceptance
- Findings are available to LLM as natural conversation history
- Backward compatible — structured JSON summary still present for rule-based fallback
- No increase in token budget for existing depth profiles

---

## P4: LLM-Powered Query Rewriting

### What
Replace rule-based query expansion with an LLM structured output schema that generates optimized search queries with time filters (`tbs`), location, and keyword optimization.

### Current State
- `src/tools/queryExpansion.ts`: Rule-based concept/synonym expansion, question form, scope adjustment, opposition pairs
- Discover engine in `src/research/discovery.ts` builds queries via `buildSearchQueries()` — simple question-to-keyword extraction
- No LLM query rewrite

### Changes
1. **`src/research/llm/prompts.ts`**: Add `WORKER_REWRITE_QUERY` prompt — given a sub-question + search context, output optimized queries with `{ queries: [{ q, tbs?, location? }] }`.
2. **`src/research/discovery.ts`**: Add optional LLM query rewriting. In `discoverForSubQuestion()`, before executing searches, call LLM worker to rewrite queries:
   ```typescript
   if (this.llm) {
     const rewritten = await this.llm.callJSON({ model: 'worker', messages: [...], responseFormat: 'json_object' });
     queries = rewritten.data.queries.map(q => q.q);
   }
   ```
3. Wire via config flag `discovery.enableQueryRewriting` (default: false — opt-in).
4. Fall back to current rule-based `buildSearchQueries()` when LLM is unavailable or fails.

### Files Changed
- `src/research/llm/prompts.ts`
- `src/research/discovery.ts`
- `src/research/types.ts` (DiscoveryConfig)

### Acceptance
- When LLM is available and flag is true, search queries are LLM-optimized
- When flag is false or LLM fails, existing rule-based queries are used
- Time filters are applied for recency-sensitive sub-questions

---

## P5: Search Result Clustering (SERP Clustering)

### What
After search, group results into orthogonal clusters with insights (`{ insight, question, urls }`). This transforms flat search results into structured knowledge.

### Current State
- Results are stored as `SourceCandidate[]` — flat list of title/url/snippet
- No clustering or insight extraction

### Changes
1. **`src/research/discovery.ts`**: After collecting all search results for a sub-question, optionally call LLM to cluster:
   ```typescript
   if (this.llm && candidates.length >= 3) {
     const clusters = await this.clusterCandidates(candidates, sq);
     // Store cluster insights as knowledge items on the state
   }
   ```
2. Add `clusterCandidates()` method — builds LLM prompt with titles/snippets, requests `{ clusters: [{ insight, question, urls }] }` with MAX_CLUSTERS=5.
3. Store clusters as metadata on `SourceEntry` — add optional `clusterQuestion` and `clusterInsight` fields.
4. **`src/research/types.ts`**: Extend `SourceEntry` with `clusterQuestion?: string; clusterInsight?: string;`.

### Files Changed
- `src/research/discovery.ts`
- `src/research/types.ts`
- `src/research/llm/prompts.ts`

### Acceptance
- When LLM is available and >=3 results, clusters are generated and stored
- Cluster insights appear in the synthesis report context
- Flat storage is maintained as fallback

---

## P6: Failure Analysis (Answer Improvement Loop)

### What
When an answer fails evaluation, analyze the failure (recap/blame/improvement), inject learnings back as knowledge. This is distinct from simple re-try: it produces a structured analysis that informs the next attempt.

### Current State
- `GapAnalyzer` detects gaps (unanswered, low confidence, etc.)
- No analysis of **why** an answer failed
- No injection of failure learnings back into state

### Changes
1. **`src/research/llm/prompts.ts`**: Add `WORKER_FAILURE_ANALYSIS` prompt — given `{ question, failedAnswer, evaluationFeedback }`, output `{ recap, blame, improvement }`.
2. **`src/research/gapAnalysis.ts`**: Add `FailureAnalyzer` class:
   ```typescript
   class FailureAnalyzer {
     async analyzeFailure(question: string, answer: string, evaluation: EvaluationResponse): Promise<FailureAnalysis> {
       // LLM call with WORKER_FAILURE_ANALYSIS, fallback to rule-based
     }
   }
   ```
3. **`src/research/orchestrator.ts`**: In the EDA loop's ACT phase, when `fill_gaps` is the action and evaluation from the previous answer failed:
   - Call `FailureAnalyzer.analyzeFailure()`
   - Store result as a knowledge item: `{ question: "Why was the answer bad?", answer: "recap/blame/improvement", type: "qa" }`
   - Push new gap targets derived from `evaluation.missingDimensions`

### Files Changed
- `src/research/gapAnalysis.ts`
- `src/research/orchestrator.ts`
- `src/research/llm/prompts.ts`
- `src/research/types.ts`

### Acceptance
- Failed answers trigger a structured analysis
- Analysis is stored back as retrievable knowledge
- Follow-on discovery targets the identified gaps

---

## P7: Diary Narrative (Human-Readable Step Log)

### What
Maintain a narrative `diaryContext: string[]` that describes what happened at each step in plain English. This builds up in context and helps the LLM understand its own progress trajectory.

### Current State
- State is entirely structured JSON (findings, sources, etc.)
- No narrative log of actions taken

### Changes
1. **`src/research/state.ts`**: Add `diary: string[]` field to `ResearchState`. Add `appendDiary(entry: string): void` and `getDiary(): string[]`.
2. **`src/research/orchestrator.ts`**: At the end of each EDA loop iteration, append a diary entry:
   ```typescript
   this.state.appendDiary(
     `At step ${step}, you took the **${decision.action}** action. ` +
     `You found ${newSources} new sources and ${newFindings} new findings. ` +
     `Current gap count: ${gaps.length}.`
   );
   ```
3. **`src/research/llm/synthesis.ts`**: Include diary in state summary as context for the LLM.
4. **`src/research/llm/prompts.ts`**: Reference diary in `ORCHESTRATOR_EVALUATE` and `ORCHESTRATOR_SYNTHESIS`.

### Files Changed
- `src/research/state.ts`
- `src/research/types.ts`
- `src/research/orchestrator.ts`
- `src/research/llm/synthesis.ts`
- `src/research/llm/prompts.ts`

### Acceptance
- Diary entries are appended per significant action
- Diary is available in LLM synthesis context
- Diary is bounded (last 50 entries) to prevent context bloat

---

## P8: Language Auto-Detection with Vibe/Persona

### What
Auto-detect the user's query language + emotional tone/style, and parameterize all prompt schemas with the detected language style.

### Current State
- No language detection
- All prompts are English, no localization
- Our `Schemas` class in deep research is minimal compared to Jina's

### Changes
1. **`src/research/llm/chat.ts`** or new file **`src/research/language.ts`**: Add `LanguageDetector` class:
   - Check known ISO 639-1 codes map (en, zh, de, fr, es, etc.)
   - If not a known code, call LLM worker with `getLanguageSchema()` → `{ langCode, langStyle }`
2. **`src/research/llm/prompts.ts`**: Make prompts parameterizable — each schema accepts `languageStyle` and `languageCode`. Add a `parameterize(prompt: string, lang: LanguageProfile): string` utility.
3. **`src/research/state.ts`**: Add `languageProfile: { code, style }` to `ResearchState`.
4. **`src/research/orchestrator.ts`**: Run language detection at the start of `run()`, pass profile to all LLM calls.

### Files Changed
- New: `src/research/language.ts`
- `src/research/llm/chat.ts`
- `src/research/llm/prompts.ts`
- `src/research/state.ts`
- `src/research/types.ts`
- `src/research/orchestrator.ts`

### Acceptance
- Query language is auto-detected
- Prompts respond in the detected language and style
- Fallback to English on detection failure

---

## P9: Multi-Signal URL Ranking

### What
Replace simple scoring with multi-signal URL ranking: frequency × domain authority × path structure × semantic relevance × hostname diversity.

### Current State
- `discovery.ts`: `scoreCandidates()` uses a weighted formula: relevance (0.35) + diversity (0.2) + freshness (0.15) + confidence (0.3)
- `domainTrust.ts`: evaluates domain reputation independently
- No frequency boost, path structure analysis, or diversity enforcement

### Changes
1. **`src/research/discovery.ts`**: Enhance `scoreCandidates()`:
   - **Frequency boost**: Add a pass that counts URL occurrences across sources, apply 1.2× multiplier for duplicates (indicates corroboration)
   - **Path structure score**: Apply depth decay factor — pages deeper in path hierarchy get slight penalty
   - **Hostname diversity enforcement**: `keepKPerHostname(results, 2)` — keep max 2 per domain
   - **Domain authority boost**: Use existing `AUTHORITY_DOMAINS` set, add 1.15× multiplier
2. **`src/research/types.ts`**: Add `BoostedSourceCandidate` extending `SourceCandidate` with `freqBoost, authorityBoost, diversityScore`.

### Files Changed
- `src/research/discovery.ts`
- `src/research/types.ts`

### Acceptance
- Ranking weights are adjusted per the new signals
- No more than 2 results per domain (diversity enforced)
- Duplicate URL frequencies contribute positively to ranking

---

## P10: Streaming Progress with Action Events

### What
Emit progressive rendering updates as SSE-style events for each step: `search` events with query text, `visit` events with URLs, `think` events with reasoning content.

### Current State
- `ProgressTracker` in `progress.ts` emits typed `ResearchProgress` events
- Events are phase-level only (decomposition, discovery, extraction, findings)
- No step-level action events (search queries, URLs visited, think text)
- `onProgress` callback receives only percentage + message string

### Changes
1. **`src/research/progress.ts`**: Add action-event types:
   ```typescript
   | { phase: 'action'; actionType: 'search' | 'visit' | 'extract' | 'evaluate' | 'audit'; detail: string }
   ```
2. **`src/research/state.ts`**: In `appendDiary()`, also emit an `action` progress event for significant actions.
3. **`src/research/orchestrator.ts`**: At each ACT step, emit action events:
   ```typescript
   await this.reportAction('search', `Searching: ${queries.join(', ')}`);
   await this.reportAction('visit', `Visiting: ${urls.join(', ')}`);
   ```
4. **`src/research/progress.ts`**: Add `reportAction(actionType, detail)` method.
5. Update `CompactResearchResult` to include action timeline.

### Files Changed
- `src/research/progress.ts`
- `src/research/state.ts`
- `src/research/orchestrator.ts`
- `src/research/types.ts`

### Acceptance
- Action events are emitted through the progress callback
- Timeline captures all major actions with timestamps
- Action types are typed, not stringly-typed

---

## Summary Table

| # | Pattern | Impact | Effort | Files Changed |
|---|---------|--------|--------|---------------|
| P1 | FIFO Gap Queue | High | Medium | 4 |
| P2 | Action Gating | High | Low | 2 |
| P3 | Knowledge as Conversation Pairs | Medium | Low | 3 |
| P4 | LLM Query Rewriting | High | Medium | 3 (+1 prompt) |
| P5 | SERP Clustering | Medium | Medium | 3 |
| P6 | Failure Analysis | Medium | Medium | 4 |
| P7 | Diary Narrative | Low | Low | 5 |
| P8 | Language Auto-Detection | Medium | Medium | 6 |
| P9 | Multi-Signal URL Ranking | Low | Low | 2 |
| P10 | Streaming Action Events | Low | Low | 4 |

## Recommended Sprint Order

1. **Sprint 1**: P1 (FIFO Gap Queue) + P2 (Action Gating) — core architecture changes
2. **Sprint 2**: P4 (LLM Query Rewriting) + P5 (SERP Clustering) — quality improvements
3. **Sprint 3**: P3 (Conversation Pairs) + P6 (Failure Analysis) — knowledge flow
4. **Sprint 4**: P7 (Diary Narrative) + P8 (Language Detection) — context enhancement
5. **Sprint 5**: P9 (URL Ranking) + P10 (Streaming Actions) — polish
