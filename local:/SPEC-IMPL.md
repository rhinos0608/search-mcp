# Implementation Spec: 10 Jina AI Pattern Integrations

## Overview
All 10 patterns are independently implementable across different files. Each pattern below specifies exact file changes.

---

## P1: FIFO Gap Queue
**Files**: `types.ts`, `state.ts`, `gapAnalysis.ts`, `orchestrator.ts`
**Goal**: Replace fixed sub-question iteration with rotating FIFO queue.

### types.ts additions
```typescript
export interface ResolvedGap {
  id: string;
  question: string;
  parentQuestion?: string;
  answer?: string;
  resolvedAt: string;
}
```
Add to `ResearchState`:
- `gapTargets: string[]` (FIFO question queue)
- `allQuestions: string[]` (dedup set, all questions ever seen)
- `resolvedGaps: ResolvedGap[]`

### state.ts additions
- `addGapTarget(question: string, parentQuestion?: string): string` — push to `gapTargets` if not in `allQuestions` (dedup)
- `popNextGapTarget(): string | undefined` — shift FIFO
- `markGapTargetResolved(id: string, answer: string): void` — remove from queue, add to resolvedGaps
- `getResolvedGaps(): ResolvedGap[]`
- `hasPendingGapTargets(): boolean`

### gapAnalysis.ts changes
- `GapAnalyzer.analyze()`: after existing gap detection, also push new gap targets for unanswered sub-questions via a flag
- `GapFiller.pushGapTargets(questions: string[])`: batch-push to state, dedup internally

### orchestrator.ts changes
- In EDA loop EVALUATE step: `const nextGap = this.state.popNextGapTarget()` — if none, break to audit
- In ACT step for `fill_gaps`: after gap filling, call `GapFiller.pushGapTargets(evaluation.missingDimensions)` 
- Pass `currentGapTarget` through evaluation for context

---

## P2: Action Gating
**Files**: `orchestrator.ts`, `prompts.ts`
**Goal**: Disable actions based on state to constrain LLM decisions.

### orchestrator.ts changes
Add gating flags in EDA loop:
```typescript
interface ActionGates {
  allowAnswer: boolean;
  allowSearch: boolean;
  allowExtract: boolean;
  allowDiscover: boolean;
}
```
Initialize all true at loop start. After each action:
- After `fill_gaps` if gaps resolved → `allowAnswer = false` immediately
- After discover with >=50 sources → `allowSearch = false`, `allowDiscover = false`
- After extract with 0 new findings → `allowExtract = false`
- Reset gates when budget exhausted (in synthesizePartial)

Pass gates to `decideAction()` — filter out gate-blocked actions from the valid actions list sent to the LLM.

### prompts.ts changes
In `ORCHESTRATOR_DECIDE`: add clause:
```
ACTIONS MAY BE RESTRICTED. The following actions are currently available:
- [available actions list]
Do not suggest actions outside this list.
```

---

## P3: Knowledge as Conversation Pairs
**Files**: `state.ts`, `synthesis.ts`, `prompts.ts`
**Goal**: Store findings as user/assistant message pairs for LLM-native context.

### state.ts additions
```typescript
getKnowledgeMessages(): { role: 'user' | 'assistant'; content: string }[] {
  const messages = [];
  for (const f of this.state.findings) {
    messages.push({ role: 'user', content: `Research sub-question: ${f.claim}` });
    messages.push({
      role: 'assistant',
      content: `Evidence from ${f.sourceIds.length} source(s): ${f.evidenceExcerpt ?? f.evidenceSummary}`
    });
  }
  return messages;
}
```

### synthesis.ts changes
In `buildStateSummary()`, add a field:
```typescript
conversationKnowledge: this.getKnowledgeMessages()
```
Also expose this in the summary structure.

### prompts.ts changes
In `ORCHESTRATOR_SYNTHESIS`: add paragraph explaining the conversation knowledge format and instructing to use it alongside structured data.

---

## P4: LLM-Powered Query Rewriting
**Files**: `prompts.ts`, `discovery.ts`, `types.ts`
**Goal**: Use LLM to generate optimized search queries with time/location filters.

### prompts.ts additions
```typescript
export const WORKER_REWRITE_QUERY = `You are a search query optimizer...`;
```
Prompt instructs: given sub-question + context, output `{ queries: [{ q: string, tbs?: string, location?: string }] }`.

### discovery.ts changes
In `DiscoveryEngine`:
- Accept optional `DeepResearchLlmClient` reference (via constructor or method param)
- In `discoverForSubQuestion()`, before calling search backends, optionally call LLM:
```typescript
private async rewriteQueries(sq: SubQuestion, llm?: DeepResearchLlmClient): Promise<string[]> {
  if (!llm) return buildSearchQueries(sq);
  const result = await llm.callJSON({ model: 'worker', messages: [
    { role: 'system', content: WORKER_REWRITE_QUERY },
    { role: 'user', content: `Sub-question: ${sq.text}\nContext: ${sq.classification} query requiring ${sq.freshnessRequirement} freshness` }
  ]});
  if (!result.success) return buildSearchQueries(sq);
  return result.data.queries.map((q: any) => q.q);
}
```
Use `rewriteQueries()` in `searchWeb()` instead of `buildSearchQueries()`.
Remove `buildSearchQueries()` calls and replace with `rewriteQueries(sq, this.llm)`.

### types.ts additions
Extend `DiscoveryConfig`:
```typescript
interface DiscoveryConfig {
  maxCandidatesPerSubQuestion: number;
  maxTotalCandidates: number;
  enableQueryRewriting: boolean;  // new
}
```

---

## P5: SERP Clustering
**Files**: `discovery.ts`, `types.ts`, `prompts.ts`
**Goal**: Group search results into insight clusters.

### types.ts additions
```typescript
export interface SearchCluster {
  insight: string;
  question: string;
  urls: string[];
}
```
Add to `ResearchState`:
- `searchClusters: SearchCluster[]`

### discovery.ts additions
After `deduplicate()` and before `rankCandidates()`:
```typescript
private async clusterCandidates(candidates: ScoredCandidate[], llm?: DeepResearchLlmClient): Promise<SearchCluster[]> {
  if (!llm || candidates.length < 3) return [];
  const titlesAndSnippets = candidates.slice(0, 15).map(c => `${c.title}: ${c.snippet.slice(0, 200)}`).join('\n');
  const result = await llm.callJSON({ model: 'worker', messages: [...] });
  if (!result.success) return [];
  return result.data.clusters ?? [];
}
```
Store clusters in state via a new `state.addSearchClusters(clusters)` method.

### prompts.ts additions
```typescript
export const WORKER_CLUSTER = `You are a search result clustering assistant...`;
```
Prompt: group search results into MAX 5 clusters with insight, follow-up question, and matching URLs.

---

## P6: Failure Analysis
**Files**: `gapAnalysis.ts`, `orchestrator.ts`, `prompts.ts`, `types.ts`
**Goal**: Analyze why answers fail and inject learnings.

### types.ts additions
```typescript
export interface FailureAnalysis {
  recap: string;
  blame: string;
  improvement: string;
}
```

### gapAnalysis.ts additions
```typescript
export class FailureAnalyzer {
  constructor(private state: ResearchStateEngine, private llm?: DeepResearchLlmClient) {}
  
  async analyzeFailure(question: string, answer: string, evaluationFeedback: string): Promise<FailureAnalysis> {
    if (this.llm) {
      const result = await this.llm.callJSON({ model: 'worker', messages: [
        { role: 'system', content: WORKER_FAILURE_ANALYSIS },
        { role: 'user', content: `Question: ${question}\nFailed answer: ${answer}\nEvaluation feedback: ${evaluationFeedback}` }
      ]});
      if (result.success) return result.data;
    }
    return { recap: 'Answer was insufficient', blame: 'Missing evidence', improvement: 'Search with different keywords' };
  }
}
```

### prompts.ts additions
```typescript
export const WORKER_FAILURE_ANALYSIS = `You analyze why...`;
```

### orchestrator.ts changes
In EDA loop, after `fill_gaps` fails an answer evaluation:
- Call `FailureAnalyzer.analyzeFailure()`
- Store result as a GapRecord with `category: 'unanswered_sub_question'` and the improvement as a suggested action
- Push new gap targets from `missingDimensions`

---

## P7: Diary Narrative
**Files**: `state.ts`, `types.ts`, `orchestrator.ts`, `synthesis.ts`, `prompts.ts`
**Goal**: Human-readable step log.

### types.ts additions
Add to `ResearchState`:
- `diary: string[]`

### state.ts additions
- `appendDiary(entry: string): void` — push to `this.state.diary`, trim to last 50
- `getDiary(): string[]` — return copy

### orchestrator.ts changes
In each EDA loop iteration, after ACT:
```typescript
this.state.appendDiary(
  `Step ${loopCount}: Took **${decision.action}** action. ` +
  `Found ${newSources} new sources, ${newFindings} findings. Gaps: ${gaps.length}.`
);
```
Also in Phase 2 and Phase 3:
```typescript
this.state.appendDiary(`Phase discovery: found ${sourcesCount} sources across ${subQuestionsCount} sub-questions.`);
this.state.appendDiary(`Phase extraction: extracted ${findings.length} findings from ${extractionCount} sources.`);
```

### synthesis.ts changes
- Add `diary: state.diary` to `ResearchStateSummary`

### prompts.ts changes
In `ORCHESTRATOR_EVALUATE` and `ORCHESTRATOR_SYNTHESIS`: add "Research diary" as an optional context field.

---

## P8: Language Detection
**Files**: new `language.ts`, `chat.ts`, `prompts.ts`, `state.ts`, `types.ts`, `orchestrator.ts`
**Goal**: Auto-detect query language and parameterize prompts.

### types.ts additions
```typescript
export interface LanguageProfile {
  code: string;    // ISO 639-1
  style: string;   // formal, casual, technical, persuasive
}
```
Add to `ResearchState`:
- `language?: LanguageProfile`

### new language.ts
```typescript
const KNOWN_LANGS: Record<string, string> = { en: 'English', ... };

export class LanguageDetector {
  static detect(query: string, llm?: DeepResearchLlmClient): Promise<LanguageProfile> {
    // Check ASCII range → likely English
    // Else call LLM or return default English/formal
  }
}
```

### state.ts additions
- `setLanguage(profile: LanguageProfile): void`
- `getLanguage(): LanguageProfile | undefined`

### orchestrator.ts changes
At start of `run()`, after getting query:
```typescript
const langProfile = await LanguageDetector.detect(query, this.llm);
this.state.setLanguage(langProfile);
```
Pass `langProfile` to all LLM prompt builders (add as a parameter to prompt functions).

### prompts.ts changes
Add `parameterizePrompt(prompt: string, lang: LanguageProfile): string` utility that wraps prompt text with language/style instructions.

### chat.ts changes
No direct changes needed — prompts already accept content strings.

---

## P9: Multi-Signal URL Ranking
**Files**: `discovery.ts`, `types.ts`
**Goal**: Enhanced URL ranking with frequency, domain authority, and hostname diversity.

### types.ts additions
```typescript
export interface ScoredCandidate extends SourceCandidate {
  freqBoost: number;
  authorityBoost: number;
  diversityScore: number;
}
```

### discovery.ts changes
- Rename internal scored type to `ScoredCandidate`
- In `scoreCandidates()`:
  1. **Frequency boost**: Count URL occurrences, apply `1 + (count - 1) * 0.1` multiplier
  2. **Domain authority boost**: Check `AUTHORITY_DOMAINS` set, apply 1.15×
  3. **Path structure score**: Depth decay — more path segments = slight penalty (0.95^depth)
- In `rankCandidates()`: after scoring, filter `keepKPerHostname(results, 2)` — enforce max 2 per domain
- Update scoring weights to account for new signals

---

## P10: Streaming Progress Actions
**Files**: `progress.ts`, `state.ts`, `orchestrator.ts`, `types.ts`
**Goal**: Step-level action events for streaming.

### types.ts additions
Add to `ResearchProgress` union:
```typescript
| { phase: 'action'; actionType: 'search' | 'visit' | 'extract' | 'evaluate' | 'audit' | 'synthesize'; detail: string; timestamp: string }
```

### progress.ts changes
Add methods:
```typescript
reportAction(actionType: string, detail: string): void {
  this.timeline.push({ phase: 'action', actionType, detail, timestamp: new Date().toISOString() });
}
```

### state.ts changes
In `appendDiary()`, also emit progress event for significant entries.

### orchestrator.ts changes
In ACT phase, emit action events:
```typescript
this.progress.reportAction('search', `Searching: ${queries}`);
this.progress.reportAction('extract', `Extracting from ${count} sources`);
this.progress.reportAction('evaluate', `Evaluating state at loop ${loopCount}`);
this.progress.reportAction('audit', `Running audit`);
this.progress.reportAction('synthesize', `Generating synthesis report`);
```
In `reportProgress()` callback, include action events when phase is 'action'.
