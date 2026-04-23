# Design: Structured Data Extraction for Crawl4AI

**Date:** 2026-04-23
**Status:** Draft — awaiting review

## Problem

Crawl4AI outputs clean Markdown with embedded links, which works well for reading but is fragile for automation. When a page has multiple `<a>` tags per logical item (e.g., a job card with one link on the title and another on a secondary element), the Markdown rendering does not guarantee adjacency. The `href` extracted from the raw Markdown may not belong to the text block the caller is reading, causing link-to-description misalignment.

## Goal

Add an optional `extractionConfig` parameter to `web_crawl`, `web_read`, and `semantic_crawl` that forwards structured extraction instructions to the Crawl4AI sidecar. This lets callers define CSS selectors, XPath expressions, regex patterns, or natural language instructions for deterministic structured data extraction alongside the existing Markdown output.

## Non-Goals

- Replace or remove the existing Markdown output. `extractedData` is additive only.
- Implement server-side extraction logic. We delegate to the Crawl4AI sidecar.
- Add array-of-configs support (multiple simultaneous strategies). Single config for the initial release; arrays can be added later without breaking the schema.
- Accept `extractionConfig` as either a single config or an array from day one (`z.union([configSchema, z.array(configSchema)])`). This avoids a future type-level breaking change when arrays are enabled.

## Architecture

### 1. Schema Extension

Add `extractionConfig` as an optional parameter to `web_crawl`, `web_read`, and `semantic_crawl`.

```ts
type ExtractionConfig =
  | { type: 'css_schema'; schema: Record<string, unknown> }
  | { type: 'xpath_schema'; schema: Record<string, unknown> }
  | {
      type: 'regex';
      patterns?: Array<
        | 'email' | 'phone-international' | 'phone-us' | 'url' | 'ipv4' | 'ipv6'
        | 'uuid' | 'currency' | 'percentage' | 'number' | 'date-iso' | 'date-us'
        | 'time-24h' | 'postal-us' | 'postal-uk' | 'hex-color' | 'twitter-handle'
        | 'hashtag' | 'mac-address' | 'iban' | 'credit-card' | 'all'
      >;
      customPatterns?: Record<string, string>; // { label: regexString }
    }
  | {
      type: 'llm';
      instruction: string;           // natural language extraction instruction
      outputSchema?: Record<string, unknown>; // optional JSON Schema / Pydantic shape
      llmProvider?: string;        // e.g. "openai/gpt-4o" (overrides server-side config)
    };

extractionConfig?: ExtractionConfig | ExtractionConfig[];
```

**Validation rules (server-side):**
- `schema` is required when `type` is `css_schema` or `xpath_schema`. Must have `baseSelector` (string) and `fields` (array).
- At least one of `patterns` or `customPatterns` is required when `type` is `regex`.
- `instruction` is required when `type` is `llm`.
- `llmProvider` is optional. If omitted, the server falls back to a new `llm` section in the config. If neither is available, return `VALIDATION_ERROR`.
- `llmApiToken` is **not accepted as a tool parameter** for security reasons (tokens would appear in tool_use blocks, conversation logs, and traces). The API token is loaded exclusively from server-side config (`LLM_API_TOKEN` env var or encrypted config).
- Unknown `patterns` enum values are rejected at validation time.

**Zod schema sketch (Zod v4):**

```ts
const singleExtractionConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('css_schema'),
    schema: z.object({
      name: z.string(),
      baseSelector: z.string(),
      fields: z.array(z.record(z.unknown())),
    }),
  }),
  z.object({
    type: z.literal('xpath_schema'),
    schema: z.object({
      name: z.string(),
      baseSelector: z.string(),
      fields: z.array(z.record(z.unknown())),
    }),
  }),
  z.object({
    type: z.literal('regex'),
    patterns: z.array(z.enum([...])).optional(),
    customPatterns: z.record(z.string()).optional(),
  }).refine((v) => v.patterns?.length || Object.keys(v.customPatterns ?? {}).length),
  z.object({
    type: z.literal('llm'),
    instruction: z.string().min(1),
    outputSchema: z.record(z.unknown()).optional(),
    llmProvider: z.string().optional(),
  }),
]);

const extractionConfigSchema = z.union([
  singleExtractionConfigSchema,
  z.array(singleExtractionConfigSchema),
]);
```

### 2. Crawl4AI Payload Mapping

The existing `webCrawl` function constructs a JSON-RPC-like payload for the Crawl4AI `/crawl` endpoint. We add `extraction_config` as a new top-level field in the request body:

```ts
const body = {
  urls: [url],
  browser_config: { type: 'BrowserConfig', params: { headless: true } },
  crawler_config: { type: 'CrawlerRunConfig', params: crawlerConfigParams },
  // NEW: optional extraction_config at the top level of the body
  ...(extractionConfig ? { extraction_config: mapToCrawl4ai(extractionConfig) } : {}),
};
```

**Mapping table:**

| Our type | Crawl4AI class | Body shape |
|----------|----------------|------------|
| `css_schema` | `JsonCssExtractionStrategy` | `{ type: 'JsonCssExtractionStrategy', params: { schema } }` |
| `xpath_schema` | `JsonXPathExtractionStrategy` | `{ type: 'JsonXPathExtractionStrategy', params: { schema } }` |
| `regex` | `RegexExtractionStrategy` | `{ type: 'RegexExtractionStrategy', params: { pattern: bitflags, custom: customPatterns } }` |
| `llm` | `LLMExtractionStrategy` | `{ type: 'LLMExtractionStrategy', params: { instruction, schema: outputSchema, llm_config: { provider: llmProvider ?? cfg.llm.provider, api_token: cfg.llm.apiToken } } }` |

**Regex bitflag mapping note:** The Crawl4AI `RegexExtractionStrategy` uses Python `IntFlag` attributes. Our string enum values must map to the corresponding bitflag integers. This mapping requires reading Crawl4AI's source or documentation for the exact integer values. The mapping lives in `utils/extractionConfig.ts`.

### 3. Response Shape

Extend `CrawlPageResult` with an optional `extractedData` field:

```ts
interface CrawlPageResult {
  url: string;
  success: boolean;
  markdown: string;
  title: string | null;
  description: string | null;
  links: Array<{ href: string; text: string }>;
  statusCode: number | null;
  errorMessage: string | null;
  extractedData?: Record<string, unknown>[]; // NEW
}
```

**Rules:**
- `markdown` is always the full page content. Never replaced or truncated by extraction.
- `extractedData` is present only when `extractionConfig` was supplied and extraction succeeded.
- On extraction failure (malformed schema, no matches, LLM error), `extractedData` is omitted and a warning is added to `meta.warnings`.
- The value is the parsed JSON returned by Crawl4AI in `result.extracted_content`. If Crawl4AI returns a single object, it is wrapped into a single-element array. If it returns an array, it is used directly.

**Per-strategy output shapes:**
- `css_schema` / `xpath_schema`: Array of objects whose keys match the `name` fields in the schema's `fields` array. Values are strings (or nulls for missing fields with no default).
- `regex`: Array of `{ url: string, label: string, value: string, span: [number, number] }`.
- `llm`: Array of objects shaped by `outputSchema` if provided, otherwise unstructured objects. Crawl4AI returns the parsed JSON directly.

### 4. Config Changes

Add a new optional `llm` section to `SearchConfig`:

```ts
export interface LlmConfig {
  provider: string;   // e.g. "openai/gpt-4o"
  apiToken: string;
}

export interface SearchConfig {
  // ... existing fields ...
  llm: LlmConfig;
}

const DEFAULTS: Omit<SearchConfig, 'rescoreWeights'> = {
  // ... existing defaults ...
  llm: { provider: '', apiToken: '' },
};
```

Environment variable resolution:
- `LLM_PROVIDER` -> `cfg.llm.provider`
- `LLM_API_TOKEN` -> `cfg.llm.apiToken`

### 5. Integration with `semanticCrawl`

`semanticCrawl` accepts `extractionConfig` in its tool input and forwards it to `webCrawl`. `extractedData` from each crawled page is preserved on the `CrawlPageResult` and exposed in the final `SemanticCrawlResult` chunks.

**Important:** `extractedData` is **not merged into chunk text** for embedding. Semantic search operates on prose chunks only. Blending structured JSON records into prose embeddings produces incoherent vectors that degrade search quality. Callers who need to search structured data should use `web_crawl` directly and operate on `extractedData`, or post-process `semantic_crawl` results by filtering/joining against the structured sidecar.

When `source.type === 'cached'`, `extractionConfig` is silently ignored with a warning (cached sources skip crawling).

### 6. Error Handling

| Failure mode | Behavior |
|--------------|----------|
| `extractionConfig` fails validation | `VALIDATION_ERROR` before any network call |
| Crawl4AI returns extraction error | Page `success: true`, `markdown` present, `extractedData` omitted, warning in `meta.warnings` |
| LLM credentials missing | `VALIDATION_ERROR` at call time |
| Crawl4AI sidecar is v0.7.x without extraction support | `parseError` with remediation hint (upgrade sidecar to v0.8.x) |
| `semantic_crawl` with `source: 'cached'` receives `extractionConfig` | `extractionConfig` is silently ignored with a warning in `meta.warnings` (cached sources skip crawling) |

### 7. Cache Key Invalidation

`webCrawl` uses an in-memory LRU cache (`ToolCache`). The cache key must include a deterministic fingerprint of `extractionConfig` so that the same URL with different extraction configs produces different cache entries.

```ts
const extractionFingerprint = extractionConfig
  ? createHash('sha256').update(JSON.stringify(extractionConfig)).digest('hex').slice(0, 16)
  : 'none';
const key = cacheKey('web-crawl', url, extractionFingerprint, JSON.stringify(opts));
```

If `extractionConfig` changes in any way (different schema, different instruction, different patterns), the cache key changes. This prevents stale results when callers iterate on extraction schemas.

### 8. Health Check

The health probe for `web_crawl` tests extraction against a small synthetic HTML fixture with a known CSS schema (e.g. extracting `{ title, price }` from a simple product card). A regex probe on `example.com` is unreliable because the page may contain zero matches, making it impossible to distinguish "extraction works" from "extraction is broken." The synthetic fixture guarantees a known-positive result.

If the sidecar returns an error indicating unsupported extraction, mark the tool as `degraded` with remediation: `Upgrade Crawl4AI sidecar to v0.8.x or later for extraction support`.

### 9. LLM Extraction Timeouts

LLM extraction can take 5-30 seconds depending on page size and provider. It shares the same 120-second request timeout as the crawl itself. Callers using `type: 'llm'` should set `maxPages: 1` to avoid timeout. If LLM extraction exceeds the timeout, the crawl fails with a network error — there is no partial extraction fallback.

## Example Usage

### Example A: CSS schema for job listings

```json
{
  "url": "https://www.seek.com.au/jobs",
  "strategy": "bfs",
  "maxDepth": 1,
  "maxPages": 1,
  "extractionConfig": {
    "type": "css_schema",
    "schema": {
      "name": "Job Listings",
      "baseSelector": "article[data-automation='jobCard']",
      "fields": [
        { "name": "title", "selector": "a[data-automation='jobTitle']", "type": "text" },
        { "name": "url", "selector": "a[data-automation='jobTitle']", "type": "attribute", "attribute": "href" },
        { "name": "company", "selector": "[data-automation='jobCompany']", "type": "text" },
        { "name": "location", "selector": "[data-automation='jobLocation']", "type": "text" },
        { "name": "salary", "selector": "[data-automation='jobSalary']", "type": "text", "default": "" }
      ]
    }
  }
}
```

### Example B: LLM extraction without knowing DOM structure

```json
{
  "url": "https://www.seek.com.au/jobs",
  "maxDepth": 1,
  "maxPages": 1,
  "extractionConfig": {
    "type": "llm",
    "instruction": "Extract all job listings from this page. For each listing, provide: job title, company name, location, salary range, and the link URL.",
    "outputSchema": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "company": { "type": "string" },
        "location": { "type": "string" },
        "salary": { "type": "string" },
        "url": { "type": "string" }
      }
    }
  }
}
```

### Example C: Regex for email extraction

```json
{
  "url": "https://example.com/contact",
  "maxDepth": 1,
  "maxPages": 1,
  "extractionConfig": {
    "type": "regex",
    "patterns": ["email", "url"]
  }
}
```

## Open Questions

1. ~~Should `web_read` support `extractionConfig`?~~ **Resolved: Yes.** `web_read` already wraps `webCrawl` when Crawl4AI is configured. Forwarding `extractionConfig` is trivial. A deprecation notice remains in the tool description.
2. **Regex bitflag research needed.** Crawl4AI's `RegexExtractionStrategy` uses Python `IntFlag` attributes (e.g. `RegexExtractionStrategy.Email = 1`, `RegexExtractionStrategy.Url = 2`, etc.). The exact integer values must be determined from Crawl4AI source or documentation before implementation. The mapping lives in `src/utils/extractionConfig.ts`.
3. Do we need to expose Crawl4AI's `verbose` flag for extraction debugging? Probably not for the MVP; callers can inspect `meta.warnings`.

## Implementation Plan

1. Add `llm` config section to `config.ts` + env var loading.
2. Add `extractionConfig` to `WebCrawlOptions` in `webCrawl.ts`.
3. Implement `mapToCrawl4ai()` in a new `utils/extractionConfig.ts`.
4. Extend `CrawlPageResult` in `types.ts` with `extractedData`.
5. Update `normalizePage()` in `webCrawl.ts` to parse `extracted_content` into `extractedData`.
6. Register `extractionConfig` in `server.ts` for `web_crawl`, `web_read`, and `semantic_crawl`.
7. Forward `extractionConfig` through `semanticCrawl` to `webCrawl`.
8. Pass `extractedData` through to `SemanticCrawlResult` as a sidecar field. Do not merge into chunk text.
9. Add health probe for extraction capability.
10. Write tests.

## Migration Notes

- Zero breaking changes. All new fields are optional.
- Callers who do not pass `extractionConfig` see identical behavior.
- The Crawl4AI sidecar must be v0.8.x or later for extraction support. v0.7.x sidecars will return a parse error with a remediation hint.
