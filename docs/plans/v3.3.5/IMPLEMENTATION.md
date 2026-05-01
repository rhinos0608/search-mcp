# V3.3.5 Implementation Plan: JobSpy & Graph Integration

## Phase 1: Infrastructure & Bridge (JobSpy)

### 1.1 JobSpy FastAPI Sidecar
- Create `sidecar/jobspy/` directory.
- Implement `main.py` using FastAPI.
- Endpoint `POST /search` that wraps `jobspy.scrape_jobs()`.
- Support JSON responses with the full `JobPost` schema.
- Dockerize the sidecar for consistent deployment.

### 1.2 TypeScript Client
- Create `src/utils/jobspyClient.ts`.
- Implement `JobSpyRequest` and `JobSpyResponse` interfaces.
- Add `searchJobSpy()` function with retry logic and health check.

## Phase 2: Domain Model & Persistence

### 2.1 Graph Schema (SQLite)
- Extend `src/rag/corpusCache.ts` with new tables:
    - `jobs_graph_metadata`: Links `JobPosting` to `Company`, `Location`, etc.
    - `companies`: Basic metadata + career page tracking.
    - `duplicate_clusters`: Grouping identical postings.
- Add migrations logic to ensure backward compatibility.

### 2.2 Canonical Mapping
- Update `src/rag/adapters/job.ts` to include `fromJobSpy(raw: JobSpyResult): JobListing`.
- Implement ID generation logic in `src/rag/jobDedup.ts`.

## Phase 3: Pipeline Refactor

### 3.1 Staged Pipeline Implementation
- Create `src/rag/jobPipeline.ts` (new) or refactor `src/tools/semanticJobs.ts`.
- **Step 1**: Discovery via `searchJobSpy()` + `webSearch` (hybrid).
- **Step 2**: Initial `dedupJobListings()`.
- **Step 3**: Metadata scoring.
- **Step 4**: Targeted `webCrawl()` (Crawl4AI) on selected URLs.
- **Step 5**: Enrichment: Merge crawled text into `extractedText`.

### 3.2 Enrichment Adapter
- Update `extractJobListingsFromHtml` to support "Enrichment Mode":
    - If a listing already exists, update missing fields (salary, description, applyUrl) instead of creating a new one.

## Phase 4: Intelligence & Scoring

### 4.1 Graph Scoring
- Refactor `src/rag/jobRanking.ts` to use graph signals.
- Implementation of "Admin-vs-Sales" classification heuristic.
- Implementation of "Source reliability" based on `src/rag/sources/jobSources.ts`.

### 4.2 Search Intelligence Features
- Tracking historical postings (if a company keeps reposting).
- Aggregation queries for the "Smart Questions" mentioned in the feedback.

## Phase 5: Verification & DevEx

### 5.1 Updates to tool schema
- Update `server.registerTool('semantic_jobs', ...)` in `src/server.ts` to include new parameters.
- Add `health_check` support for the JobSpy sidecar.

### 5.2 Test Coverage
- Update `test/jobAdapter.test.ts`.
- New `test/jobPipeline.test.ts` for the staged flow.
- Integration test with a mock JobSpy sidecar.

## Checklist
- [ ] JobSpy FastAPI Sidecar
- [ ] TypeScript Bridge Client
- [ ] SQLite Graph Tables
- [ ] Staged Pipeline Logic (Discovery -> Dedupe -> Crawl -> RAG)
- [ ] Graph Scoring Signals
- [ ] Tool Schema Update
- [ ] Verification Tests
