# V3.2.0 Implementation Plan - Full Domain Adapters + Eval

**Depends on**: V3.0.0, V3.0.5, V3.1.0  
**Goal**: Complete V3 domain coverage, strengthen ranking quality, and add measurable retrieval evaluation.

## Corrections From Spec Review

- Make semantic dedup async. URL and fingerprint dedup can stay synchronous.
- QA adapter requires fetching Stack Overflow answers; the current search tool returns questions only.
- Full eval should use offline fixtures in CI and optional live evals outside CI.
- Metrics should stay process-local unless a metrics backend is explicitly added.
- Upgrade the existing job adapter rather than creating a disconnected parallel path.

## Phase 0 - V3 Contract Audit

Before adding new adapters, audit the stable V3.0.0 contracts:

- `Adapter`
- `RagChunk`
- `PreparedCorpus`
- `RetrievalResponse<T>`
- `RetrievalTrace`
- `ProfileSettings`
- cache versioning
- tool response wrappers

Add a short compatibility note to `docs/architecture.md` if contracts have drifted.

Run:

- `npm run typecheck`
- `npm test`

## Phase 1 - Dedupe Module

Create or complete `src/rag/dedup.ts`.

Types:

- `DedupeConfig`
- `DedupeLayer`
- `DedupeDecision`
- `DedupeGroup<T>`
- `DedupeResult<T>`

Functions:

- `dedupeByUrl<T>()`
- `dedupeByFingerprint<T>()`
- `dedupeBySemantic<T>()`
- `deduplicateCorpus<T>()`

Rules:

- URL dedup normalizes protocol, host case, trailing slash, and tracking params.
- Fingerprint dedup uses normalized text shingles or simhash/minhash. Do not rely on exact hashes.
- Semantic dedup embeds candidate groups only after URL/fingerprint reduction.
- Keep the most complete item by default; let adapters provide a `prefer(a, b)` function.

Tests:

- Same URL with tracking params collapses.
- Near-identical text collapses above threshold.
- Similar but distinct jobs/questions do not collapse.
- Semantic dedup uses fake embeddings in unit tests.

## Phase 2 - Constraint Module

Implement `src/rag/constraints.ts`.

Types:

- `HardConstraint`
- `SoftConstraint`
- `ConstraintConfig`
- `ConstraintEvaluation`
- `ConstraintRankedResult<T>`

Required hard constraints:

- location
- salary
- experience
- work mode
- language
- availability

Required soft constraints:

- company size
- tech stack
- remote-first
- source reliability
- recency

Rules:

- Unknown facts should not fail hard constraints unless the constraint is marked `strict`.
- Constraint evaluation must explain matched and failed constraints.
- Constraint score is a separate score component, not a mutation of raw semantic score.

Tests:

- Hard filters remove explicit mismatches.
- Unknown fields behave correctly in strict and non-strict modes.
- Soft boosts change ordering without hiding original retrieval rank.

## Phase 3 - Observability

Create:

- `src/rag/instrumentation.ts`
- `src/rag/metrics.ts`

Instrumentation:

- Use lightweight timing helpers around pipeline stages.
- Keep metrics in memory.
- Log summaries through `logger` to stderr only.
- Include adapter, profile, cache hit, chunk count, and result count labels.

Metrics:

- count
- error count
- p50/p95/p99 latency from recent samples
- cache hit rate
- dedup removal rate
- rerank improvement summary

Tests:

- Timing helper records success and failure.
- Metrics snapshot is deterministic with fake samples.

## Phase 4 - Academic Adapter

Create `src/rag/adapters/academic.ts`.

Input sources:

- existing `academic_search`
- existing `arxiv_search`
- optional PDF fetch only if a safe parser path exists; otherwise use abstract/metadata in V3.2.0 and leave full PDF extraction for later.

Chunking:

- abstract as its own chunk
- section-aware markdown/text chunks when full text is available
- title/authors/venue/year in metadata
- citations/equations/figures as detected metadata, not required fields when unavailable

Tool decision:

- If adding a new tool, use `semantic_academic`.
- If not adding a tool, expose adapter support only through an existing generic semantic source path.

Recommended tool input:

- `query`
- `source?: 'academic_search' | 'arxiv' | 'all'`
- `yearMin?`
- `yearMax?`
- `categories?`
- `topK?`
- `profile?`
- `debug?`

Tests:

- ArXiv fixture chunks abstract and metadata.
- Section detector handles common headings.
- Missing full text does not fail the adapter.

## Phase 5 - Stack Overflow QA Fetch Path

Before the QA adapter, add an answer fetch helper.

Create `src/tools/stackoverflowAnswers.ts` or an internal helper if it should not be registered.

Behavior:

- Fetch question by ID with body.
- Fetch answers with body, accepted flag, score, author, creation date.
- Preserve code blocks through structured extraction.
- Respect Stack Exchange API key config.
- Reuse existing rate-limit and safe-response patterns.

Tests:

- Parse answer fixture.
- Accepted answer is identified.
- Code blocks are preserved.

## Phase 6 - QA Adapter

Create `src/rag/adapters/qa.ts`.

Chunking:

- One chunk for the question.
- One chunk per answer with question title/body context bounded.
- Accepted answer gets metadata and optional ranking boost through constraints/profile.
- Tags and language live in metadata.

Tool:

- Add `semantic_stackoverflow` if user-facing semantic QA search is desired in V3.2.

Recommended input:

- `query`
- `tagged?`
- `accepted?`
- `maxQuestions?`
- `includeAnswers?: boolean`
- `topK?`
- `profile?`
- `debug?`

Tests:

- Question-answer link is preserved.
- Accepted answer is marked.
- Code blocks remain searchable.

## Phase 7 - Full Job Adapter Upgrade

Upgrade the V3.0.5 job adapter.

Add:

- full source profiles for SEEK, Indeed, Jora, LinkedIn, Glassdoor
- reliability scores
- auth-wall detection
- richer dedup preference rules
- optional salary parsing into min/max/currency/period
- experience extraction
- richer caveat extraction

Rules:

- LinkedIn should be best-effort and clearly flagged when blocked or snippet-only.
- Do not require auth cookies.
- Glassdoor/LinkedIn source support must degrade gracefully.

Tests:

- Existing MVP fixtures still pass.
- New LinkedIn/Glassdoor blocked-page fixtures produce warnings, not fake listings.
- Cross-source duplicate fixtures collapse to the preferred result.

## Phase 8 - Pipeline Integration

Modify `src/rag/pipeline.ts`.

Add options:

- `dedupe?: DedupeConfig`
- `constraints?: ConstraintConfig`
- `metrics?: boolean`

Order:

1. collect documents
2. URL/fingerprint dedup raw documents
3. chunk
4. embed/index
5. retrieve
6. semantic dedup on retrieved structured entities where enabled
7. apply constraints
8. rerank/profile finalization
9. record metrics and trace

Tests:

- Dedup happens before embedding when possible.
- Constraint filtering happens after retrieval but before final top-K.
- Trace includes dedup and constraint counts.

## Phase 9 - Eval Harness

Create `src/rag/__tests__/eval/`.

Files:

- `runEval.ts`
- `metrics.ts`
- `thresholds.json`
- `golden-queries/youtube.json`
- `golden-queries/reddit.json`
- `golden-queries/github-code.json`
- `golden-queries/jobs.json`
- `golden-queries/academic.json`
- `golden-queries/qa.json`

CI approach:

- Offline fixture eval runs in CI.
- Live eval requires explicit env flag, for example `SEARCH_MCP_LIVE_EVAL=1`.
- Do not make CI depend on YouTube, Reddit, GitHub, Stack Exchange, Crawl4AI, or embedding sidecar network calls.

Metrics:

- recall@1
- recall@3
- recall@10
- MRR
- p50/p95/p99 latency
- average chunk tokens
- deduplication rate
- partial-failure recall

Package scripts:

- `eval`
- `eval:offline`
- optional `eval:live`

Tests:

- Eval runner reads fixtures and computes metrics.
- Threshold failure exits non-zero.
- Per-adapter eval can be selected.

## Phase 10 - Documentation and Verification

Update:

- `docs/tools.md`
- `docs/architecture.md`
- `docs/composition-with-rag-anything.md` if examples need V3 terms
- `docs/plans/index.md` status fields when stages are complete

Final commands:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run eval:offline`

Exit criteria:

- Academic and QA adapters work against offline fixtures.
- Job adapter full upgrade preserves MVP behavior.
- Dedup and constraints are covered by deterministic tests.
- Offline eval reports recall/MRR/latency and enforces thresholds.
