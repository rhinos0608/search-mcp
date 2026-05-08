# Progress

## Status
Completed telemetry bug fixes for research strategies.

## Tasks
- [x] Fix `subQuestionCount` in `pipelineStrategy.ts`
- [x] Add `sourceTypeCount` to all `onProgress` calls in `pipelineStrategy.ts`
- [x] Add `getSourceTypeCount` helper method to `PipelineStrategy`
- [x] Ensure `findingCount` uses `ctx.state.findingCount()`
- [x] Wire up `sourceTypeCount` and `gapLoopCount` in `deepResearch.ts`
- [x] Update `ProgressCallback` type in `orchestrator.ts`
- [x] Add and wire `gapLoopCount` in `jobManager.ts`

## Files Changed
- `src/research/strategies/pipelineStrategy.ts`
- `src/tools/deepResearch.ts`
- `src/research/orchestrator.ts`
- `src/research/jobManager.ts`

## Notes
- `PipelineStrategy.reportProgress` now automatically injects `sourceCount`, `findingCount`, `subQuestionCount`, and `sourceTypeCount` from global state if not explicitly overridden.
- `gapLoopCount` is now correctly tracked in the job manager and visible via `poll` / `list` snapshots.
