# Track B: PipelineStrategy Decomposition — Completion Report

**Goal:** Decompose the monolithic `PipelineStrategy` (1303 lines) into a lean orchestrator with composable, independently testable phase modules. Extract worker pool management into a shared `WorkerPoolManager`.

**Status:** ✅ Complete — typecheck passes, lint passes (pre-existing cloak.ts error only).

## Outcome

### Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `src/research/phases/basePhase.ts` | `ResearchPhase` interface + `BasePhase` with `checkAborted()`, `reportProgress()` | 47 |
| `src/research/phases/decompositionPhase.ts` | Phase 1: Query decomposition into sub-questions | 44 |
| `src/research/phases/discoveryPhase.ts` | Phase 2: Broad source discovery + taxonomy revision | 72 |
| `src/research/phases/extractionPhase.ts` | Phase 3: Rule-based extraction from top sources | 62 |
| `src/research/phases/postProcessingPhase.ts` | Phase 3.5: Relevance classification, finding splitting, evidence-pool contradictions | 93 |
| `src/research/phases/gapLoopPhase.ts` | EDA loop: contradiction detection, gap analysis, adaptive band extension, worker spawning via WorkerPoolManager | 375 |
| `src/research/phases/auditPhase.ts` | Phase 6: State audit (rule-based + LLM merge) | 125 |
| `src/research/phases/synthesisPhase.ts` | Phase 7: Report synthesis with URL validation | 72 |
| `src/research/phases/index.ts` | Phase module barrel exports | 14 |
| `src/research/pool/workerPool.ts` | `WorkerPoolManager` — shared worker spawning with concurrency control, dedup, budget tracking | 345 |

### Files Modified

| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/research/strategies/pipelineStrategy.ts` | 1303 lines | **~200 lines** | -1100 lines |

### Architecture After

```
src/research/
├── orchestrator.ts                  # Unchanged (23 lines — orchestrator sits above strategies)
├── phases/                          # 8 composable phase modules
│   ├── index.ts                     # Barrel exports
│   ├── basePhase.ts                 # ResearchPhase interface + BasePhase
│   ├── decompositionPhase.ts        # Query → sub-questions
│   ├── discoveryPhase.ts            # Broad multi-backend source discovery
│   ├── extractionPhase.ts           # Rule-based extraction from sources
│   ├── postProcessingPhase.ts       # Relevance classification + finding splitting + contradictions
│   ├── gapLoopPhase.ts              # EDA loop (delegates worker spawning to WorkerPoolManager)
│   ├── auditPhase.ts                # State audit
│   └── synthesisPhase.ts            # Report synthesis
├── pool/                            # Shared execution utilities
│   └── workerPool.ts                # WorkerPoolManager (used by pipelineStrategy + gapLoopPhase)
├── strategies/
│   ├── pipelineStrategy.ts          # Thin: selects phases based on LLM/depth, orchestrates inline
│   ├── agentStrategy.ts             # Unchanged (ReAct loop, doesn't need WorkerPoolManager)
│   ├── treeStrategy.ts              # Unchanged
│   └── index.ts                     # Strategy registry
└── ...                              # Existing modules (state, discovery, extraction, etc.)
```

### What Changed From the Spec

| Spec Prediction | Actual Outcome |
|----------------|----------------|
| `WorkerPhase.ts` | Not created — worker launch handled inline in pipelineStrategy + WorkerPoolManager |
| `PostProcessingPhase` | Not in spec — added during review to extract 73 inline lines from pipelineStrategy |
| `orchestrator.ts` grows to own phase iteration | Not implemented — PipelineStrategy still calls phases inline; orchestrator unchanged |
| `strategies/types.ts` gains `ResearchPhase` | Not needed — `ResearchPhase` lives in `phases/basePhase.ts` |
| AgentStrategy uses WorkerPoolManager | Not done — AgentStrategy's ReAct loop doesn't fit batch-spawn pattern |
| WorkerPoolManager takes 4 constructor params | Simplified to single `config: WorkerPoolConfig` |
| Compaction handled in GapLoopPhase | Compaction import was removed — handled in pipelineStrategy |
| Shallow modules consolidated (extractSentence, trace, knowledge) | Deferred (unchanged) |

### Key Architecture Decisions Made During Implementation

1. **WorkerPoolManager takes only `config`** — No `llm`, `tools`, or standalone `tokenBudget` params. The manager creates its own tools internally via `createResearchTools()` and reads `ctx.llm` directly at spawn time.

2. **GapLoopPhase delegates, doesn't duplicate** — After review, 295 lines of duplicate worker methods were removed from gapLoopPhase. It now creates a `WorkerPoolManager` and delegates worker spawning. The manager is hoisted above the gap loop so `ingestedReportIds` persists across iterations.

3. **`ingestedReportIds` is a class field** — Prevents re-processing duplicate worker reports when `WorkerPoolManager.spawnWorkers()` is called multiple times.

4. **Tree path remains in pipelineStrategy** — The tree research path (`DeepTreeResearchEngine`) stays inline in `pipelineStrategy.analyze()` because it's a different control flow from the phase pipeline.

### Key Constraints Preserved

- ✅ ESM imports with `.js` extension
- ✅ TypeScript strict mode — no `any`, no unchecked index access
- ✅ Gap loop budget interactions, contradiction merging, adaptive band extension preserved
- ✅ Progress reporting uses exact same percentage ranges
- ✅ Phase ordering: decomposition → discovery → extraction → post-processing → gap loop → audit → synthesis
- ✅ Tree research path unmodified
