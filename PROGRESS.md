# Progress

## Status
In Progress

### Completed: prompts.ts `contradiction_scan` action
- Added `contradiction_scan` to ORCHESTRATOR_DECIDE valid actions list (after `fill_gaps`)
- Added comment block at top of file noting action naming conventions and internal actions

### Completed: confidence.ts fixes
- Updated `domainTrustScore` JSDoc to clarify it's optional with 0.5 default
- Added NaN propagation guard in `computeExtractionConfidence` using `typeof === 'number' && isFinite()` clamp

### Completed: chat.ts assertSafeUrl + budget comment
- Changed `assertSafeUrl(endpoint)` → `assertSafeUrl(endpoint, true)` at callModel's URL assertion — allows operator-configured local endpoints (Ollama, LM Studio)

### Completed: synthesis.ts fixes
- Added `classification` and `depth` type-guard checks in `isResearchReport()`
- Removed dead `state.budget` ternary in `buildStateSummary()` — budget is always present
- Added `claimEdgeCount` and `budgetRemaining` to `ResearchStateSummary` interface and builder
- Added `max*` fields to `BudgetState` to support budget-remaining computation
- Updated `BudgetTracker` constructor to populate `max*` fields from profile

- [x] Remove `void await` in 3 extractPendingSources() calls
- [x] Remove unused startTime param from synthesizePartial + update 3 callers
- [x] Normalize descriptions in audit dedup + add `passed` field merge
- [x] Add `toSafeNumber` guard for audit stats Number() calls
- [x] Run typecheck — passes
- `src/research/llm/prompts.ts` — added `contradiction_scan` action entry + naming convention comment
- `src/research/confidence.ts` — updated domainTrustScore JSDoc; added NaN-safe riskScore clamping
- `src/research/llm/chat.ts` — changed assertSafeUrl to allow local endpoints; added budget comment
- `src/research/orchestrator.ts` — 5 targeted fixes applied (void await, synthesizePartial param, dedup normalize, passed merge, toSafeNumber guard)

## Notes
