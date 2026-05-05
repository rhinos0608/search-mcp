# V3.3.5: Job Intelligence Pipeline & Graph Layer

## Overview

V3.3.5 transitions the `semantic_jobs` tool from a "web search first" approach to a structured "job-shaped entrypoint" pipeline. It introduces `JobSpy` as the primary acquisition layer, a graph-based data model for jobs and companies, and a staged enrichment process using `Crawl4AI`.

## Core Objectives

1. **Higher-Quality Discovery**: Replace blind web search with `JobSpy` to get structured job candidates from the start.
2. **Targeted Enrichment**: Use `Crawl4AI` with intent, fetching specific details for identified job URLs rather than crawling search results.
3. **Structured Context (Job Graph)**: Model relationships between jobs, companies, locations, and skills to enable intelligent market analysis.
4. **Resilient Hybrid Acquisition**: Use web search as a fallback for niche boards and recall gaps.
5. **Efficiency**: Reduce crawling bandwidth by focusing on high-value targets.

## Architecture

### 1. Acquisition Layer (JobSpy Bridge)

- **Primary**: `python-jobspy` via a FastAPI sidecar bridge.
- **Operational Specs**:
  - Per-source rate limits: Indeed (10/min), LinkedIn (5/min), Glassdoor (5/min), ZipRecruiter (10/min).
  - Quota management: Global cap at 50 requests/min; circuit breaker trips at 30% failure ratio.
  - Error handling: Max 3 retries; exponential backoff (base 1s, factor 2, max 16s).
  - Timeouts: 10s connection timeout; 55s total request timeout.
  - Auth: API Key/Token rotation; rotation logic managed in `jobspyClient.ts`.
- **Input**: Query, Location, Radius, Job Type, Remote preference, Sites (Indeed, LinkedIn, Glassdoor, ZipRecruiter).
- **Output**: Canonical job records (rows).
- **Fallback**: Existing `webSearch` logic for recall gaps.

### 2. Canonical Data Model (The Job Graph)

A persistent relational structure in SQLite with relationships and integrity (migration v2 in `src/utils/jobGraphDb.ts`):

Actual tables (`graph_job_postings`, `graph_companies`, etc.):

| Entity                     | Implemented Columns                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph_job_postings`       | `job_id` (PK), `title`, `company_id`, `location_id`, `source_site`, `source_url`, `salary_min`, `salary_max`, `salary_currency`, `salary_interval`, `work_mode`, `job_type`, `seniority`, `posted_at`, `description`, `extracted_text`, `verification_status`, `confidence`, `caveats` |
| `graph_companies`          | `company_id` (PK), `name`, `domain`, `industry`, `careers_page_url`, `logo_url`, `first_seen_at`, `last_seen_at`                                                                                                                                                                       |
| `graph_locations`          | `location_id` (PK), `city`, `state`, `country`, `display_name`                                                                                                                                                                                                                         |
| `graph_skills`             | `skill_id` (PK), `name`, `category`                                                                                                                                                                                                                                                    |
| `graph_job_skills`         | `job_id` (PK), `skill_id` (PK) — junction table                                                                                                                                                                                                                                        |
| `graph_duplicate_clusters` | `cluster_id` (PK), `canonical_job_id`, `member_job_ids`, `member_sites`, `cluster_size`, `first_seen_at`, `last_seen_at`                                                                                                                                                               |

> **TODO — Missing from v2** (migration `src/utils/jobGraphDb.ts`): ~~`ExpiresAt`~~ (table uses `posted_at` instead), ~~`SourceBoard`~~ table, ~~`Company.Reliability`~~ column. These are planned for a future migration.

**Operational Details**:

- **Indexes**: `graph_job_postings(company_id)`, `graph_companies(name)`, `graph_locations(display_name)`, `graph_skills(name)`, `graph_duplicate_clusters(canonical_job_id)`.
- **FK Behavior**: ON DELETE SET NULL for external links; CASCADE for junction tables.
- **Lifecycle**: retention policy expires postings where `posted_at` is older than 30d (no `ExpiresAt` yet — `posted_at` is the reference). Background cleanup runs daily at 02:00 UTC.

### 3. Staged Enrichment Pipeline

Efficiency-optimized multi-stage process with error handling and success thresholds:

| Stage | Name                   | Action                                             | Error Handling         | Timeout | Scale   |
| ----- | ---------------------- | -------------------------------------------------- | ---------------------- | ------- | ------- |
| 1     | **Discovery**          | JobSpy acquisition                                 | 3x retry; skip on fail | 55s     | 100–300 |
| 2     | **Normalization**      | Dedupe, cluster, canonicalize                      | Abort on system error  | 10s     | ~50–100 |
| 3     | **Scoring (Lexical)**  | Metadata-based pass (salary, location, title)      | Partial result prop    | 5s      | ~50–100 |
| 4     | **Enrichment (Crawl)** | Targeted Crawl4AI (3 workers, 10 batch size)       | 1x retry; skip URL     | 30s     | 30–50   |
| 5     | **RAG (Embed/Rank)**   | Embedding + Reranking (all-MiniLM-L6-v2)           | Fallback to lexical    | 20s     | 30–50   |
| 6     | **Verification**       | Final deep check (Alive? Sales churn? Redundancy?) | Mark as unverified     | 10s     | 10–20   |

**Verification Checks**:

- **Alive Check**: Head request to `applyUrl` (skip if 404).
- **Apply-link Validation**: Domain matches expected site/company.
- **Sales Churn**: Heuristic to detect multi-level-marketing or high-turnover sales roles based on keywords ("uncapped", "commission only") and `Company Reliability`.
- **Fraud Check**: Domain age check for remote-only startups.

**Success Criteria**: Discovery must yield > 5 candidates; Enrichment retention > 60%; Ranking confidence > 0.4.

## Tool Interface Changes

The `semantic_jobs` tool will be updated to support the new pipeline while maintaining backward compatibility:

```typescript
export interface SemanticJobsOptions {
  query: string;
  /** Radius in miles around location. Defaults to 25. */
  radius?: number;
  /** Minimum annual salary. Constraint: minSalary >= 0. */
  minSalary?: number;
  /** Format: "City, State" or "City, State, Country". First entry preferred. */
  location?: string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  maxSalary?: number;
  /** Supported: 'indeed' | 'linkedin' | 'glassdoor' | 'zip_recruiter'. */
  sites?: ('indeed' | 'linkedin' | 'glassdoor' | 'zip_recruiter')[];
  /** Opt-in to graph-based intelligence. Default: false. */
  useGraph?: boolean;
  /** Controls Crawl4AI depth. Default: 'standard'. */
  enrichmentLevel?: 'standard' | 'deep';
}
```

## Graph-Derived Scoring Features

**Calculated in `rankJobListings` module (`src/rag/jobRanking.ts`) using data from the Job Graph:**

| Feature                 | Current Implementation                                                                                                                  | Status                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Duplicate Density**   | `calculateDuplicateScore(company, title)` → `min(siteCount * 0.05, 0.15)` via `findDuplicatesByTitleCompany`                            | **Implemented** in `score.componentScores.duplicateDensity`                                        |
| **Company Reliability** | `calculateCompanyReliability(company)` → derived from historical job count (`findJobsByCompany`), not tenure/rating. Range 0–0.1 boost. | **Implemented** (simple version). Data source: `graph_job_postings` count, not Glassdoor/LinkedIn. |
| **Freshness Decay**     | `calculateFreshnessScore(postedRaw)` → piecewise step function: ≤7d=1, ≤30d=0.7, ≤90d=0.3, else 0.                                      | **Implemented** in `score.componentScores.recency`                                                 |

|
| Feature | Planned Implementation | TODO |
|---------|----------------------|------|
| **Company Reliability v2** | Formula `(avg tenure × 0.4 + rating × 0.3 + 0.3 smoothing)` using Glassdoor/LinkedIn crawl data. | `TODO: src/rag/jobRanking.ts` — implement Glassdoor/LinkedIn company-data crawls and populate `graph_companies` with tenure/rating fields. |
| **Admin-vs-Sales Confidence** | LGBM classifier on keyword vector ("commission", "uncapped", "manager", "data entry"), threshold 0.6. | `TODO: src/rag/jobRanking.ts` — train and integrate LGBM model. |
| **Salary Transparency** | `0.5 × hasMinSalary + 0.5 × hasMaxSalary`, bonus 0.2 if structured. | `TODO: src/rag/jobRanking.ts` — implement formula and add `score.componentScores.salaryTransparency`. |
| **Duplicate Density v2** | `log(1 + source_count) / max_sources_in_industry` (normalised per industry). | `TODO: src/rag/jobRanking.ts` — replace current linear formula. |
| **Freshness Decay v2** | `exp(-λ × hours_since_post)` with λ=0.005 (7-day half-life) using `posted_at` timestamp. | `TODO: src/rag/jobRanking.ts` — replace step function with continuous decay. |

**Integration**: Signals are normalized to 0-1, weighted by configured priorities, and linearly combined with lexical scores in `rankJobListings`.

## Dependencies

- `python-jobspy` (v1.1.82, latest 1.1.x) — Scraper library (Python sidecar)
- `Crawl4AI` (v0.8.6 — Python >= 3.10 required) — Enrichment engine
- `sqlite3` (System/Stdlib, engine v3.35+) — Persistence
- `FastAPI` (v0.136.1) — Microservice for JobSpy Bridge Sidecar
- `Xenova/all-MiniLM-L6-v2` (Transformers.js embedding; SPEC references `sentence-transformers/all-MiniLM-L6-v2` for Python contexts)
- `Xenova/ms-marco-MiniML-L-6-v2` (ONNX reranker; SPEC references `cross-encoder/ms-marco-MiniLM-L-6-v2` for Python contexts)
