# V3.3.1 — Implementation Plan

**Based On**: `docs/plans/v3.3.1/SPEC.md`  
**Date**: 2026-05-01  
**Status**: Planning

## Strategy

Ship the new backends in thin slices:

1. Add the provider contracts and config surface.
2. Add DuckDuckGo as the zero-key fallback.
3. Add Ollama web search as the opt-in account-gated fallback.
4. Rework backend resolution so out-of-box providers are preferred when no backend is pinned.
5. Wire everything into the existing merge/fusion path and docs.

Keep `mergeSearchBackends` opt-in. The point is better zero-config coverage, not a new ranking system.

---

## Phase 0: Contracts + Config

### Goals

- Expand backend types.
- Decide the explicit vs auto-selected backend path.
- Keep the current `web_search` tool contract stable.

### Files

- `src/config.ts`
- `src/types.ts`
- `src/server.ts` (only if new config fields need schema exposure)

### Tasks

- Add `duckduckgo` and `ollama-search` to the backend type union.
- Extend `VALID_BACKENDS` / backend validation and `SearchResult.source` so the new labels are accepted everywhere.
- Add a backend resolution mode that can prefer availability over static defaulting.
- Add `SEARCH_OLLAMA_BASE_URL` / `SEARCH_OLLAMA_API_KEY` (and any needed DuckDuckGo region/safesearch knobs) so search config does not collide with `EMBEDDING_OLLAMA_*`.
- Keep existing Brave / Exa / SearXNG config behavior unchanged.

### Exit Criteria

- Code compiles with the new backend names.
- Existing provider selection still works when explicitly pinned.
- No behavioral change yet for search execution.

---

## Phase 1: DuckDuckGo Provider

### Goals

- Add a true zero-key search backend.
- Keep it small and forgiving.

### Files

- `src/tools/duckduckgoSearch.ts` (new)
- `src/tools/webSearch.ts`
- `src/types.ts`
- `test/duckduckgoSearch.test.ts` (new)

### Tasks

- Implement HTML-based DuckDuckGo result parsing.
- Normalize URLs, domains, snippets, and age metadata into `SearchResult`.
- Use a short timeout and conservative retries.
- Mark the backend as experimental in logs and docs.

### Exit Criteria

- `web_search` returns results from DuckDuckGo with no API key.
- The backend fails cleanly on bot pages or HTML shape drift.
- Unit tests cover parsing and normalization.

---

## Phase 2: Ollama Web Search Provider

### Goals

- Add an opt-in account-gated path for users who want an Ollama-backed search option.
- Support both configured host and hosted Ollama modes if the config already knows how.

### Files

- `src/tools/ollamaSearch.ts` (new)
- `src/tools/webSearch.ts`
- `src/config.ts`
- `src/types.ts`
- `test/ollamaSearch.test.ts` (new)

### Tasks

- Implement Ollama web-search calls against the configured host/API.
- Support optional bearer auth / API key when required.
- Return structured search results in the same `SearchResult` shape as the other providers.
- Treat host reachability and sign-in as availability, not as fatal startup failures.

### Exit Criteria

- A configured Ollama account/API key can answer search queries without a paid search API.
- The provider falls back cleanly when Ollama is missing or unreachable.
- Tests cover both local and hosted-style config paths.

---

## Phase 3: Backend Resolution + Merge

### Goals

- Make the zero-config path land on the best available backend.
- Preserve the existing merge/fusion stack.

### Files

- `src/tools/webSearch.ts`
- `src/utils/searchMerge.ts`
- `src/utils/fusion.ts`
- `src/server.ts`
- `src/types.ts`

### Tasks

- Replace the static “primary + fallback” assumption with availability-aware selection.
- Prefer explicit provider overrides first.
- Prefer key-free providers when no explicit backend is pinned, then keep Ollama as an opt-in fallback.
- Keep `mergeSearchBackends` opt-in, but ensure DuckDuckGo and Ollama participate when merge is requested.
- Expand source labels and any engine-agreement logic needed for the new backends.

### Exit Criteria

- A no-key install uses a sensible backend automatically.
- Multi-backend merge still dedupes by canonical URL.
- Existing Brave / Exa / SearXNG behavior remains intact.

---

## Phase 4: Docs, Examples, Verification

### Goals

- Keep docs current.
- Prove the new backends work in the intended setups.

### Files

- `docs/plans/index.md`
- `README.md` or `docs/tools.md` only if user-facing setup text needs it
- `config.example.json` if new operator config is added

### Tasks

- Add the v3.3.1 plan section to the roadmap index.
- Document the zero-key / opt-in backend classes and explicitly distinguish search backends from `EMBEDDING_PROVIDER=ollama`.
- Add smoke-test cases for:
  - no keys present
  - DuckDuckGo available
  - Ollama host available
  - merge path with two backends
- Run diff check plus the narrowest relevant tests.

### Exit Criteria

- Docs describe the new backend roster and selection rules.
- Smoke tests prove the no-key path works.
- The diff stays clean and reviewable.

---

## Rollout Notes

- Do not change query expansion while doing this work.
- Do not touch crawl4ai/browser automation.
- Keep the provider adapters thin; the point is backend diversity, not a new search engine abstraction.
- If DuckDuckGo proves too flaky in production, keep it as the zero-key fallback and let Ollama/SearXNG absorb the heavier traffic.
- Keep Ollama opt-in and disabled by default unless explicitly configured.
- Use search-specific `SEARCH_OLLAMA_*` env vars so the new backend stays separate from embedding config.

## Verification

Minimum gates before calling this complete:

- `npm run lint`
- `npm run typecheck`
- `npm run test` (or the narrow provider test subset if the full suite is too expensive)
- `git diff --check`
