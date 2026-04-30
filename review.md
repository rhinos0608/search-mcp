## Review: v3.3.1 Planning Docs & Roadmap Index

### 1. Naming collision: "Ollama" already means embeddings in this repo

- **Location**: `docs/plans/v3.3.1/SPEC.md` (Summary, Backend Classes table, Proposed Behavior §3), `docs/plans/v3.3.1/IMPLEMENTATION.md` (Phase 0, Phase 2)
- **Evidence**: `src/utils/ollamaEmbedding.ts` (line 2: "Ollama embedding client for local, API-key-free embeddings"), `src/rag/embedding.ts` (line 24: `export type EmbeddingProvider = 'sidecar' | 'ollama' | 'transformers' | 'openai'`), `src/config.ts` already processes `EMBEDDING_OLLAMA_BASE_URL` / `EMBEDDING_OLLAMA_MODEL` (absent from config surface but used by `ollamaEmbedding.ts`).
- **Issue**: The plan introduces **"Ollama web search"** as an opt-in account-gated *search backend*, but the codebase already uses **"ollama"** as a local, zero-key *embedding provider*. This conflates two entirely different Ollama usages under the same namespace.
- **Risk**: Users/operators will confuse config keys (e.g., `EMBEDDING_OLLAMA_BASE_URL` vs a hypothetical `OLLAMA_SEARCH_API_KEY`). The `SearchBackend` union in `src/config.ts` (`'brave' | 'searxng' | 'exa'`) would need to add `'ollama'`, which collides semantically with `EmbeddingProvider`. Env vars, documentation, and error messages will be ambiguous.
- **Fix**: Rename the proposed search backend to `'ollamaSearch'`, `'ollamaWebSearch'`, or `'openclawOllama'` in the `SearchBackend` type, config keys, and tool filenames. Add a cross-reference note in the plan explaining that local Ollama embeddings (existing, zero-key) are distinct from the proposed account-gated search backend.

### 2. Unverified assumption about "Ollama web search" as a real service

- **Location**: `docs/plans/v3.3.1/SPEC.md` (Research Sources, Backend Classes), `IMPLEMENTATION.md` (Phase 2)
- **Evidence**: The plan cites OpenClaw docs as evidence that "Ollama web search" requires a "free account/API key." However, `ollama.com` itself is a local LLM runner; it does not operate a hosted web-search API product. The OpenClaw reference likely describes an integration pattern (e.g., a tool that routes queries through a local model + a search engine), not a standalone search backend comparable to Brave/Exa.
- **Issue**: Treating an integration pattern as a first-class backend comparable to Brave, Exa, or SearXNG risks a fundamentally mis-scoped implementation. If the actual mechanics are "use Ollama to generate queries for SearXNG/Brave," it should be a query-expansion feature or a proxy tool, not a new `SearchBackend` tier.
- **Fix**: Before Phase 2 is committed, verify the actual API endpoint and auth model. If it requires no independent search endpoint and merely wraps another backend, reclassify it as a query pipeline or local proxy rather than a `SearchBackend`. Update the plan document with the precise endpoint contract.

### 3. Misleading characterization of the current default as "key-backed"

- **Location**: `docs/plans/v3.3.1/SPEC.md` (Problem section)
- **Evidence**: `src/config.ts` already defaults to `searxng` (`DEFAULTS.searchBackend: 'searxng'`). SearXNG is self-hosted and requires no API key (`SEARXNG_BASE_URL` alone).
- **Issue**: The plan states "the default search path is still centered on explicit configuration and key-backed providers." This understates SearXNG, which is already a zero-key option (albeit requiring self-hosting). DuckDuckGo is valuable because it removes the self-hosting requirement, not because it is the first zero-key path.
- **Fix**: Reword the Problem section to acknowledge SearXNG as the existing zero-key (self-hosted) default, and frame DuckDuckGo as the first zero-key backend *without self-hosting*.

### 4. Missing explicit tasks for TypeScript type union and config validation expansion

- **Location**: `docs/plans/v3.3.1/IMPLEMENTATION.md` (Phase 0 Tasks)
- **Evidence**: `src/types.ts` defines `SearchResult.source: 'brave' | 'searxng' | 'exa'`. `src/config.ts` defines `SearchBackend = 'brave' | 'searxng' | 'exa'` and `VALID_BACKENDS = new Set<string>(['brave', 'searxng', 'exa'])` used for env-var validation.
- **Issue**: Phase 0 says "Add `duckduckgo` and `ollama` to the backend type union" but omits the required expansion of `SearchResult.source` and `VALID_BACKENDS`. In TypeScript strict mode with `exactOptionalPropertyTypes`, these are hard blockers.
- **Fix**: Add explicit Phase 0 tasks to:
  1. Extend `SearchBackend` and `VALID_BACKENDS` in `src/config.ts`.
  2. Extend `SearchResult.source` in `src/types.ts`.
  3. Ensure `src/utils/searchMerge.ts` dedupe (`engines` array) accepts the new source labels.

### 5. Crawl4ai/browser separation — correct and consistent

- **Correct**: The plan explicitly states: "Keep crawl4ai/browser automation as the rendered-page layer, not the search backend strategy" and "No browser/CDP search backend rewrite" (SPEC.md, Non-Goals). This aligns with the current architecture where `crawl4ai` is used only by `webCrawl.ts` / `semanticCrawl.ts`, entirely separate from `webSearch.ts`.

### 6. Roadmap insertion coherence — mostly good, scope overlap with V3.2.0 should be noted

- **Location**: `docs/plans/index.md` (V3.3.1 section, Summary Table)
- **Evidence**: V3.2.0 (`docs/plans/v3.2.0/IMPLEMENTATION_PLAN.md` Phase 6) already scoped Ollama as a local embedding provider (`src/utils/ollamaEmbedding.ts` now exists in the repo). V3.3.1 lists "Opt-in Ollama backend" as a search deliverable.
- **Issue**: The Summary Table shows V3.2.0 as still "Planning in progress," yet its Ollama embedding work is already landed in `src/utils/ollamaEmbedding.ts`. V3.3.1 introduces another "Ollama backend" without clarifying it is a *search* backend, not the already-completed embedding backend. This risks double-counting and roadmap confusion.
- **Fix**: In the V3.3.1 row of the Summary Table, change the deliverable description to explicitly say "**search** backend" (e.g., "DuckDuckGo zero-key fallback, opt-in Ollama **web search** backend"). Add a note that Ollama embeddings were delivered under V3.2.0.

### 7. No evidence of env-var collision planning for Ollama config

- **Location**: `docs/plans/v3.3.1/IMPLEMENTATION.md` (Phase 0 Tasks)
- **Evidence**: Existing embedding Ollama uses `EMBEDDING_OLLAMA_BASE_URL` and `EMBEDDING_OLLAMA_MODEL`. The plan mentions "Ollama host/auth" config for the search backend but does not define env var names.
- **Issue**: If the new search backend uses `OLLAMA_BASE_URL` or similar, it will clash semantically with the embedding vars. If it reuses `EMBEDDING_OLLAMA_BASE_URL`, it couples two unrelated subsystems.
- **Fix**: Define explicit env var names in Phase 0 (suggestion: `SEARCH_OLLAMA_BASE_URL`, `SEARCH_OLLAMA_API_KEY`) and document why they are distinct from `EMBEDDING_OLLAMA_*`.
