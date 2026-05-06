# gpt-researcher Pattern Integration Plan

## Overview

Integration of key patterns from upstream gpt-researcher into our deep research orchestration engine.

## ✅ Phase 1: Tree-Based Recursive Deep Research (Implemented)

`DeepTreeResearchEngine` (`src/research/treeEngine.ts`) implements gpt-researcher's breadth×depth recursive tree search. Wired into the orchestrator as an alternative path when depth profile is `tree`. The `tree` depth is available in the `deep_research` tool schema.

Key files:
- `src/research/treeEngine.ts` — `DeepTreeResearchEngine`
- `src/research/types.ts` — `ResearchDepth` includes `'tree'`; `TreeProfile` with `treeBreadth`, `treeDepth`, `treeConcurrency`, `treeContextWordLimit`
- `src/research/llm/prompts.ts` — `TREE_GENERATE_QUERIES` and `TREE_PROCESS_RESULTS` prompts
- `src/research/orchestrator.ts` — tree path dispatch in `run()` that bypasses Phases 2–5

## ✅ Phase 2: LLM-Based Sub-Query Seeding (Implemented)

`decomposer.ts` has `QueryDecomposer.llmDecompose()` which takes search results and uses the LLM to generate sub-questions. Falls back to rule-based `decompose()` when LLM is unavailable.

## ✅ Phase 3: LLM Fallback Chain (Implemented)

`chat.ts` has `DeepResearchLlmClient.callWithFallback()` which tries the orchestrator model first, then the worker model, before returning an error. Used in evaluate/decide/audit paths.

## ✅ Phase 4: Per-Step Cost Tracking (Implemented)

`state.ts` has `BudgetTracker.recordStepCost(step, cost)` and `stepCosts: Record<string, number>` on `BudgetState`. The orchestrator tracks costs per phase.

## File Change Summary (historical)

| File | Change |
|------|--------|
| `src/research/types.ts` | Added `tree` depth, TreeProfile, StepCost type |
| `src/research/state.ts` | Added stepCosts tracking, tree profile budget |
| `src/research/treeEngine.ts` | NEW — DeepTreeResearchEngine |
| `src/research/decomposer.ts` | Added LLM-based decompose option |
| `src/research/orchestrator.ts` | Wired tree engine, fallback chain, cost tracking |
| `src/research/llm/chat.ts` | Added callWithFallback() |
| `src/research/llm/prompts.ts` | Added tree generation/processing prompts, decompose prompt |
| `src/tools/families/research.ts` | Exposed `tree` depth option |
