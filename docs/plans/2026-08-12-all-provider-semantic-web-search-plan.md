# All-Provider Semantic Web Search Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Query every configured web-search backend in parallel, retain Codex-first deduplicated results, and semantically rerank final unique results when embedding is usable.

**Approach:** Make `resolveBackends()` return Codex first plus all provider candidates regardless of explicit `SEARCH_BACKEND`; availability filtering remains responsible for configuration, circuit, and degraded state. Reuse `semanticMatch()` once after all query-variation results are deduplicated, then restore Codex-first partition and citation positions. Treat embedding errors as non-fatal and retain lexical rank.

**Riskiest assumption:** `SEARCH_BACKEND` may change from hard pin to ordering preference. User approved this incompatible behavior change.

## Decisions to review

- `SEARCH_BACKEND` is ordering preference, not scope. All available backends run. Cost: higher request volume; preserves existing configuration gate and circuit breaker.
- Semantic ranking runs once after cross-variation URL dedup on `title + description`; it does not make outbound reads. Failure preserves existing rank.
- A provider is usable for reranking when sidecar has base URL, or embedding provider is `ollama`, `transformers`, or `openai`. This matches embedding dispatch, not old base-URL-only gates.

## Known unknowns

- Embedding availability is configuration-based; runtime failure falls back to lexical order and logs a safe warning.
- Search callers besides MCP `web_search` share `webSearch()`. Semantic ranking applies consistently to all callers when embedding is usable.

## Global Constraints

- No dependency changes.
- Keep Codex endpoint fixed and credentials secret-safe.
- Preserve existing user-owned browser-default diff in `src/config.ts`.

---

### Task 1: All-provider fanout contract tests

**Outcome:** Tests demonstrate explicit selections no longer suppress available providers; Codex duplicate provenance and priority remain intact.

**Files:**

- Modify/test: `test/codexSearch.test.ts`, `test/webSearch.test.ts`

**Interfaces:**

- Consumes: `searchWithBackends()`, `resolveBackends()`
- Produces: executable contract for backend fanout and final ordering

**Checks:**

- Red: focused Node test fails under current explicit-pin behavior.
- Green: focused Node test proves configured Codex and explicit selected backend both execute, dedupe URL, and preserve Codex-first ordering.

- [x] Implement one focused regression test and run it before implementation.

### Task 2: Semantic final-rank tests

**Outcome:** Tests demonstrate provider-aware semantic rerank over final unique results, preserved Codex-first partition, positions, and graceful embed failure.

**Files:**

- Modify/test: `test/webSearch.test.ts`, optionally `test/codexSearch.test.ts`

**Interfaces:**

- Consumes: `WebSearchDeps`, `SearchConfig`, `semanticMatch()` behavior
- Produces: executable ranking/degradation contract

**Checks:**

- Red: focused test fails because no semantic ranking occurs after dedup.
- Green: mockable semantic rank changes order within Codex partition; unavailable/failing embedding retains lexical result set/order.

- [x] Add one vertical-slice test and run it before implementation.

### Task 3: Runtime backend resolution and semantic rerank

**Outcome:** Every configured available provider is queried; final unique result set semantically reranks when embedding is usable, while Codex remains main source.

**Files:**

- Modify: `src/tools/webSearch.ts`, `src/tools/standalone/webSearch.ts`, `src/health.ts`
- Reuse: `src/utils/semanticMatch.ts`
- Modify/test: `test/codexSearch.test.ts`, `test/webSearch.test.ts`

**Interfaces:**

- `resolveBackends()` returns Codex-first full candidate ordering; explicit selection controls preferred order only.
- `WebSearchDeps` gains optional injectable semantic matcher only if needed for hermetic tests.
- Semantic matcher receives original/effective query, final deduplicated items, `title + description`, active embedding settings, and candidate count.

**Checks:**

- Green: focused web-search tests pass; semantic failure returns normal deduplicated rank.
- Green: `npm run typecheck`, `npm run lint`, `npm run format:check`.

- [x] Implement smallest code needed for each red test.
- [x] Update MCP tool text and health ordering to match all-provider contract.

### Task 4: Full verification and adversarial review

**Outcome:** Diff is formatted, type-safe, tested, and independently reviewed for ordering/provenance/credential regressions.

**Files:**

- Review: all changed files

**Checks:**

- `git diff --check`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- Fresh reviewer validates all-provider semantics, semantic fallback, Codex provenance, health parity, and documentation.

- [x] Run checks once after final code change.
- [x] Inspect final diff and address confirmed review findings.
