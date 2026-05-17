# Slice D — Research auto-routing and provenance

Date: 2026-05-17

## Goal

Add an ergonomic `research` family action that routes common research queries deterministically while preserving source-specific actions.

## Current-state notes

- `src/tools/families/research.ts` exposes many source-specific actions.
- `academic` can fan out with `source: "all"`, but callers still need to know when to use it.
- A cross-tool gateway is intentionally out of scope; this slice stays inside the existing `research` family.

## Implementation

1. Add an additive `auto` action to `src/tools/families/research.ts`.
2. Use deterministic query hints only:
   - DOI/arXiv/citation/paper hints prefer academic/arXiv paths.
   - Hacker News / Stack Overflow / Wikipedia hints route to those existing handlers when available.
   - Otherwise default to academic fan-out or the safest configured general research path.
3. Return provenance metadata indicating selected action/backend, skipped candidates, unavailable candidates, and fallback when applicable.
4. Keep every existing research action unchanged.
5. Do not create a cross-tool `scope: auto` router in this slice.

## Tests

- Add `test/researchAutoRouting.test.ts` for routing rules and fallback metadata with mocked handlers.

## Validation

```bash
npm run typecheck
npm test test/researchAutoRouting.test.ts
```
