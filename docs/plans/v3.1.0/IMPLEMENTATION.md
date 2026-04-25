# V3.1.0 Implementation Plan - Code / GitHub

**Depends on**: V3.0.0  
**Goal**: Add code-aware semantic retrieval for GitHub repositories.

## Corrections From Spec Review

- `src/utils/githubCorpus.ts` currently accepts an options object and returns `GitHubCorpusDocument[]`. Use it as the source collector; do not assume the older signature.
- Do not move `githubCorpus.ts` into the adapter in one jump. Keep collection and code chunking separate.
- Regex-only JavaScript parsing is brittle. Start with conservative symbol-boundary heuristics and line ranges.
- Existing GitHub tools remain first-class and unchanged.

## Stress-Test Findings That Shape This Plan

The week-one semantic tool tests surfaced a few constraints that the code adapter needs to respect from day one:

- Broad GitHub crawls drift into `examples/` and other surface files unless a query/file/language pre-filter is provided.
- `maxFiles` and byte caps need to be hard stops, not soft guidance.
- Generated/vendor directories must stay excluded by default.
- Result quality should degrade visibly via warnings when the crawl was under-constrained, rather than silently returning the wrong file.
- Query-specific GitHub retrieval is excellent when steered properly; the plan should optimize for that path, not broad monorepo exploration.

## Phase 0 - Fixtures and Baseline

Create fixture files under `test/fixtures/code/`:

- `sample.ts`
- `sample.js`
- `sample.py`
- `sample.go`
- `sample.rs`
- `sample.md`

Each fixture should include:

- imports
- one class or type
- two functions
- one nested or multiline function-like construct
- comments/docstrings
- one call site to another function

Run:

- `npm run typecheck`
- `npm test`

## Phase 1 - Code Types

Create `src/rag/types/code.ts`.

Types:

- `CodeLanguage`
- `CodeSymbol`
- `CodeChunk`
- `CallSite`
- `CallGraph`
- `SemanticGitHubCodeOptions`
- `CodeSearchResult`

Required fields on `CodeChunk`:

- base `RagChunk` fields
- `path`
- `language`
- `startLine`
- `endLine`
- `symbolName?`
- `symbolKind?`
- `signature?`
- `imports`
- `docstring?`

Do not include a required `complexity` field in V3.1.0. Add it later only if measured.

Tests:

- Compile-time assignment tests for optional fields.

## Phase 2 - Language Detection

Create `src/rag/code/languages.ts`.

Implement:

- extension mapping for TypeScript, JavaScript, Python, Go, Rust, Java, Markdown, JSON, YAML, shell.
- shebang fallback for shell, Python, Node.
- content fallback only for obvious cases.

Tests:

- Extension wins.
- Shebang works without extension.
- Unknown extension returns `unknown`.

## Phase 3 - Symbol Extraction

Create `src/rag/code/symbols.ts`.

Implement conservative extractors:

- TypeScript/JavaScript:
  - `function name(...)`
  - `export function name(...)`
  - `const name = (...) =>`
  - `class Name`
  - method headers inside classes as best effort
- Python:
  - `def name(...)`
  - `async def name(...)`
  - `class Name`
- Go:
  - `func name(...)`
  - `func (r Receiver) name(...)`
- Rust:
  - `fn name(...)`
  - `impl Type`

Line-range strategy:

- Identify symbol header line.
- End at the next symbol header of equal or lower apparent scope, or file end.
- Keep fallback chunks for content outside symbols.

Tests:

- Symbol names and line ranges match fixtures.
- Nested functions do not produce negative or overlapping line ranges.
- Unknown language returns no symbols and falls back to token/line chunking.

## Phase 4 - Code Chunking

Create `src/rag/adapters/code.ts`.

Behavior:

- Chunk by symbols first.
- Merge adjacent tiny chunks from the same file when below minimum token threshold.
- Split very large symbols by line windows, preserving the symbol header in metadata.
- Prefix embedding text with path, language, symbol signature, imports, and docstring.
- Keep displayed chunk text as source code only, with metadata carrying context.

Limits:

- Default `maxFiles` 50.
- Default max file bytes should follow existing `githubCorpus.ts` behavior.
- Default chunk target should align with V3.0.0 profile settings.

Tests:

- Function/class boundaries are respected.
- Long symbol split keeps line ranges monotonic.
- Markdown files fall back to text adapter or a simple markdown code/document chunk path.

## Phase 5 - Call Site Heuristics

Create `src/rag/code/callGraph.ts`.

Implement:

- Build a symbol index by file and symbol name.
- Find textual call sites with language-aware patterns.
- Ignore definitions as call sites.
- Return bounded call-site lists in result metadata.

Scope:

- This is a helper for result context, not a complete call graph.
- No graph database or persistence in V3.1.0.

Tests:

- Fixture call from one function to another is found.
- Definition line is not counted as a call site.
- Results are bounded.

## Phase 6 - GitHub Corpus Collection

Adapt or wrap `src/utils/githubCorpus.ts` for V3.1.0.

Changes:

- Keep the existing public function unless V3.0.0 already moved it.
- Add optional branch/default branch resolution only if needed by the tool.
- Add better extension defaults for code search.
- Preserve excluded directory behavior and hard-cap traversal by file count and byte budget.
- Add explicit pre-filter support (`query`, `language`, `fileFilter`) and warnings when the crawl is too broad to target the right code.
- Keep sequential fetching initially if rate-limit safety matters; introduce bounded concurrency only with tests.

Tests:

- Existing `test/githubCorpus.test.ts`.
- File include/exclude behavior for new extensions.
- Broad repo crawl without a meaningful pre-filter emits warnings and stays within caps.
- Query/file-filtered crawl lands in the intended code path rather than `examples/` or generated output.

## Phase 7 - `semantic_github_code` Tool

Create `src/tools/semanticGitHubCode.ts` and register `semantic_github_code`.

Input schema:

- `query: string`
- `repo: string` in `owner/repo` form
- `ref?: string`
- `language?: string`
- `maxFiles?: number` default 50, max 200
- `fileFilter?: string[]`
- `topK?: number` default 10, max 50
- `profile?: RetrievalProfileName`
- `includeContext?: boolean` default true
- `debug?: boolean`

Pipeline:

1. Parse `repo`.
2. Collect files through `fetchGitHubCorpus()`.
3. Filter by language and file filters.
4. Run code adapter through `prepareCorpus()` and `retrieveCorpus()`.
5. Add call-site context when `includeContext` is true.
6. Return `RetrievalResponse<CodeSearchResult>`.

Error handling:

- Invalid `repo` format returns a validation error.
- Empty corpus returns a controlled empty response with warnings.
- GitHub rate-limit errors keep existing sanitized tool error behavior.

Tests:

- Stub GitHub corpus documents.
- Query returns symbol metadata and line ranges.
- Language filter excludes nonmatching files.
- Include-context flag controls call-site output.
- Under-constrained repo queries surface warnings instead of silently selecting shallow example files.

## Phase 8 - Docs and Verification

Update:

- `docs/tools.md` with `semantic_github_code`.
- `docs/architecture.md` with code adapter notes.

Final commands:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test -- test/code*.test.ts test/githubCorpus.test.ts`
- `npm test`

Exit criteria:

- TypeScript, JavaScript, Python, Go, and Rust fixtures chunk at useful symbol boundaries.
- `semantic_github_code` returns path, language, line range, symbol metadata, and RAG scores.
- Existing GitHub tools are unchanged.
