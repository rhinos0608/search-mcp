# 2026-05-11 — Free Backends Implementation Spec

**Status**: Spec  
**Parent**: [2026-05-08 — Free Backends Expansion Plan](./2026-05-08-free-backends-expansion-plan.md)

## Scope

Add 7 free-backend actions to the `research` family. All actions require zero API keys, use public REST/JSON APIs, and follow existing family patterns.

### Wave 1 (this spec covers)

| Action | API | Type | Docs |
|--------|-----|------|------|
| `openalex` | OpenAlex REST v1 | Scholarly works/authors/venues graph | [docs.openalex.org](https://docs.openalex.org) |
| `crossref` | Crossref REST v1 | DOI metadata + citation graph | [api.crossref.org](https://api.crossref.org) |
| `datacite` | DataCite REST v1 | Research data DOIs + relations | [support.datacite.org](https://support.datacite.org/docs/api) |
| `ror` | ROR REST v1 | Research organization registry | [ror.readme.io](https://ror.readme.io) |
| `semantic_scholar` | Semantic Scholar v1 (direct) | Already called by `academic`, exposed directly | [api.semanticscholar.org](https://api.semanticscholar.org) |
| `gdelt` | GDELT 2.0 API | Global news/event database | [gdeltproject.org](https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/) |
| `wikidata` | Wikidata REST v1 | Structured entity graph | [wikidata.org](https://www.wikidata.org/wiki/Wikidata:REST_API) |

## Architecture

### No new infrastructure

No shared helper layer is created upfront. Each backend module is self-contained and follows the same shape as existing modules (`wikipediaSearch.ts`, `pubmedSearch.ts`, `stackoverflowSearch.ts`):

```
src/tools/openalexSearch.ts
src/tools/crossrefSearch.ts
src/tools/dataciteSearch.ts
src/tools/rorSearch.ts
src/tools/semanticScholarSearch.ts  (new; `academic` internally calls `academicSearch.ts` which uses both ArXiv + Semantic Scholar)
src/tools/gdeltSearch.ts
src/tools/wikidataSearch.ts
src/tools/__tests__/openalexSearch.test.ts
src/tools/__tests__/crossrefSearch.test.ts
src/tools/__tests__/dataciteSearch.test.ts
src/tools/__tests__/rorSearch.test.ts
src/tools/__tests__/semanticScholarSearch.test.ts
src/tools/__tests__/gdeltSearch.test.ts
src/tools/__tests__/wikidataSearch.test.ts
```

All wired into `src/tools/families/research.ts` via `FamilyAction`.

### Module template

Each module:

```typescript
/**
 * {NAME} search via {API}.
 *
 * Free, no API key required. {Brief usage notes}.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface {Name}Result {
  title: string;
  link: string;
  snippet: string;
  // ... backend-specific fields
}

export async function search{Name}(query: string, limit = 10): Promise<{Name}Result[]> {
  // 1. Build URL
  // 2. Fetch with timeout + safeResponseJson
  // 3. Parse + normalize into {Name}Result[]
  // 4. Return slice(0, limit)
}
```

### Family registration pattern

Follow the exact pattern from existing actions. Each new action gets:

```typescript
const {name}Action = z.object({
  action: z.literal('{name}').describe('{description}'),
  query: z.string().describe('The search query string'),
  limit: z.number().int().min(1).max(50).optional().default(20)
    .describe('Maximum results to return (1–50, default 20)'),
  // ... backend-specific filters
});
```

Handler in `researchFamily.actions`:

```typescript
{
  name: '{name}',
  description: '{description}',
  schema: {name}Action,
  handler: async (args, _cfg) => {
    void _cfg;
    const { query, limit } = args as { query: string; limit: number };
    return search{Name}(query, limit);
  },
}
```

No `configIssue` — all free, no API key required.

### Semantic Scholar: avoid duplication

The existing `academicSearch.ts` internally calls Semantic Scholar. We will **not** refactor `academicSearch.ts`. Instead, `semanticScholarSearch.ts` is a thin wrapper that calls the Semantic Scholar API directly, reusing the existing `semanticScholarFetch` call pattern from `academicSearch.ts` (exporting the relevant function). This is cleaner than exposing `academicSearch.ts` internals.

Option: if `academicSearch.ts`'s Semantic Scholar call is tightly coupled, just make a direct call in the new module. There's no issue duplicating a `fetch()` call — it's simpler and more maintainable.

## Per-Backend Details

### 1. openalex

- **Base**: `https://api.openalex.org/works`
- **Params**: `search={query}`, `per_page={limit}`, `sort=relevance`
- **Politeness**: Mailto user-agent header (`search-mcp/5.4.0 (mailto:your-email@example.com)`)
- **Result shape**:
  ```typescript
  export interface OpenAlexResult {
    title: string;
    link: string;           // openalex.org URL
    snippet: string;        // from abstract_inverted_index or primary_topic
    publishedDate?: string;
    authors?: string[];
    doi?: string;
    citedByCount?: number;
    type?: string;          // article, book, etc.
  }
  ```
- **Note**: OpenAlex returns `abstract_inverted_index` (word→positions map), not plain text. Reconstruct abstract if feasible, else fallback to topic description.

### 2. crossref

- **Base**: `https://api.crossref.org/works`
- **Params**: `query={query}`, `rows={limit}`
- **Politeness**: User-Agent header identifying the app
- **Result shape**:
  ```typescript
  export interface CrossrefResult {
    title: string;
    link: string;           // DOI URL
    snippet: string;        // from abstract
    publishedDate?: string;
    authors?: string[];
    doi?: string;
    publisher?: string;
    type?: string;          // journal-article, book-chapter, etc.
  }
  ```
- **Note**: Crossref `items` array, each has `title` (string array), `abstract`, `author`, `DOI`.

### 3. datacite

- **Base**: `https://api.datacite.org/dois`
- **Params**: `query={query}`, `page[size]={limit}`
- **Result shape**:
  ```typescript
  export interface DataCiteResult {
    title: string;
    link: string;           // DOI URL
    snippet: string;        // from description
    publishedDate?: string;
    publisher?: string;
    doi?: string;
    resourceType?: string;
  }
  ```
- **Note**: DataCite uses JSON:API format. `data[].attributes` contains titles, descriptions, dates.

### 4. ror

- **Base**: `https://api.ror.org/v2/organizations`
- **Params**: `query={query}`
- **Result shape**:
  ```typescript
  export interface RorResult {
    title: string;          // organization name
    link: string;           // ror.org URL
    snippet: string;        // from types + location
    types?: string[];       // Education, Facility, etc.
    country?: string;
    city?: string;
    established?: number;
    rorId?: string;
  }
  ```
- **Note**: ROR is a lookup, not a search — results are small. Return up to `limit` items.

### 5. semantic_scholar (direct)

- **Base**: `https://api.semanticscholar.org/graph/v1/paper/search`
- **Params**: `query={query}`, `limit={limit}`, `fields=title,year,authors,abstract,url,externalIds,citationCount`
- **Result shape**:
  ```typescript
  export interface SemanticScholarResult {
    title: string;
    link: string;           // Semantic Scholar URL or DOI
    snippet: string;        // from abstract
    publishedDate?: string; // year
    authors?: string[];
    citationCount?: number;
    doi?: string;
    paperId?: string;
  }
  ```
- **Rate limit**: 100 req/5min unauthenticated. No key needed.

### 6. gdelt

- **Base**: `https://api.gdeltproject.org/api/v2/doc/doc`
- **Params**: `query={query}`, `mode=ArtList`, `format=json`, `maxrecords={limit}`, `timespan=30d`
- **Result shape**:
  ```typescript
  export interface GdeltResult {
    title: string;
    link: string;           // source URL
    snippet: string;        // from article text
    publishedDate?: string;
    sourceCountry?: string;
    tone?: number;          // -100 to +100 sentiment
    domain?: string;
  }
  ```
- **Note**: GDELT returns HTML-ish content in `articles[]`. Parse the JSON-encoded `articles` field. Optional `timespan` filter: `30d`, `7d`, `1d`, `24h`, etc.

### 7. wikidata

- **Base**: `https://www.wikidata.org/w/rest.php/wikibase/v0/entities/items/{id}` for item lookup  
  **Search**: `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={query}&language=en&limit={limit}&format=json`
- **Result shape**:
  ```typescript
  export interface WikidataResult {
    title: string;          // label
    link: string;           // wikidata.org/wiki/Q{id}
    snippet: string;        // description
    qid?: string;           // Q-number
    aliases?: string[];
  }
  ```
- **Note**: Use `wbsearchentities` API for discovery, then optional entity detail fetch per result. Keep it simple: return search results with label + description.

## Config / Env Vars

None required. All backends are free and public.

| Backend | Rate Limit (unauthenticated) | Politeness |
|---------|------------------------------|------------|
| OpenAlex | 100k/day | mailto in User-Agent |
| Crossref | 50 req/sec | `search-mcp/5.4.0` User-Agent |
| DataCite | None published | Polite User-Agent |
| ROR | None published | Polite User-Agent |
| Semantic Scholar | 100/5min | Already handled |
| GDELT | None published | Polite User-Agent |
| Wikidata | None published per se | `search-mcp/5.4.0` User-Agent |

## Health Check Integration

Each new action auto-reports as `healthy` (unauthenticated, always available) via the existing `researchCapabilities` pattern. Network probes for each backend added to `src/health.ts` → `getNetworkProbes()`.

Probe URLs:
- `openalex`: `https://api.openalex.org/works?search=test&per_page=1`
- `crossref`: `https://api.crossref.org/works?query=test&rows=1`
- `datacite`: `https://api.datacite.org/dois?query=test&page[size]=1`
- `ror`: `https://api.ror.org/v2/organizations?query=stanford`
- `semantic-scholar`: already probed
- `gdelt`: `https://api.gdeltproject.org/api/v2/doc/doc?query=test&mode=ArtList&format=json&maxrecords=1`
- `wikidata`: `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=test&language=en&format=json`

## Test Plan

Each module gets a test file at `src/tools/__tests__/{name}Search.test.ts`.

Test patterns (matching existing tests):
```typescript
import { describe, it, expect } from 'vitest';
import { search{Name} } from '../{name}Search.js';

describe('search{Name}', () => {
  it('returns results for a valid query', async () => {
    const results = await search{Name}('machine learning', 3);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.title).toBe('string');
      expect(r.title.length).toBeGreaterThan(0);
      expect(typeof r.link).toBe('string');
      expect(r.link.length).toBeGreaterThan(0);
    }
  });

  it('respects limit parameter', async () => {
    const results = await search{Name}('test', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('handles empty queries gracefully', async () => {
    const results = await search{Name}('', 5);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});
```

## Acceptance Criteria

- [ ] All 7 new actions register under `research`
- [ ] Each module exports typed interface + search function
- [ ] Each action has Zod schema with `action: z.literal(...)`
- [ ] Family description updated to mention new sources
- [ ] Health probes added to `getNetworkProbes()`
- [ ] Tests pass: success, empty-result, limit-respecting
- [ ] TypeScript strict mode passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
