# V3.1.0 Implementation Plan — Code / GitHub

**Depends on**: V3.0.0  
**Goal**: Add code-aware semantic retrieval for GitHub repositories without disturbing the existing GitHub discovery tools.

## Codebase Review Findings

This plan is adjusted to match the current repository state:

- `src/rag/` already exists and already owns the shared prepare/retrieve pipeline.
- `src/utils/corpusCache.ts` is already SQLite-backed and ships the persistence work originally listed as V3.1 Phase 1.
- `src/utils/githubCorpus.ts` already acts as the GitHub file collector and already enforces the most important hard caps (`maxFiles`, extension filtering, size caps, excluded directories).
- `src/rag/adapters/` already contains text, transcript, conversation, and job adapters, so the V3.1 work should extend the existing adapter surface rather than inventing a second pipeline.
- `src/chunking.ts` already keeps fenced code blocks atomic. The remaining work is to preserve code context metadata and make code chunks first-class retrieval units.
- There is no `src/rag/adapters/code.ts` yet, and the repo does not currently include tree-sitter dependencies. Because the user explicitly wants tree-sitter in V3.1.0, this plan adds it now, but keeps the collector separate from the parser.
- The current retrieval-profile names (`balanced`, `fast`, `precision`, `recall`) do not yet expose the roadmap’s `lexical-heavy` code behavior, so V3.1 must extend the profile layer for code rather than reusing prose defaults unchanged.
- `EMBEDDING_CODE_MODEL` is not yet modeled in config; V3.1 should add the fallback surface so the README warning is tied to an actual runtime condition.

## Planning Rules

- **TDD first**: every batch starts with failing tests and ends with green tests.
- **Batch reviews**: review after each phase, not at the end of the release.
- **Small blast radius**: keep GitHub collection, AST parsing, profile tuning, and tool registration separate.
- **No silent broad-crawl behavior**: under-constrained GitHub indexing should warn loudly.
- **Lazy loading**: tree-sitter grammars must load on first use, not at startup.

---

## Batch 0 — Fixtures + Failing Tests

### Goal

Create the smallest code fixtures and acceptance tests that define the release before implementation starts.

### Files

- `test/fixtures/code/sample.ts`
- `test/fixtures/code/sample.js`
- `test/fixtures/code/sample.py`
- `test/fixtures/code/sample.go`
- `test/fixtures/code/sample.rs`
- `test/fixtures/code/sample.md`
- `test/codeLanguage.test.ts`
- `test/codeSymbols.test.ts`
- `test/codeChunking.test.ts`
- `test/codeProfiles.test.ts`
- `test/semanticGitHubCode.test.ts`
- `test/githubCorpusGuardrails.test.ts`

### Test coverage to write first

- extension-based language detection
- shebang fallback for scripts
- symbol extraction returns function/class boundaries
- nested or multi-line constructs do not create overlapping line ranges
- markdown code fences remain atomic and carry context metadata
- broad GitHub corpora emit warnings and stay inside caps
- tool registration fails until the new tool exists
- code profile settings expose a `lexical-heavy` mode that beats `balanced` on identifier-heavy queries
- config exposes the code-embedding fallback warning path when `EMBEDDING_CODE_MODEL` is missing

### Review checkpoint

- Confirm the fixture set exercises TypeScript, JavaScript, Python, Go, Rust, and markdown code examples.
- Confirm the tests express the expected public behavior, not implementation details.

---

## Batch 1 — Tree-sitter Foundation

### Goal

Add the parser layer and language resolution before the adapter uses it.

### Files to create

- `src/rag/code/languages.ts`
- `src/rag/code/treeSitter.ts`
- `src/rag/code/symbols.ts` (parser-facing helpers only)
- `src/config.ts` (code-embedding config surface)
- `src/rag/profiles.ts` (code-specific retrieval profile mapping)

### Implementation notes

- Map extensions to supported languages: TypeScript, JavaScript, Python, Go, Rust, markdown, JSON, YAML, shell.
- Add shebang detection for `python`, `bash`, and `node`-style scripts.
- Load WASM grammars lazily and cache parser instances per language.
- Keep unrecognized extensions on a safe `unknown` path that falls back to text chunking.
- Add `EMBEDDING_CODE_MODEL` config support and make the code path warn when it is absent.
- Add code-specific profile aliases so `lexical-heavy` can be the default for code without breaking existing generic profiles.

### Tests

- extension wins over content heuristics
- shebang works without file extension
- unknown extension returns `unknown`
- first parse of each language triggers a lazy load path, but startup does not import all grammars eagerly
- code profile settings expose a `lexical-heavy` mode that beats `balanced` on identifier-heavy queries
- config exposes the code-embedding fallback warning path when `EMBEDDING_CODE_MODEL` is missing

### Review checkpoint

- Confirm the parser bootstrap does not increase startup cost for non-code users.
- Confirm the language detector is deterministic and testable.

---

## Batch 2 — Symbol Extraction + Code Chunking

### Goal

Turn parsed source files into retrieval chunks with stable symbol metadata.

### Files to create/modify

- `src/rag/types.ts` or a narrow code type module if the type surface grows too large
- `src/rag/adapters/code.ts`
- `src/rag/code/chunking.ts` or equivalent helper module
- `src/rag/profiles.ts` (code-specific retrieval profile calibration)

### Behavior

- Chunk by AST symbol boundaries first.
- Preserve displayed chunk text as source code only.
- Attach metadata for:
  - `path`
  - `language`
  - `startLine`
  - `endLine`
  - `symbolName`
  - `symbolKind`
  - `signature`
  - `imports`
  - `docstring`
- Split very large symbols by monotonic line windows.
- Fall back to text-style chunking when a file cannot be parsed safely.
- Propagate code-fence context metadata from `src/chunking.ts` for markdown examples.
- Default the code adapter to `lexical-heavy`, with `balanced` still available for parity and tests.

### Tests

- functions/classes are extracted at the expected boundaries
- long symbols split without reordering or overlap
- imports and docstrings are preserved in metadata
- markdown code blocks stay atomic and include surrounding context metadata
- code profile settings prove `lexical-heavy` beats `balanced` on identifier-heavy searches

### Review checkpoint

- Confirm code retrieval prefers identifier-rich chunks over arbitrary line windows.
- Confirm the adapter still degrades gracefully on partial parse failures.

---

## Batch 3 — GitHub Corpus Guardrails

### Goal

Keep `githubCorpus.ts` as the collector, but tighten selection so broad repositories do not drift into examples or generated files.

### Files to modify

- `src/utils/githubCorpus.ts`
- `src/tools/semanticCrawl.ts`
- `src/types.ts` if any GitHub corpus output metadata needs to be surfaced

### Changes

- Preserve the current collector/adapter split.
- Add `.gitignore` parsing to exclude ignored files and directories when possible.
- Keep generated/vendor/build exclusions explicit.
- Keep hard byte/file caps as hard stops.
- Surface warnings when a crawl is under-constrained or broad enough to risk example-file bias.
- Keep query and extension filters, and add tool-level file filtering if needed rather than forcing the collector to own every concern.

### Tests

- ignore rules exclude generated/vendor content
- broad repository crawls emit warnings
- query-scoped crawls prefer source files over examples
- cap enforcement remains deterministic under large fixtures

### Review checkpoint

- Confirm no current GitHub tool behavior regresses.
- Confirm the new warnings are visible enough for the caller to react.

---

## Batch 4 — `semantic_github_code` Tool

### Goal

Add the user-facing code search tool that connects the new adapter to the shared RAG pipeline.

### Files to create/modify

- `src/tools/semanticGitHubCode.ts`
- `src/server.ts`
- `src/rag/adapters/index.ts`
- `src/rag/adapters/code.ts`
- `src/rag/profiles.ts`

### Tool input

- `query: string`
- `repo: string` in `owner/repo` form
- `ref?: string`
- `language?: string`
- `maxFiles?: number`
- `fileFilter?: string[]`
- `topK?: number`
- `profile?: RetrievalProfileName`
- `includeContext?: boolean`
- `debug?: boolean`

### Pipeline

1. parse `repo`
2. collect files through `fetchGitHubCorpus()`
3. apply tool-level filters
4. parse and chunk with the code adapter
5. prepare/retrieve through `src/rag/pipeline.ts`
6. optionally include call-site context
7. return structured code results plus corpus warnings

### Tests

- invalid repo strings fail validation
- language filter excludes nonmatching files
- include-context toggles call-site data
- empty corpora return a controlled response with warnings
- `semantic_github_code` registers in the server
- code queries default to `lexical-heavy` and prove that profile beats `balanced` on identifier-heavy searches

### Review checkpoint

- Confirm the tool returns path, language, line range, symbol metadata, and RAG scores.
- Confirm existing GitHub tools remain unchanged.

---

## Batch 5 — Docs + Release Verification

### Goal

Finish the release with docs, README notes, and full verification.

### Files to update

- `docs/tools.md`
- `docs/architecture.md`
- `README.md` or the relevant user-facing docs section for the code-embedding degradation path
- `ROADMAP.md` if the release status needs a refresh
- `src/rag/profiles.ts` notes in the architecture docs so code/profile behavior is discoverable

### Verification commands

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test -- test/code*.test.ts test/githubCorpus*.test.ts test/semanticGitHubCode.test.ts`
- `npm test`

### Final release gates

- TypeScript, JavaScript, Python, Go, and Rust fixtures chunk at useful symbol boundaries.
- tree-sitter grammars load lazily.
- broad GitHub crawls warn instead of silently choosing shallow examples.
- `semantic_github_code` returns stable structured results with symbol context.
- `lexical-heavy` beats `balanced` on identifier-heavy code queries.
- The code-embedding fallback path is documented in the README and reflected in runtime warnings when `EMBEDDING_CODE_MODEL` is absent.
- existing GitHub discovery tools continue to work unchanged.

---

## Release Notes for Review

- Phase 1 infrastructure work is already complete and should remain untouched.
- The code adapter is the only major new semantic source in V3.1.0.
- The GitHub collector is not being replaced; it is being made safer and more code-aware.
- Batch review will happen after each phase so we can catch parser, profile, or corpus regressions before they spread.
