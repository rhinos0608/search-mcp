# 2026-05-11 — Free Backends Implementation Plan

**Status**: In Progress  
**Parent Spec**: [Free Backends Implementation Spec](./2026-05-11-free-backends-implementation-spec.md)  
**Research**: [Free Backends Expansion Plan](./2026-05-08-free-backends-expansion-plan.md)

## Overview

4 implementation phases, executed by subagents with mandatory reviewer checkpoints after each phase.

- **Phase 1**: 4 modules (OpenAlex, Crossref, DataCite, ROR) — scholarly
- **Phase 2**: 3 modules (Semantic Scholar direct, GDELT, Wikidata) — news/entity
- **Phase 3**: Family wiring + health probes
- **Phase 4**: Tests

Each phase: **implement → review → fix → re-review → approved → next phase**.

## Phase 1 — Scholarly Backends (4 modules)

**Files to create:**
- `src/tools/openalexSearch.ts`
- `src/tools/crossrefSearch.ts`
- `src/tools/dataciteSearch.ts`
- `src/tools/rorSearch.ts`

**Pattern**: Each module exports one `search{Foo}(query, limit): Promise<FooResult[]>` function following `wikipediaSearch.ts`/`pubmedSearch.ts` conventions.

**Subagent**: `implementer` — writes all 4 modules in one step.
**Reviewer**: `reviewer` — validates against spec, codebase patterns, type-safety, error handling.

### Phase 1 Acceptance
- [ ] `openalexSearch.ts` — reconstructs abstract from `abstract_inverted_index` or uses topic description
- [ ] `crossrefSearch.ts` — parses Crossref `items` array into flat results
- [ ] `dataciteSearch.ts` — parses JSON:API format correctly
- [ ] `rorSearch.ts` — handles small result sets from ROR lookup
- [ ] All modules: `safeResponseJson`, `AbortSignal.timeout`, `User-Agent` header, try/catch with `logger.warn`
- [ ] No unused imports, correct `.js` extensions on local imports

## Phase 2 — News/Entity Backends (3 modules)

**Files to create:**
- `src/tools/semanticScholarSearch.ts`
- `src/tools/gdeltSearch.ts`
- `src/tools/wikidataSearch.ts`

**Subagent**: `implementer` — writes all 3 modules.
**Reviewer**: `reviewer`.

### Phase 2 Acceptance
- [ ] `semanticScholarSearch.ts` — direct Semantic Scholar call, independent of `academicSearch.ts`
- [ ] `gdeltSearch.ts` — handles GDELT JSON articles array, tone field, timespan parameter
- [ ] `wikidataSearch.ts` — uses `wbsearchentities` search API
- [ ] All modules follow same patterns as Phase 1

## Phase 3 — Family Wiring + Health

**Files to modify:**
- `src/tools/families/research.ts` — add 7 new actions
- `src/health.ts` — add 6 new network probes (Semantic Scholar already exists)

**Subagent**: `implementer` — does both edits.
**Reviewer**: `reviewer`.

### Phase 3 Acceptance
- [ ] 7 new `z.object({ action: z.literal(...), ... })` schemas in `research.ts`
- [ ] 7 new entries in `researchFamily.actions[]`
- [ ] Family description updated
- [ ] `getNetworkProbes()` updated with 6 new probe entries
- [ ] All probes point at the correct test URLs
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes

## Phase 4 — Tests

**Files to create:**
- `src/tools/__tests__/openalexSearch.test.ts`
- `src/tools/__tests__/crossrefSearch.test.ts`
- `src/tools/__tests__/dataciteSearch.test.ts`
- `src/tools/__tests__/rorSearch.test.ts`
- `src/tools/__tests__/semanticScholarSearch.test.ts`
- `src/tools/__tests__/gdeltSearch.test.ts`
- `src/tools/__tests__/wikidataSearch.test.ts`

**Subagent**: `implementer` — writes all 7 test files.
**Reviewer**: `reviewer`. Then runs `npx vitest run src/tools/__tests__/openalexSearch.test.ts src/tools/__tests__/crossrefSearch.test.ts src/tools/__tests__/dataciteSearch.test.ts src/tools/__tests__/rorSearch.test.ts src/tools/__tests__/semanticScholarSearch.test.ts src/tools/__tests__/gdeltSearch.test.ts src/tools/__tests__/wikidataSearch.test.ts`.

### Phase 4 Acceptance
- [ ] Each test file covers: valid query returns results, limit respected, empty query handled
- [ ] All 7 test suites pass (network-dependent tests may need skip logic for CI)
- [ ] Test files import from correct `.js` paths

## Final Verification

After all phases pass review:

```bash
npm run typecheck   # must pass
npm run lint        # must pass
npm run build       # must succeed
```

## Rollback

If any phase is blocked after 3 rounds of fix/review, stop and report the blocker. No partial registration — all 7 actions go in together.

## Not Doing

- Shared helper layer (`apiClient.ts`, `pagination.ts`, `normalize.ts`) — deferred until Wave 2 proves the pattern
- Wave 2 backends (World Bank, FRED, Census, SEC)
- Rate-limit tracking — all free backends have generous/no limits
- Cross-backend dedup/merge — each action is independent
