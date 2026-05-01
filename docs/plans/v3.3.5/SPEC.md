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
A persistent relational structure in SQLite with relationships and integrity:

- `JobPosting`: ID (PK), Title, Description, PostedAt, ExpiresAt, WorkMode (ENUM), Seniority, SalaryRange (`SalaryMin`, `SalaryMax` DECIMAL, `CurrencyCode`, `Unit`), Confidence (FLOAT 0.0-1.0), CompanyID (FK), LocationID (FK), SourceBoardID (FK).
- `Company`: ID (PK), Name, Domain (UNIQUE), Industry, Description, CareersPageUrl, Reliability (FLOAT 0.0-1.0).
- `Location`: ID (PK), City, State, Country, Latitude (DECIMAL 9,6), Longitude (DECIMAL 9,6).
- `SourceBoard`: ID (PK), Name (UNIQUE), BaseUrl, Reliability.
- `Skill`: ID (PK), Name (UNIQUE), Category.
- `JobPostingSkill`: JobPostingID (FK), SkillID (FK) - Junction table.
- `DuplicateCluster`: ID (PK), CanonicalPostingID (FK → JobPosting.ID), Members (TEXT array of IDs).

**Operational Details**:
- **Indexes**: `JobPosting(PostedAt)`, `Company(Domain)`, `Location(City, State, Country)`, `Skill(Name)`, `DuplicateCluster(CanonicalPostingID)`.
- **FK Behavior**: ON DELETE SET NULL for external links; CASCADE for junction tables.
- **Lifecycle**: retention policy expires postings where `ExpiresAt < now` or `VerifiedAt < now - 30d`. Background cleanup runs daily at 02:00 UTC.

### 3. Staged Enrichment Pipeline
Efficiency-optimized multi-stage process with error handling and success thresholds:

| Stage | Name | Action | Error Handling | Timeout | Scale |
|---|---|---|---|---|---|
| 1 | **Discovery** | JobSpy acquisition | 3x retry; skip on fail | 55s | 100–300 |
| 2 | **Normalization** | Dedupe, cluster, canonicalize | Abort on system error | 10s | ~50–100 |
| 3 | **Scoring (Lexical)** | Metadata-based pass (salary, location, title) | Partial result prop | 5s | ~50–100 |
| 4 | **Enrichment (Crawl)** | Targeted Crawl4AI (3 workers, 10 batch size) | 1x retry; skip URL | 30s | 30–50 |
| 5 | **RAG (Embed/Rank)** | Embedding + Reranking (all-MiniLM-L6-v2) | Fallback to lexical | 20s | 30–50 |
| 6 | **Verification** | Final deep check (Alive? Sales churn? Redundancy?) | Mark as unverified | 10s | 10–20 |

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
Calculated in `rankJobListings` module using data from the Job Graph:

- **Company Reliability**: (avg tenure * 0.4 + rating * 0.3 + 0.3 smoothing). Data source: `companies` table, updated every 7d via Glassdoor/LinkedIn crawls.
- **Admin-vs-Sales Confidence**: Logistic regression classifier (LGBM) on keyword vector. Threshold 0.6. Features: "commission", "uncapped", "manager", "data entry".
- **Duplicate Density**: `log(1 + source_count) / max_sources_in_industry`. Signals breadth of acquisition effort.
- **Salary Transparency**: `0.5 * (hasMinSalary) + 0.5 * (hasMaxSalary)`. Bonus 0.2 if structured.
- **Freshness Decay**: `exp(-λ * hours_since_post)` where `λ = 0.005` (tuned for 7-day half-life).

**Integration**: Signals are normalized to 0-1, weighted by configured priorities, and linearly combined with lexical scores.

## Dependencies
- `python-jobspy` (v1.2.0+) - Scraper library
- `Crawl4AI` (Pin to tested release) - Enrichment engine
- `sqlite3` (System/Stdlib, engine v3.35+) - Persistence
- `FastAPI` (v0.95+) - Microservice for JobSpy Bridge Sidecar
- `sentence-transformers/all-MiniLM-L6-v2` - Embedding model
- `cross-encoder/ms-marco-MiniLM-L-6-v2` - Reranker model
