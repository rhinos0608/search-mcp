# V3.3.0 — Implementation Plan

**Based On**: `docs/plans/v3.3.0/SPEC.md`  
**Date**: 2026-04-25

---

## Stage 1: Contextual Embeddings

### 1.1 New File: `src/rag/contextualEmbedding.ts`

```typescript
// Interface
interface ContextualEnrichment {
  embedText: string; // context + "\n---\n" + original chunk
  originalText: string; // unmodified chunk
  context: string; // LLM-generated situating context
  enriched: boolean; // true if LLM succeeded
}
```

**Core function**:

- `enrichChunkWithContext(chunk: string, fullDocument: string, llm: LlmConfig): Promise<ContextualEnrichment>`
- Prompt: same structure as mcp-crawl4ai-rag — `<document>`, `<chunk>`, ask for short context
- Model: `llm.provider`, token: `llm.apiToken`, base URL: `llm.baseUrl`
- Temperature: 0.3, max tokens: 200
- On failure: return `{ embedText: chunk, originalText: chunk, context: '', enriched: false }`

**Batch function**:

- `enrichChunksBatched(chunks: CorpusChunk[], documents: Map<string, string>, llm: LlmConfig, concurrency?: number): Promise<ContextualEnrichment[]>`
- Semaphore-based concurrency (default 5 parallel LLM calls)
- Maps each chunk to its parent document for context generation

### 1.2 Modify: `src/rag/types.ts`

Add to `CorpusChunk`:

```typescript
embedText?: string;  // text used for embedding (may differ from .text if enriched)
```

### 1.3 Modify: `src/tools/semanticCrawl.ts`

In `pagesToCorpus()` or the embedding path:

- After chunking, if `opts.useContextualEmbeddings` is true and LLM config is available:
  1. Build document map (URL → full markdown)
  2. Call `enrichChunksBatched()`
  3. Use `enrichment.embedText` for embedding, keep `enrichment.originalText` as `.text`
- If LLM config is missing, log warning and proceed without enrichment

### 1.4 Modify: `src/server.ts`

Add Zod parameter:

```typescript
useContextualEmbeddings: z.boolean().optional().default(false)
  .describe('Use LLM to generate contextual context for each chunk before embedding. Requires LLM_PROVIDER + LLM_API_TOKEN.'),
```

### 1.5 Tests: `test/contextualEmbedding.test.ts`

- Unit: prompt construction, graceful degradation on LLM failure
- Unit: concurrency semaphore behavior
- Integration: mock LLM responses, verify enrich/disable paths

---

## Stage 2: Domain Trust & Typosquat Detection

### 2.1 New File: `src/utils/domainTrust.ts`

**Types**:

```typescript
interface DomainTrustResult {
  domain: string;
  tier: 'trusted' | 'standard' | 'suspicious' | 'blocked';
  score: number; // 0.0 – 1.0
  reasons: string[];
  https: boolean;
  lookalikeOf?: string;
}
```

**Functions**:

- `evaluateDomainTrust(url: string, options?: TrustOptions): DomainTrustResult`
- `isBlockedUrl(url: string): boolean`
- `_levenshtein(a: string, b: string): number` — inline implementation (~20 lines)
- `_detectLookalike(domain: string, brands: string[]): string | undefined`

**Configuration**:

- `ESTABLISHED_DOMAINS: Set<string>` — hardcoded (~50 entries)
- `KNOWN_BRANDS: string[]` — hardcoded (~20 entries)
- `SUSPICIOUS_TLDS: Set<string>` — hardcoded (~20 entries)
- Env vars: `BLOCKED_DOMAINS` (comma-separated), `TRUSTED_DOMAINS` (comma-separated, appended to defaults)

### 2.2 Modify: `src/config.ts`

Add config keys:

```typescript
blockedDomains: string[];   // from BLOCKED_DOMAINS env
trustedDomains: string[];   // from TRUSTED_DOMAINS env (merged with defaults)
```

### 2.3 Modify: `src/tools/semanticCrawl.ts`

In `filterSafeUrls()` (or after it):

- Call `evaluateDomainTrust()` on each URL
- Drop URLs with `tier === 'blocked'`, log warning
- For `tier === 'suspicious'`, log warning but continue (operator decision)
- Attach trust result to page metadata

### 2.4 Tests: `test/domainTrust.test.ts`

- Unit: Levenshtein distance
- Unit: lookalike detection for known typosquats
- Unit: established domain recognition
- Unit: suspicious TLD detection
- Unit: blocked domain filtering
- Unit: env var override for custom allowlists/blocklists

---

## Stage 3: Query Expansion for web_search

### 3.1 New File: `src/tools/queryExpansion.ts`

**Types**:

```typescript
interface QueryVariation {
  query: string;
  strategy: 'original' | 'question' | 'concept' | 'scope' | 'opposition';
}
```

**Functions**:

- `expandQuery(original: string): QueryVariation[]` — returns 1-5 variations
- `_toQuestion(query: string, words: string[]): string | undefined`
- `_expandConcepts(query: string, words: string[]): string | undefined`
- `_adjustScope(query: string, words: string[]): string | undefined`

**Concept map**: Port ~60 entries from agent-search `CONCEPT_MAP` (tech, business, finance, manufacturing domains)

### 3.2 Modify: `src/tools/webSearch.ts`

- When `opts.expandQuery === true`:
  1. Call `expandQuery(opts.query)` to get variations
  2. Execute each variation via the configured search backend (parallel with semaphore)
  3. Deduplicate results by normalized URL
  4. Merge, keeping longest snippet per URL
  5. Return unified result set

### 3.3 Modify: `src/server.ts`

Add Zod parameter:

```typescript
expandQuery: z.boolean().optional().default(false)
  .describe('Generate query variations and merge results for broader coverage.'),
```

### 3.4 Tests: `test/queryExpansion.test.ts`

- Unit: question form generation
- Unit: concept expansion
- Unit: deduplication of variations
- Unit: edge cases (empty query, single word, very long query)
- Integration: mock search backend, verify merge behavior

---

## Stage 4: External Content Recovery Fallbacks

### 4.1 New File: `src/utils/externalRecovery.ts`

**Types**:

```typescript
interface RecoveryResult {
  content: string | null;
  source: 'wayback' | 'google-cache' | null;
  error?: string;
}
```

**Functions**:

- `attemptWaybackRecovery(url: string): Promise<RecoveryResult>`
  - CDX API: `https://web.archive.org/cdx/search/cdx?url=...&output=json&limit=1&sort=reverse`
  - Parse timestamp, construct snapshot URL, fetch HTML
  - Extract content via `webRead` Readability path
- `attemptGoogleCacheRecovery(url: string): Promise<RecoveryResult>`
  - Fetch from `https://webcache.googleusercontent.com/search?q=cache:{url}`
  - Extract content via `webRead` Readability path
- `attemptExternalRecovery(url: string): Promise<RecoveryResult>`
  - Try Wayback first, then Google Cache
  - Return first successful result

### 4.2 Modify: `src/tools/webCrawl.ts`

In `webCrawl()` function, after aggressive Crawl4AI retry also fails:

- Call `attemptExternalRecovery(url)`
- If successful, construct a synthetic `CrawlPageResult` with `markdown` set to recovered content
- Tag with `metadata.recoverySource`
- Log recovery success/failure

### 4.3 Modify: `src/types.ts`

Add to `CrawlPageResult.metadata`:

```typescript
recoverySource?: 'wayback' | 'google-cache' | 'aggressive-render';
```

### 4.4 Tests: `test/externalRecovery.test.ts`

- Unit: CDX API URL construction
- Unit: Google Cache URL construction
- Integration: mock HTTP responses for Wayback/Cache
- Integration: verify fallback chain ordering
- Edge: timeout handling, both fallbacks fail

---

## Stage 5: Content Scrubbing

### 5.1 New File: `src/utils/contentScrubber.ts`

**Types**:

```typescript
type ThreatType =
  | 'prompt_injection'
  | 'instruction_override'
  | 'data_exfiltration'
  | 'impersonation'
  | 'payload_smuggling'
  | 'xss_injection';

interface ThreatDetection {
  type: ThreatType;
  confidence: number;
  evidence: string;
}

interface ScrubResult {
  clean: boolean;
  content: string;
  threats: ThreatDetection[];
  riskScore: number; // 0.0 – 1.0
  redactions: number;
}
```

**Functions**:

- `scrubContent(rawContent: string): ScrubResult`
- Pattern categories ported from agent-search `scrubber.py`:
  - ~30 prompt injection patterns (instruction override, role manipulation, jailbreak, chain manipulation)
  - ~10 exfiltration patterns (credential fishing, env vars, secrets)
  - ~5 impersonation patterns (authority claims)
  - ~5 XSS patterns
- Redaction: replace matched text with `[REDACTED]`

### 5.2 Modify: `src/config.ts`

Add env var:

```typescript
scrubContent: boolean; // from SCRUB_CONTENT env, default true
```

### 5.3 Modify: `src/tools/semanticCrawl.ts`

In `pagesToCorpus()`, before chunking:

- If `cfg.scrubContent` is true, call `scrubContent(page.markdown)` on each page
- Log any threats detected (count + types)
- Use scrubbed content for chunking

### 5.4 Tests: `test/contentScrubber.test.ts`

- Unit: each threat category detection
- Unit: redaction correctness (pattern replaced, rest preserved)
- Unit: false positive resistance (security docs, code examples)
- Unit: risk score calculation
- Edge: empty content, very long content, nested encoding

---

## Stage 6: Cross-Backend Search Merging

### 6.1 New File: `src/utils/searchMerge.ts`

**Functions**:

- `normalizeUrlForDedup(url: string): string` — strip www, trailing slash, fragments
- `mergeSearchResults(backendResults: Map<string, SearchResult[]>): SearchResult[]`
- `scoreResult(engineAgreement: number, domainAuthority: number, bestPosition: number): number`

**Domain authority table** (~15 entries):

```typescript
const DOMAIN_AUTHORITY: Record<string, number> = {
  'arxiv.org': 0.9,
  'wikipedia.org': 0.9,
  'github.com': 0.8,
  'stackoverflow.com': 0.8,
  'developer.mozilla.org': 0.8,
  'docs.python.org': 0.8,
  'medium.com': 0.5,
  'reddit.com': 0.4,
  // ...
};
```

### 6.2 Modify: `src/tools/webSearch.ts`

- Detect when both backends are healthy (from health checks)
- When both available and `MERGE_SEARCH_BACKENDS` is not explicitly disabled:
  1. Query both backends in parallel (`Promise.all`)
  2. Tag each result with its source engine
  3. Call `mergeSearchResults()`
  4. Return merged, scored, deduplicated results

### 6.3 Modify: `src/types.ts`

Add to search result types:

```typescript
engines?: string[];  // which backends returned this result
```

### 6.4 Tests: `test/searchMerge.test.ts`

- Unit: URL normalization
- Unit: deduplication (same URL from both backends)
- Unit: scoring formula (engine agreement boost, domain authority)
- Integration: mock two backends, verify merge
- Edge: one backend fails, both fail, single backend configured

---

## Stage 7: Code Example Extraction

### 7.1 Modify: `src/chunking.ts`

In `parseSections()` or post-processing:

- Detect fenced code blocks ≥300 chars
- Extract: language (from ` ```lang ` header), surrounding context
- Attach to nearest section's metadata:
  ```typescript
  metadata: {
    codeBlocks?: Array<{
      language: string;
      charOffset: number;
      charLength: number;
    }>;
  }
  ```

### 7.2 Modify: `src/rag/types.ts`

Add code metadata:

```typescript
interface CodeBlockInfo {
  language: string;
  offset: number;
  length: number;
}
```

### 7.3 Tests: `test/codeExtraction.test.ts`

- Unit: code fence detection with language
- Unit: minimum length threshold
- Unit: multiple code blocks in one section
- Edge: unclosed fences, nested fences, inline code

---

## Stage 8: Self-Improvement Tracking

### 8.1 New File: `src/utils/extractionStats.ts`

**Types**:

```typescript
interface ExtractionOutcome {
  url: string;
  domain: string;
  success: boolean;
  strategy: string;
  timestamp: number;
  chars: number;
}
```

**Functions**:

- `recordOutcome(outcome: ExtractionOutcome): void`
- `getDomainStats(days?: number): Map<string, { total: number; successRate: number }>`
- `shouldSkipDomain(domain: string): boolean` — true if success rate < 5% and total > 5
- `prune(maxAgeMs: number): void`

**Storage**: In-memory Map, pruned every 6 hours, max 10k entries

### 8.2 Modify: `src/tools/webCrawl.ts`

After each crawl attempt (baseline, aggressive retry, external recovery):

- Call `recordOutcome()` with result details

### 8.3 Modify: `src/tools/semanticCrawl.ts`

Before crawling each URL:

- Call `shouldSkipDomain()` — if true, skip and log warning

### 8.4 Tests: `test/extractionStats.test.ts`

- Unit: record + retrieve stats
- Unit: skip threshold calculation
- Unit: pruning by age
- Unit: domain aggregation

---

## Migration & Backward Compatibility

All 8 stages are **additive**:

- New parameters default to `false` / disabled
- Existing tool behavior unchanged when new features are not enabled
- No breaking changes to response shapes (new fields are optional)
- No new required environment variables
