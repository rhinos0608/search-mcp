# gpt-researcher Pattern Integration Plan

## Overview

Integrate key patterns from upstream gpt-researcher into our deep research orchestration engine.

## Phase 1: Tree-Based Recursive Deep Research (High Impact)

### What
Add a `DeepTreeResearchEngine` class that implements gpt-researcher's breadth×depth recursive tree search, running as an alternative path in the orchestrator.

### gpt-researcher reference
- `gpt_researcher/skills/deep_research.py` — `DeepResearchSkill` class
- Key methods: `generate_search_queries()`, `deep_research()`, `process_research_results()`
- Pattern: recursive `deep_research(query, breadth, depth)` calling itself with `depth-1`
- Parallelism: `asyncio.gather` with `asyncio.Semaphore`

### Our additions
1. `src/research/treeEngine.ts` — `DeepTreeResearchEngine` class
2. New depth profile `tree` in `types.ts` (adds `treeBreadth`, `treeDepth`, `treeConcurrency` fields to `BudgetProfile`)
3. `src/research/llm/prompts.ts` — add `TREE_GENERATE_QUERIES` and `TREE_PROCESS_RESULTS` prompts
4. `orchestrator.ts` — wire tree engine as alternative path when depth profile is tree-based

### Types to add
```typescript
export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive' | 'tree';

// Extended profile for tree mode
export interface TreeProfile {
  treeBreadth: number;       // number of parallel queries per level
  treeDepth: number;         // number of recursive levels
  treeConcurrency: number;   // concurrent queries per level
  treeContextWordLimit: number; // 25000 from gpt-researcher
}
```

## Phase 2: LLM-Based Sub-Query Seeding (Medium Impact)

### What
Replace/augment the rule-based `QueryDecomposer` with an LLM-based approach that seeds sub-questions from real search results.

### gpt-researcher reference
- `gpt_researcher/actions/query_processing.py` — `plan_research_outline()` → `generate_sub_queries()`
- Flow: initial web search → LLM generates sub-queries from search results
- Two-tier fallback: strategic_llm → smart_llm

### Our changes
1. `decomposer.ts` — Add `llmDecompose()` method that takes search results, calls LLM
2. New prompt `ORCHESTRATOR_DECOMPOSE` in prompts.ts
3. Wire fallback chain in orchestrator Phase 1

## Phase 3: LLM Fallback Chain (Low Effort, High Reliability)

### What
Add fallback from orchestrator model → worker model before going to rule-based.

### gpt-researcher reference
- `generate_sub_queries()` in query_processing.py:
  ```
  strategic_llm → retry(max_tokens) → smart_llm
  ```

### Our changes
1. `chat.ts` — Add `callWithFallback()` method that tries orchestrator, then worker, then returns error
2. `orchestrator.ts` — Use fallback in evaluate/decide/audit paths

## Phase 4: Per-Step Cost Tracking (Low Effort)

### What
Add per-step cost breakdown to BudgetTracker.

### gpt-researcher reference
- `agent.py` — `step_costs: dict[str, float]`, `add_costs(cost)`, `get_step_costs()`

### Our changes
1. `state.ts` — Add `stepCosts: Record<string, number>` to `BudgetState`, `recordStepCost(step, cost)` to `BudgetTracker`
2. `orchestrator.ts` — Track costs per phase

## File Change Summary

| File | Change |
|------|--------|
| `src/research/types.ts` | Add `tree` depth, TreeProfile, StepCost type |
| `src/research/state.ts` | Add stepCosts tracking, tree profile budget |
| `src/research/treeEngine.ts` | NEW — DeepTreeResearchEngine |
| `src/research/decomposer.ts` | Add LLM-based decompose option |
| `src/research/orchestrator.ts` | Wire tree engine, fallback chain, cost tracking |
| `src/research/llm/chat.ts` | Add callWithFallback() |
| `src/research/llm/prompts.ts` | Add tree generation/processing prompts, decompose prompt |
| `src/tools/families/research.ts` | Expose `tree` depth option |
