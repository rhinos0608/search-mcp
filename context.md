# Code Context

## Files Retrieved
1. `src/research/strategies/agentStrategy.ts` - Found `findingCount: 0` hardcoded in progress reports and final report.
2. `src/research/strategies/pipelineStrategy.ts` - Found `subQuestionCount: questions.length` bug where it uses the current batch length instead of the total.
3. `src/research/orchestrator.ts` - Interface for `onProgress` and pass-through logic.
4. `src/research/state.ts` - Source of truth for findings, sources, sub-questions, and budget.
5. `src/research/synthesizer.ts` - Rule-based report generator. Computes `sourceTypeCount` correctly from `sources`.
6. `src/research/llm/synthesis.ts` - LLM-based report generator.
7. `src/research/compaction.ts` - Multi-layer compaction for MCP transport. Recomputes `CompactStatistics` but relies on `report.findingCount`.
8. `src/research/jobManager.ts` - In-memory job registry. Stores partials updated via `update()`.
9. `src/research/progress.ts` - Timeline tracker for progress UI.
10. `src/tools/deepResearch.ts` - MCP tool entry point. Mapping from orchestrator `onProgress` to `researchJobManager.update`. **FOUND BUG 7 HERE**: `sourceTypeCount` is hardcoded to `undefined`.

## Key Code

### 1. `findingCount` always 0
In `src/research/strategies/agentStrategy.ts` (lines 205, 262):
```typescript
findingCount: 0, // Agent doesn't track findings explicitly in state during loop
```
The agent strategy uses a `CitationCollector` instead of the full `ResearchStateEngine` for findings, so `findingCount` is never updated or reported.

### 2. `subQuestionCount` always 0 / wrong
In `src/research/strategies/pipelineStrategy.ts` (line 580):
```typescript
subQuestionCount: questions.length, // questions is the current BATCH, not total
```
Inside `spawnWorkers`, it reports the batch size as the total. Additionally, `agentStrategy` defaults it to 0.

### 3. `sourceTypeCount` always 0 (or 1)
In `src/tools/deepResearch.ts` (line 197), the mapper from orchestrator to job manager hardcodes it:
```typescript
sourceTypeCount: undefined,
```
When `complete()` is called in `jobManager.ts`, it pulls from the report, but interim progress updates always show no variety.

### 4. Themes, Contradictions, Uncertainties empty
These are only populated in the final `ResearchReport` generated at the end of the research in `synthesizer.ts` or `llm/synthesis.ts`. The `ResearchJobSnapshot` used for polling does not have fields for these, so the "live" view is always empty.

## Architecture
- **Source of Truth**: `ResearchStateEngine` (which wraps `ResearchState` and `BudgetTracker`).
- **Telemetry Flow**: 
    1. Strategy (Agent/Pipeline/Tree) calls `ctx.onProgress`.
    2. `ResearchOrchestrator.reportProgress` passes it to the `onProgress` callback.
    3. `src/tools/deepResearch.ts` callback receives it and calls `researchJobManager.update(jobId, partials)`.
    4. `ResearchJobManager` updates the `InternalJob` record, which is returned by `poll`.

## Bug Audit Results

| Bug | File | Line | Cause | Fix |
|---|---|---|---|---|
| **1. findingCount 0** | `agentStrategy.ts` | 205, 262 | Hardcoded to 0; agent uses collector, not state engine. | Return `this.collector.count` or sync collector to state. |
| **2. subQuestionCount 0** | `pipelineStrategy.ts` | 580 | Uses `questions.length` (batch) instead of `ctx.state.getSubQuestions().length`. | Use `ctx.state.getSubQuestions().length`. |
| **3. themes empty** | `jobManager.ts` | 43-51 | `ResearchJobPartial` interface lacks `themes`. | Add `themes` to `ResearchJobPartial`, update in `synthesizer`. |
| **4. contradictions empty** | `jobManager.ts` | 43-51 | `ResearchJobPartial` interface lacks `contradictions`. | Add to interface and progress callback. |
| **5. uncertainties empty** | `jobManager.ts` | 43-51 | `ResearchJobPartial` interface lacks `uncertainties`. | Add to interface. |
| **6. gapLoopCount 0** | `jobManager.ts` | 88 | UI may not be reading reaching the snapshot value. | Ensure `poll` returns the most recent `gapLoopCount`. |
| **7. sourceTypeCount 1** | `tools/deepResearch.ts` | 197 | Hardcoded to `undefined` in progress callback. | Pass `ctx.state.sourceTypeCount()` from strategies. |

## Start Here
Open `src/tools/deepResearch.ts` to fix the `sourceTypeCount` mapping, then `src/research/strategies/pipelineStrategy.ts` to fix the `subQuestionCount` logic.

The findings have been written to `/Users/rhinesharar/search-mcp/context.md`.