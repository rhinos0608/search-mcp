# V3.0.5 — Job Adapter MVP: Implementation Plan

**Status**: Not Started  
**Priority**: High  
**Depends On**: V3.0.0 (extracted RAG pipeline + adapters)  
**Precedes**: V3.2.0 (full domain adapters)

## Overview

Add a focused MVP job adapter that extracts structured fields from crawled job pages and ranks with a simple weighted score. This bridges the gap between "semantic chunks" and "structured job listings" without waiting for V3.2.

## Why Now

V2 crawl testing exposed the ceiling:

- Tool succeeds at discovery but not disciplined structured retrieval
- 30+ relevant listings found, but structure lived in assistant's interpretation
- Tool returned ranked chunks; assistant reverse-engineered structure

A focused MVP extracts structured fields from crawled job pages and ranks with weighted composite — already beats "semantic chunk plus assistant interpretation."

## Goals

1. Extract structured fields from job listing pages
2. Track provenance (verification status)
3. Simple weighted composite ranking
4. Return structured `JobListingMVP` objects instead of chunks

## JobListingMVP Interface

```typescript
interface JobListingMVP {
  // Extracted fields (facts, not interpretation)
  title: string;
  company?: string;
  location?: string;
  workMode: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  salaryRaw?: string; // "$35-45.60/hr", "$80k + super" — raw text
  source: 'seek' | 'indeed' | 'jora' | 'linkedin' | 'other';
  sourceUrl?: string;
  jobId?: string;
  postedRaw?: string; // raw date string from listing
  extractedText: string; // full listing body for embedding

  // Confidence per field
  confidence: {
    title: number; // 0-1
    location: number;
    workMode: number;
    salary: number;
    overall: number;
  };

  // Provenance
  verificationStatus:
    | 'listing_page_fetched' // we hit the actual listing page
    | 'search_result_only' // search snippet, not full page
    | 'aggregator_result' // copied from another board (Jora from SEEK)
    | 'needs_manual_check'; // extraction unreliable

  // Caveats extracted from listing
  caveats: string[]; // ["temp contract", "via agency", "closing soon"]
}
```

## Pipeline

```
1. web_search + web_crawl for SEEK, Indeed, Jora (source profiles inform strategy)
2. Job MVP adapter parses each page → JobListingMVP[]
3. Filter by hard constraints (location, workMode) if provided
4. Rank with weighted composite score
5. Return RetrievalResponse<JobListingMVP> with corpusStatus
```

### Source Profiles (Partial, V3.0.5)

```typescript
const sourceProfiles: Record<string, SourceProfile> = {
  seek: {
    dynamicRisk: 'medium',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
    crawlReliability: 'high',
  },
  indeed: {
    dynamicRisk: 'high',
    duplicateRisk: 'high',
    structuredDataLikely: false,
    crawlReliability: 'medium',
  },
  jora: {
    dynamicRisk: 'low',
    duplicateRisk: 'high',
    structuredDataLikely: true,
    crawlReliability: 'high',
  },
};
```

### Job Adapter Extraction

```typescript
// src/rag/adapters/job.ts (MVP)

function extractJobListing(html: string, source: string, url: string): JobListingMVP {
  // Extract title
  const title = extractTitle(html) || 'unknown';

  // Extract company (site-specific selectors)
  const company = extractCompany(html, source);

  // Extract location
  const location = extractLocation(html);

  // Extract work mode (hybrid/remote/onsite keywords)
  const workMode = extractWorkMode(html);

  // Extract salary (regex for common formats)
  const salaryRaw = extractSalary(html);

  // Extract job ID
  const jobId = extractJobId(html, source, url);

  // Extract posted date
  const postedRaw = extractPostedDate(html);

  // Confidence scoring
  const confidence = {
    title: title ? 1 : 0,
    location: location ? 0.8 : 0,
    workMode: workMode !== 'unknown' ? 0.7 : 0,
    salary: salaryRaw ? 0.9 : 0,
    overall: calculateOverallConfidence(...),
  };

  // Verification status
  const verificationStatus = determineVerificationStatus(source, html);

  // Extract caveats
  const caveats = extractCaveats(html);

  return {
    title, company, location, workMode, salaryRaw,
    source: source as JobSource,
    sourceUrl: url,
    jobId, postedRaw,
    extractedText: extractTextContent(html),
    confidence,
    verificationStatus,
    caveats,
  };
}
```

## Simple Constraint-Aware Scoring

No full constraint pipeline yet. A weighted composite:

```typescript
// Simple composite score
function computeScore(
  listing: JobListingMVP,
  query: string,
  constraints?: QueryConstraints,
): number {
  // Hard constraint filter (if any fail, return -1)
  if (constraints?.location && !matchesLocation(listing.location, constraints.location)) return -1;
  if (constraints?.workMode && listing.workMode !== constraints.workMode[0]) return -1;

  const semanticScore = cosineSimilarity(listingEmbedding, queryEmbedding);
  const locationScore = matchesLocation(listing.location, query.location) ? 1 : 0;
  const workModeScore = matchesWorkMode(listing.workMode, query.workModePreference) ? 1 : 0.5;
  const recencyScore = calculateRecencyScore(listing.postedRaw);
  const completenessScore = listing.confidence.overall;

  return (
    semanticScore * 0.45 +
    locationScore * 0.2 +
    workModeScore * 0.15 +
    recencyScore * 0.1 +
    completenessScore * 0.1
  );
}
```

## Tool: semantic_jobs (MVP)

**Input schema:**

```typescript
{
  query: string,
  location?: string[],         // preferred locations (for ranking)
  workMode?: ('remote' | 'hybrid' | 'onsite')[],
  maxSalary?: number,          // filter by max salary
  minExperience?: number,     // filter by experience
  excludeTitles?: string[],    // exclude by title keywords
  topK?: number,
  debug?: boolean
}
```

**Output:** `RetrievalResponse<JobListingMVP>`

```typescript
interface JobSearchResponse {
  results: JobSearchResult[];
  corpusStatus: CorpusStatus;
  retrievalTrace?: RetrievalTrace;
}

interface JobSearchResult {
  item: JobListingMVP;
  overallScore: number;
  rank: number;
  matchedConstraints: string[];
  caveats: string[];
}
```

## Files to Create

1. `src/rag/adapters/job.ts` (MVP)
2. `src/rag/types/job.ts` (JobListingMVP interface)
3. `src/rag/sources/jobSources.ts` (source profiles for MVP job sites)
4. `src/rag/jobRanking.ts` (MVP constraints + weighted scoring)
5. `src/tools/semanticJobs.ts` (tool implementation)

## Files to Modify

1. `src/rag/adapters/index.ts` (register job adapter)
2. `src/rag/pipeline.ts` (add job retrieval path)
3. `src/server.ts` (register semantic_jobs tool)

## Quality Gates

- [ ] Job MVP adapter extracts title, location, workMode, salary from SEEK and Jora pages
- [ ] `verificationStatus` distinguishes fetched pages from search snippets from aggregators
- [ ] Weighted composite score beats pure semantic ranking on location-constrained queries
- [ ] Confidence scores reflect reality — listing with no salary returns `salary: 0`
- [ ] Caveats extracted from listing text (not invented)
- [ ] All fields are facts from listing page; no interpretation layer

## Open Questions

1. **LinkedIn: skip or attempt?**
   - Decision: Skip for V3.0.5. LinkedIn is low-reliability and auth-wall prone; V3.2 adds best-effort support with source profiles and explicit caveats.

2. **Source profiles in V3.0.5 or V3.2?**
   - Decision: Partial in V3.0.5 (SEEK, Indeed, Jora only), full in V3.2

3. **Dedup: skip or placeholder?**
   - Decision: Skip for MVP (V3.2 adds three-layer dedup)

## Dependencies

- V3.0.0 RAG pipeline
- `web_search` + `web_crawl` (existing)
- Embedding sidecar (existing)

## Estimated Scope

- Job adapter extraction: ~400 LOC
- Source profiles: ~200 LOC
- Tool registration: ~150 LOC

**Total new code: ~750 LOC**

---

**Next Step**: V3.1.0 — Code / GitHub
