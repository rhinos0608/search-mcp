# V3.0.5 Implementation Plan - Job Adapter MVP

**Depends on**: V3.0.0  
**Goal**: Add a structured job-search MVP on top of the shared RAG pipeline.

## Corrections From Spec Review

- Do not attempt LinkedIn in the MVP. Auth walls and throttling make it a V3.2 source-profile target.
- Use the shared RAG pipeline for embeddings and candidate retrieval.
- Keep extraction factual. Do not infer seniority, salary normalization, or hidden work mode unless the listing states it.
- Avoid `jobMVP.ts` alias unless an actual compatibility need appears.
- Implement only simple dedup in V3.0.5. Three-layer dedup is V3.2.

## Phase 0 - Fixtures and Baseline

Create fixture pages under `test/fixtures/jobs/`:

- `seek-basic.html`
- `seek-no-salary.html`
- `indeed-basic.html`
- `jora-aggregated.html`
- `generic-job.html`

Each fixture should include enough HTML/JSON-LD/text to test:

- title
- company
- location
- work mode
- salary raw text
- posted date raw text
- source job ID
- aggregator markers
- caveats such as contract, agency, closing soon

Run:

- `npm run typecheck`
- `npm test`

## Phase 1 - Job Types

Create `src/rag/types/job.ts`.

Types:

- `JobSource = 'seek' | 'indeed' | 'jora' | 'other'`
- `WorkMode = 'onsite' | 'hybrid' | 'remote' | 'unknown'`
- `VerificationStatus`
- `JobFieldConfidence`
- `JobListingMvp`
- `JobSearchConstraints`
- `JobSearchResult`

Rules:

- Optional fields must be exactly optional-type safe for `exactOptionalPropertyTypes`.
- Use `salaryRaw`, not normalized salary, in this stage.
- Keep `extractedText` as the embedding field.

Tests:

- Add compile-time assignment tests in `test/jobTypes.test.ts`.

## Phase 2 - Source Profiles

Create `src/rag/sources/jobSources.ts`.

Profiles:

- SEEK
- Indeed
- Jora
- generic fallback

Each profile includes:

- host patterns
- reliability
- dynamic risk
- duplicate risk
- structured data likelihood
- selectors or JSON-LD hints
- source-specific job ID extraction rules

Implementation notes:

- Keep selectors as hints. Extraction must fall back to JSON-LD and text patterns.
- Do not put crawl credentials or cookies in source profiles.

Tests:

- Hostname-to-source matching.
- Unknown host returns `other`.

## Phase 3 - Extraction Helpers

Create `src/rag/adapters/job.ts`.

Functions:

- `detectJobSource(url): JobSource`
- `extractJobListingsFromHtml(html, url): JobListingMvp[]`
- `extractJobListingFromText(text, url, source): JobListingMvp`
- `extractSalaryRaw(text): string | undefined`
- `extractWorkMode(text): WorkMode`
- `extractCaveats(text): string[]`
- `calculateJobConfidence(listing): JobFieldConfidence`
- `determineVerificationStatus(source, html, url): VerificationStatus`

Extraction order:

1. JSON-LD `JobPosting`.
2. Source-specific selectors.
3. Generic meta tags and visible text.
4. Search/crawl snippet fallback only when no full listing is available.

Important constraints:

- Store raw source text snippets for confidence only in tests/debug metadata, not in public result unless needed.
- Mark Jora copied listings as `aggregator_result` when source text indicates it.
- If title is missing, skip the listing instead of returning `unknown` as a title.

Tests:

- `test/jobAdapter.test.ts` for each fixture.
- Salary absence gives `confidence.salary === 0`.
- Work mode unknown remains `unknown`.
- Caveats are extracted only from present text.

## Phase 4 - Job Adapter Integration

Register the job adapter in `src/rag/adapters/index.ts`.

Adapter behavior:

- Input: crawled `RawDocument` pages.
- Output chunks/items: one chunk per job listing.
- Embedding text: title, company, location, work mode, salary, and body.
- Metadata: source, source URL, job ID, field confidence, verification status.

Projection:

- Add a projection function that maps retrieval results back to `JobSearchResult`.
- Keep the raw RAG scores in `metadata.scores` or a dedicated `retrieval` field.

Tests:

- Adapter chunks multiple listings from one page when fixtures include them.
- Chunk IDs are stable across runs for the same URL/job ID.

## Phase 5 - MVP Constraints and Ranking

Create `src/rag/jobRanking.ts`.

Hard filters:

- `location` only when explicitly supplied.
- `workMode` only when explicitly supplied.
- `maxSalary` only when salary can be safely parsed; otherwise do not filter out unknown salary by default.
- `excludeTitles` keyword filter.

Weighted score:

- semantic: 0.45
- location: 0.20
- work mode: 0.15
- recency: 0.10
- completeness: 0.10

Corrections:

- Use retrieval semantic score from the pipeline. Do not re-embed listings.
- `minExperience` should be accepted only if there is a simple explicit years-of-experience pattern. Unknown experience should not be filtered out in MVP unless the user requests strict filtering later.
- Keep salary parsing conservative. If parsing fails, expose `salaryRaw` and a caveat.

Tests:

- Location-constrained query ranks matching location above non-matching location.
- Work-mode hard filter removes mismatches.
- Unknown salary does not fail `maxSalary` hard filter unless strict salary filtering is later added.

## Phase 6 - `semantic_jobs` Tool

Create `src/tools/semanticJobs.ts` and register `semantic_jobs` in `src/server.ts`.

Input schema:

- `query: string`
- `location?: string[]`
- `workMode?: ('remote' | 'hybrid' | 'onsite')[]`
- `maxSalary?: number`
- `minExperience?: number`
- `excludeTitles?: string[]`
- `sources?: ('seek' | 'indeed' | 'jora')[]`
- `maxPages?: number` default 20, max 50
- `topK?: number` default 10, max 50
- `debug?: boolean`

Pipeline:

1. Build source-specific search queries from `query`, `location`, and selected sources.
2. Use existing `web_search()` for seed discovery.
3. Use existing `webCrawl()` for full listing pages.
4. Convert crawl pages to raw documents.
5. Run job adapter through `prepareCorpus()` and `retrieveCorpus()`.
6. Apply MVP constraints/ranking.
7. Return structured job results with `corpusStatus` and optional trace.

Safety:

- Reuse `assertSafeUrl` / existing crawl safety.
- Keep all logs on stderr through `logger`.
- Do not include API keys or config in errors.

Tests:

- Stub web search/crawl functions.
- Verify partial crawl failure still returns fetched listings.
- Verify `ToolResult` wrapper shape.

## Phase 7 - Simple Dedup

Implement local MVP dedup before final ranking:

- exact source URL
- source + job ID
- normalized title + company + location

Do not use semantic dedup here.

Tests:

- Jora duplicate of SEEK fixture collapses to the more reliable source when both identify the same job.
- Different jobs at same company are not collapsed if title differs materially.

## Phase 8 - Docs and Verification

Update:

- `docs/tools.md` for `semantic_jobs`.
- `docs/architecture.md` with structured adapter note if V3.0.0 docs do not already cover it.

Final commands:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test -- test/jobAdapter.test.ts test/jobRanking.test.ts`
- `npm test`

Exit criteria:

- SEEK, Indeed, and Jora fixtures extract the MVP fields.
- `semantic_jobs` returns structured objects, not plain chunks.
- Confidence, verification status, and caveats are grounded in page text.
