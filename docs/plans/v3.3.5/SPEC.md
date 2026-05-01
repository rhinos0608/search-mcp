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
- **Primary**: `python-jobspy` via a Python bridge or FastAPI sidecar.
- **Input**: Query, Location, Radius, Job Type, Remote preference, Sites (Indeed, LinkedIn, Glassdoor, ZipRecruiter).
- **Output**: Canonical job records (rows).
- **Fallback**: Existing `webSearch` logic for recall gaps (local councils, niche portals).

### 2. Canonical Data Model (The Job Graph)
A persistent relational structure (implemented in SQLite) representing the job market graph:

- `JobPosting`: ID, Title, Description, PostedAt, ExpiresAt, WorkMode, Seniority, SalaryRange, VerifiedAt, Confidence.
- `Company`: ID, Name, Domain, Industry, Description, CareersPageUrl.
- `Location`: ID, City, State, Country, Coordinates.
- `SourceBoard`: ID, Name (Seek, LinkedIn, etc.), BaseUrl, Reliability.
- `Skill`: ID, Name, Category.
- `DuplicateCluster`: ID, CanonicalPostingID, Members (JobPostingIDs).

### 3. Staged Enrichment Pipeline
Efficiency-optimized multi-stage process:

| Stage | Name | Action | Scale |
|---|---|---|---|
| 1 | **Discovery** | JobSpy acquisition | 100–300 candidates |
| 2 | **Normalization** | Dedupe, cluster, and canonicalize | ~50–100 clusters |
| 3 | **Scoring (Lexical)** | Metadata-based pass (salary, location, title matches) | ~50–100 clusters |
| 4 | **Enrichment (Crawl)** | Targeted Crawl4AI on top clusters (description, apply links) | 30–50 crawls |
| 5 | **RAG (Embed/Rank)** | Embedding + Reranking over enriched corpus | Top 30–50 |
| 6 | **Verification** | Final deep check (is listing still open? is it sales churn?) | Top 10–20 |

## Tool Interface Changes
The `semantic_jobs` tool will be updated to support the new pipeline while maintaining backward compatibility:

```typescript
export interface SemanticJobsOptions {
  query: string;
  location?: string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  maxSalary?: number;
  sites?: ('indeed' | 'linkedin' | 'glassdoor' | 'zip_recruiter' | 'google' | 'seek')[]; // Extra sites
  useGraph?: boolean; // Opt-in to graph-based intelligence
  enrichmentLevel?: 'standard' | 'deep'; // Controls Crawl4AI depth
}
```

## Graph-Derived Scoring Features
New signals added to the `rankJobListings` module:
- **Company Reliability**: Historical data on employer quality.
- **Duplicate Density**: Breadth of posting across sources.
- **Salary Transparency**: Weighted score for providing structured salary data.
- **Freshness Decay**: Time-based decay of relevance.
- **Admin-vs-Sales Confidence**: Model-based classification of the role type.

## Dependencies
- `python-jobspy` (Python library)
- `Crawl4AI` (Existing sidecar)
- `sqlite3` (Existing persistence)
- `FastAPI` (for the JobSpy bridge sidecar)
