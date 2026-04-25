# Implementation Plan: V3.1.0 (Intelligence, Extraction, and Code)

## Goal

Turn GitHub-backed semantic retrieval into a production-grade code search path. This release keeps the existing GitHub discovery tools intact while adding a dedicated code adapter and a new semantic code-search tool.

## What the code review changed

- `src/utils/corpusCache.ts` is already SQLite-backed, so the persistence work is done.
- `src/utils/githubCorpus.ts` already handles the file collector role and already enforces the most important hard caps.
- `src/chunking.ts` already keeps fenced code blocks atomic.
- The missing pieces are the code adapter, tree-sitter parsing, profile calibration, GitHub guardrail tightening, and the new tool wiring.

## Phase 1: Robust Infrastructure [✅ COMPLETED]

### 1. Persistent Corpus Cache (SQLite)

- [x] Prevent corpus loss on server restart and support larger datasets.
- [x] Replace memory-backed corpus cache storage with SQLite tables.
- [x] Implement byte-weighted LRU eviction.

### 2. Neural Search Integration (Exa)

- [x] Add `EXA_API_KEY` to `src/config.ts`.
- [x] Integrate Exa into the `web_search` fallback chain.

## Phase 2: Tree-sitter Foundation [✅ COMPLETED]

### 3. Language detection and parser loading

- [x] Create a code-language detector for TypeScript, JavaScript, Python, Go, Rust, markdown, JSON, YAML, and shell.
- [x] Add shebang fallback for scripts.
- [x] Lazy-load WASM tree-sitter grammars so startup stays fast.
- [x] Keep unknown languages on a safe text fallback.
- [x] Add the code-embedding fallback surface and code-profile aliases needed by the V3.1 roadmap gates.

## Phase 3: Code Intelligence [✅ COMPLETED]

### 4. AST-aware code chunking

- [x] Create `src/rag/adapters/code.ts`.
- [x] Chunk by symbol boundaries first, then split oversized symbols by line windows.
- [x] Preserve symbol metadata: path, language, line range, symbol name, signature, imports, docstring.
- [x] Keep displayed chunk text as source only; place context in metadata.

### 5. Repo guardrails and code-example metadata

- [x] Keep `src/utils/githubCorpus.ts` as the collector.
- [x] Add `.gitignore` parsing and explicit warnings for broad or under-constrained crawls.
- [x] Keep byte/file caps as hard stops.
- [x] Preserve fenced code blocks as atomic units with surrounding context metadata in `src/chunking.ts`.
- [x] Make `lexical-heavy` the code-default retrieval profile, with tests proving it beats `balanced` on identifier-heavy queries.

## Phase 4: `semantic_github_code` [✅ COMPLETED]

### 6. Tool implementation

- [x] Create `src/tools/semanticGitHubCode.ts`.
- [x] Register `semantic_github_code` in `src/server.ts`.
- [x] Route repository documents through the shared `prepareCorpus()` / `retrieveCorpus()` pipeline.
- [x] Return structured code results with symbol context and retrieval scores.

## Quality Gates for V3.1 Release [✅ ALL PASSED]

- [x] `semantic_github_code` returns path, language, line range, symbol metadata, and RAG scores.
- [x] Tree-sitter grammars load lazily on first use.
- [x] Unknown file types fall back cleanly to text-style handling.
- [x] GitHub indexing warns on broad crawls and respects caps.
- [x] `lexical-heavy` beats `balanced` on identifier-heavy code queries.
- [x] The code-embedding degradation path is documented in the README and surfaced in runtime warnings when `EMBEDDING_CODE_MODEL` is absent.
- [x] Existing GitHub discovery tools remain unchanged.

## Execution rules

- TDD for every phase.
- Batch reviews after each phase.
- Keep parser, collector, profile tuning, and tool wiring separate so regressions are easier to isolate.
