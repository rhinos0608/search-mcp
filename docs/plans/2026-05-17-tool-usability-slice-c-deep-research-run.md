# Slice C — `deep_research` run convenience action

Date: 2026-05-17

## Goal

Add a one-call happy path for deep research while preserving the existing job protocol.

## Current-state notes

- `src/tools/standalone/deepResearch.ts` currently supports `start`, `poll`, `list`, `cancel`, and `save`.
- Poll already blocks for a bounded window and can be reused for a convenience action.
- Long-running research must still return a `jobId` so clients can continue with `poll`.

## Implementation

1. Add `run` to the `deep_research` action enum.
2. Add optional `timeoutMs` with a conservative bounded default no greater than the current poll wait window.
3. Implement `handleRun` by starting a job and polling until completion, failure, cancellation, or timeout.
4. On timeout, return partial status with `jobId` and retry metadata containing a minimal `poll` call.
5. Keep `start`/`poll` behavior unchanged.

## Tests

- Add `test/deepResearchRun.test.ts` for:
  - completed run returns final result.
  - timeout returns partial status, `jobId`, and retry metadata.
  - existing `start`/`poll` actions remain accepted.

## Validation

```bash
npm run typecheck
npm test test/deepResearchRun.test.ts
```
