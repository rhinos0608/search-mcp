# 2026-05-08 — Free Backends Expansion Plan

**Status**: Planning  
**Scope**: Add free or API-gated-free news/research/data backends under the existing tool families.  
**Primary home**: `research` family

## Synthesis

The repo already has the right shape for this work:

- `research` is the natural extension point for scholarly + public-data search.
- `browser` stays the escape hatch for pages without APIs.
- `web_search` remains the generic discovery layer.

From the research pass, the strongest free / low-friction candidates are:

### Research / scholarly

- `openalex` — broad scholarly graph, CC0 data, strong docs
- `crossref` — DOI metadata, citations, lots of structured fields, no signup for public access
- `datacite` — research data + DOI metadata + relation graph
- `ror` — organization registry, tiny surface area, very MCP-friendly
- `semantic_scholar` — worth exposing directly, not only through `academic`
- `pubmed` / `arxiv` — already present; keep as baseline

### News / event

- `gdelt` — best fit for free news/event search; structured, broad coverage, no key
- optional later: RSS-style source wrappers if we want specific outlets

### Public data

- `wikidata` — structured entity graph, no key
- `worldbank` — global indicators, no key
- `fred` — macro/economic series, API key optional
- `census` — demographic/economic stats, free key
- `sec` — public filings / company data, no key

## Recommendation

Do this in two waves.

### Wave 1: highest leverage

Add these first:

1. `research.openalex`
2. `research.crossref`
3. `research.datacite`
4. `research.ror`
5. `research.gdelt`
6. `research.wikidata`

Also expose:

- `research.semantic_scholar` as a direct action

Why first:

- best documentation
- strongest structured outputs
- broadest reuse across user queries
- lowest licensing risk

### Wave 2: public data expansion

Add:

- `research.worldbank`
- `research.fred`
- `research.census`
- `research.sec`
- `research.openmeteo` or `research.noaa` only if weather becomes a real user need

## Architecture

Keep the current family model. Do **not** create a new top-level family yet.

### Shared helpers to add

- `src/tools/apiClient.ts`
  - timeout + retry + safe URL + user agent
  - optional API key/header injection
  - shared JSON/text fetch wrapper
- `src/tools/pagination.ts`
  - cursor and offset paging helpers
- `src/tools/normalize.ts`
  - result normalization helpers for title/url/snippet/source fields

### Per-backend modules

One module per backend only when the parser is non-trivial:

- `openalexSearch.ts`
- `crossrefSearch.ts`
- `dataciteSearch.ts`
- `rorSearch.ts`
- `gdeltSearch.ts`
- `wikidataSearch.ts`
- later: `worldbankSearch.ts`, `fredSearch.ts`, `censusSearch.ts`, `secSearch.ts`

## Family changes

### `src/tools/families/research.ts`

Add new actions and schemas.

Suggested action names:

- `openalex`
- `crossref`
- `datacite`
- `ror`
- `semantic_scholar`
- `gdelt`
- `wikidata`
- `worldbank`
- `fred`
- `census`
- `sec`

Keep `academic` as the merged/default scholarly search for convenience.

## Rollout plan

### Phase 1 — helper layer

- add shared HTTP/pagination helpers
- add config and rate-limit handling for polite pools / API keys
- add mocks and fixture helpers for fetch-based tests

### Phase 2 — scholarly APIs

- implement OpenAlex, Crossref, DataCite, ROR, direct Semantic Scholar
- wire into `research` family
- add health/capability reporting

### Phase 3 — news + public data

- implement GDELT, Wikidata, World Bank, FRED, Census, SEC
- keep parsers strict and outputs short
- add truncation and pagination guardrails

### Phase 4 — hardening

- add tests for each action
- verify config degradation messages
- document rate limits / polite usage
- update plan index if we want discoverability

## Acceptance criteria

- All new actions register under `research`
- No new top-level family needed
- Each tool returns normalized MCP-friendly JSON text
- Health check reports availability and config requirements
- Tests cover success, empty-result, timeout, and rate-limit paths
- Docs mention free-tier/auth requirements clearly

## Risks

- free APIs still have real rate limits
- Crossref/OpenAlex prefer email/user-agent hygiene
- GDELT/Wikidata can be noisy without query shaping
- per-source response shapes vary, so shared normalization matters

## Not doing yet

- paid / enterprise-only sources
- scraping-first news sources without stable APIs
- a dedicated `news` family until usage proves it needed
