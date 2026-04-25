# Implementation Plan: V3.1.0 (Intelligence, Extraction, and Code)

## Goal

Transform the extraction, caching, and code-parsing layers to be robust enough for production agent workflows. This merges the original Code/AST goals with new research findings (Kill Chain extraction, Contextual Embeddings, Persistence, and Neural Search).

## Phase 1: Robust Infrastructure

### 1. Persistent Corpus Cache (SQLite)

- **Objective**: Prevent corpus loss on server restart and support larger datasets.
- **Action**:
  - Install `better-sqlite3`.
  - Replace `src/utils/corpusCache.ts` memory structures with SQLite tables (`corpora`, `chunks`, `embeddings`, `bm25_stats`).
  - Implement a byte-weighted LRU eviction policy.

### 2. Neural Search Integration (Exa)

- **Objective**: Provide a higher-quality semantic web search alternative.
- **Action**:
  - Add `EXA_API_KEY` to `src/config.ts`.
  - Implement `src/tools/exaSearch.ts` and integrate it into the `web_search` tool fallback chain.

## Phase 2: Advanced Extraction

### 3. Kill Chain Content Extraction

- **Objective**: Maximize content extraction success across 404s, paywalls, and JS-heavy SPAs.
- **Action**:
  - Implement a 4-stage extraction fallback in `semanticCrawl.ts`:
    1. **Crawl4AI** (Primary)
    2. **Readability.js** (via jsdom)
    3. **Wayback Machine API** (for dead links)
    4. **Google Cache API** (for paywalls/anti-bot)

### 4. Contextual Embeddings (Optional)

- **Objective**: Improve retrieval precision by situating chunks within the full document context before embedding.
- **Action**:
  - Add an LLM pre-processing step (via existing `llm` config) to generate brief context strings for each chunk.
  - Prepend context to the chunk text before passing to the embedding sidecar.

## Phase 3: Code Intelligence

### 5. AST-Aware Code Chunking (Tree-sitter)

- **Objective**: Semantic chunking for GitHub repositories (functions, classes, methods).
- **Action**:
  - Create `src/rag/adapters/code.ts` using WASM-based tree-sitter grammars (TS, JS, Python, Go, Rust).
  - Ensure WASM grammars are lazy-loaded to preserve fast startup times.
  - Default to `lexical-heavy` profile for code to prioritize identifier matches.

### 6. Repo Guardrails & Code Example Extraction

- **Objective**: Prevent monorepo indexing blowouts and improve generic markdown code parsing.
- **Action**:
  - Implement byte/file caps and `.gitignore` parsing in `src/utils/githubCorpus.ts`.
  - Update `src/chunking.ts` to treat ` ``` ` blocks as distinct atomic units with `contextBefore` and `contextAfter` metadata.

---

## Quality Gates for V3.1 Release

- [ ] `cached` source survives a server restart (SQLite works).
- [ ] Kill chain successfully recovers a known 404 page via Wayback Machine.
- [ ] Contextual embeddings improve top-3 recall by >15% on golden evaluation queries.
- [ ] Tree-sitter `adapters/code.ts` successfully extracts classes/functions from a TS file.
- [ ] Monorepo indexing halts at configured byte/file caps without crashing.
