# Provider Capability Matrix — Jina, Firecrawl, Diffbot, Serper, Google Grounding

Status: **implemented** for Jina Search, Firecrawl v2 search, and Diffbot Web Search
(`web_search` fanout) and the double-gated Firecrawl scrape fallback (`web_crawl`).
This document's original planning tables below are retained as evidence; where a
verdict row says "Defer" for Diffbot, the approved implementation overrode it —
Diffbot Web Search shipped with the same key-only fanout posture and config-only
health checks (no live probes to billable providers). Serper and Gemini/Vertex
Grounding remain deferred/rejected as argued below. No new tools or actions were
added.

Scope guard: **no new tools or actions**. All integration rides existing `web_search`
(`src/tools/webSearch.ts`) and, for one optional fallback, the existing `web_crawl` path.
**Excluded entirely**: Diffbot KG/Enhance/DQL, Firecrawl `/v2/crawl` (async) and
`/v2/extract` (LLM, +4 cr/page), any vendor async job polling/cancel, any LLM extraction
duplicating local `src/utils/documentExtraction.ts`.

## 0. Implementation notes (what shipped)

- **Search fanout (posture C):** `JINA_API_KEY` / `FIRECRAWL_API_KEY` /
  `DIFFBOT_API_KEY` (env or `config.json`) add the backend to the all-provider
  fanout and fallback order — no separate search flag. Strict safe-search
  excludes all three; `aiSummary` stays Exa/Tavily only.
- **Health:** config-only status for the three (unconfigured/healthy), never a
  live billable probe — automatic or dashboard-triggered. No claim of remote
  verification is made anywhere.
- **Firecrawl scrape fallback:** double-gated behind
  `firecrawl.scrapeFallback.enabled` (default `false`) / `FIRECRAWL_SCRAPE_FALLBACK_ENABLED`
  plus the key. Crawl4AI remains the required primary and registration gate.
  Fallback wraps only the primary client execution after request-phase guards
  passed (SSRF, Sentry, domain trust); it never bypasses request policy, URL
  checks, domain trust, document flow, custom extraction, waitFor, JS, or
  cancellation, and is skipped when those semantics were requested. Multi-page
  crawls degrade to the seed page with a stable warning and accurate counts
  (`totalPages`/`successfulPages` = 1 only for a validated non-empty scrape).
  Adapter hardening per §2: `skipTlsVerification: false`, `storeInCache: false`,
  `maxAge: 0`.
- **Review-pass adjustments (post-implementation fix pass):**
  - Strict safe-search exclusion rationale corrected: Firecrawl v2 search does
    document a boolean `safe` (SafeSearch) parameter; the exclusion from
    `STRICT_SAFE_BACKENDS` is retained pending live strict-equivalence
    verification (Jina/Diffbot have no documented parameter at all).
  - Diffbot adapter now skips results whose `pageUrl` coerces empty, matching
    the Jina/Firecrawl adapters (previously kept as linkless results).
  - `OPTIONAL_CONFIG.web_search` health check and remediation text include the
    three new provider keys (previously only `FEATURE_REQUIREMENTS` was updated).
  - `firecrawl.scrapeFallback.enabled` is validated as a strict boolean on the
    dashboard patch path and coerced fail-closed in `loadConfig` (a string value
    can no longer truthy-open the billable fallback gate).
  - Jina adapter checks the API key before its local cache read; Jina's
    server-side cache retention is documented (no `X-No-Cache` opt-out sent).

## 1. Capability matrix

Evidence: research artifacts `adeef0f6…` (Serper / Gemini / Jina) and `5020fc8c…`
(Diffbot / Firecrawl), both with dated primary-source citations. Firecrawl v2
`/search` and `/v2/scrape` schemas re-verified against docs.firecrawl.dev this pass
(fields quoted in §2). Jina `s.jina.ai` existence re-verified against product docs;
schema per dated artifact.

| Axis                                | Jina Search                                                                   | Firecrawl v2 search                                                                                                 | Firecrawl v2 sync scrape                                                             | Diffbot Web Search                                                                                                    | Diffbot Extract (analyze/article)                    | Serper                        | Gemini/Vertex Grounding                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Official contract                   | Yes (docs.jina.ai, dated)                                                     | Yes (docs.firecrawl.dev)                                                                                            | Yes (docs.firecrawl.dev)                                                             | Yes (diffbot.com/docs, Bearer host `llm.diffbot.com`)                                                                 | Yes (query-param token, `api.diffbot.com/v3`)        | **No** — ToS + marketing only | Yes (Interactions + generateContent + Additional Terms)                                          |
| Endpoint                            | `POST https://s.jina.ai/`                                                     | `POST https://api.firecrawl.dev/v2/search`                                                                          | `POST https://api.firecrawl.dev/v2/scrape`                                           | `GET/POST …/api/v1/web_search`                                                                                        | `GET /v3/analyze?token=&url=`                        | **UNVERIFIED**                | `v1beta/interactions` or `:generateContent`                                                      |
| Auth                                | `Authorization: Bearer $JINA_API_KEY`                                         | `Authorization: Bearer fc-…`                                                                                        | same                                                                                 | `Authorization: Bearer <token>`                                                                                       | `token=` **in query string** (log/Referer leak risk) | header **UNVERIFIED**         | `x-goog-api-key` / ADC                                                                           |
| Result shape                        | `{ code, status, data:[{ title, description, url, content, usage.tokens }] }` | `data.web[] { title, description, url, markdown?, metadata{sourceURL,url,statusCode} }`; `creditsUsed`              | `{ success, data:{ markdown, metadata{title,sourceURL,url,statusCode}, warning? } }` | `{ search_results:[{ score, pageUrl, title, content, date? }] }` — `content` = splice highlight, **not** AI summary   | `{ objects:[{ type, title, pageUrl, html, … }] }`    | **UNVERIFIED schema**         | Generated answer + citations + **mandatory** `searchEntryPoint`/`search_suggestions` HTML widget |
| URL-attributed snippets             | yes (`url` + `description`)                                                   | yes (`url` + `description`/highlight)                                                                               | n/a (single URL)                                                                     | yes (`pageUrl` + `content`)                                                                                           | yes (`pageUrl` + html)                               | claimed                       | citations yes; organic SERP **no**                                                               |
| Strict safe-search                  | **No** documented parameter                                                   | `safe: boolean` — semantics undocumented; **no** strict mapping                                                     | n/a                                                                                  | operators (`site:`,`after:`), no safe-search                                                                          | n/a                                                  | **UNVERIFIED**                | no filter params documented                                                                      |
| Native AI summary                   | none                                                                          | none                                                                                                                | none                                                                                 | none (docs: "Not an AI summary")                                                                                      | none                                                 | claimed                       | yes, but widget-bound (see verdict)                                                              |
| Pagination                          | `num`/`page`                                                                  | `limit`; no page token                                                                                              | n/a                                                                                  | `size` (1–5 `text` values), no cursor                                                                                 | n/a                                                  | **UNVERIFIED**                | n/a (model writes queries)                                                                       |
| Rate / cost (dated)                 | 100 RPM keyed; **≥10,000 tokens per search**; 10M free tokens on new key      | 10/min (free); **2 credits / 10 results**; failed-empty not charged, 403/404 still 1 credit                         | 1 credit/basic page; 10/min free                                                     | **CONFLICT**: docs say 100k free queries/60 QPM; pricing page says 1 credit/search, free 10k credits — **UNRESOLVED** | 1 credit/page; free 10k credits, 5 req/min           | credits, $ UNVERIFIED         | Gemini 3.x: $14/1k after 5k free/mo; per-query billing                                           |
| Vendor fetches attacker-chosen URLs | no (search only)                                                              | yes, `scrapeOptions` — bypasses local SSRF unless pre-checked                                                       | **yes** — vendor fetch of any URL we send                                            | no                                                                                                                    | **yes**                                              | n/a                           | yes                                                                                              |
| Cache/retention flags               | `X-No-Cache` header                                                           | request `storeInCache` default **true**, `maxAge` default 48h; `zeroDataRetention` default false (ZDR = enterprise) | same                                                                                 | opaque vendor cache                                                                                                   | vendor cache "sometimes"; crawl retention 18–32d     | n/a                           | **hard ban**: no caching, no syndication, no link extraction                                     |
| Fit existing surface                | `web_search` fanout                                                           | `web_search` fanout                                                                                                 | `web_crawl` fallback                                                                 | `web_search` fanout (deferred)                                                                                        | `web_crawl` fallback (deferred)                      | **defer**                     | **incompatible — reject**                                                                        |

### Verdicts

| Vendor × surface                              | Verdict                                            | Reason                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jina Search → `web_search`                    | **Implement, opt-in fanout** (bounded first slice) | Clean mapping to `SearchResult`; excerpt-only via `X-Respond-With: no-content`; fixed API URL so `assertSafeUrl` applies; Bearer (no token-in-query)                                                                                                                              |
| Firecrawl v2 search → `web_search`            | **Implement, opt-in fanout, second slice**         | Same shape; **do not set `scrapeOptions`** (full-page markdown fights the excerpt-only per-document budget and multiplies cost)                                                                                                                                                   |
| Firecrawl `/v2/scrape` → `web_crawl` fallback | **Later slice, double-gated**                      | Sync, markdown-native, matches RAG corpus; must be a separate paid-fallback flag (see §3)                                                                                                                                                                                         |
| Diffbot Web Search → `web_search`             | **Defer**                                          | Unresolved billing conflict (§2); English-only; distinct auth host from Extract                                                                                                                                                                                                   |
| Diffbot Extract → `web_crawl` fallback        | **Defer**                                          | Token in query string (log-leak), HTML→markdown conversion burden, schema mismatch vs Firecrawl markdown                                                                                                                                                                          |
| Serper                                        | **Defer pending official contract**                | No crawlable official API spec; third-party clients are not primary evidence. Unblock path: operator-supplied logged-in Playground/Dashboard curl captured into a doc; only then add a backend                                                                                    |
| Gemini/Vertex Grounding                       | **Rejected**                                       | Additional Terms require rendering the Search Suggestions widget to the prompting end-user, forbid caching/syndication, forbid using links to seed crawls. MCP markdown results cannot satisfy the display duty; `aiSummary` path stays Exa/Tavily only. Not fusion, not fallback |

## 2. Verified request contracts (for the two implementable vendors)

### Jina Search — `POST https://s.jina.ai/`

- Headers: `Authorization: Bearer <JINA_API_KEY>`, `Accept: application/json`,
  `X-Respond-With: no-content` (**mandatory in excerpt-only mode** — without it the
  default fetches full top-result pages through the reader stack: latency + token cost).
- Body: `{ q, num, page?, gl?, hl?, location? }`.
- Response: `data[].url` (dedupe key), `title`, `description` (snippet),
  `content` (full body — **ignored in excerpt-only mode**; do not map).
- EU host `eu.s.jina.ai` exists; single fixed default host, `assertSafeUrl`-eligible.
- Rate/cost: 100 RPM keyed; each search ≥10k tokens.

### Firecrawl v2 — search then optional scrape fallback

Search `POST https://api.firecrawl.dev/v2/search`, `Authorization: Bearer <FIRECRAWL_API_KEY>`,
JSON body verified this pass:
`query` (required), `limit` (default 10), `sources: ["web"]`, `includeDomains`,
`excludeDomains`, `tbs`, `location`, `country`, `safe`, `timeout` (default 60000),
`ignoreInvalidURLs`, `highlights` (**default true**), `scrapeOptions` (do not send),
`enterprise` (ZDR tiers), `threatProtection`. Response: `success`,
`data.web[] { title, description, url, markdown?, metadata{ sourceURL, url, statusCode } }`,
`creditsUsed`; errors 408/500 documented.

Scrape `POST https://api.firecrawl.dev/v2/scrape` — defaults verified this pass and
**must be overridden** by the adapter:

| Field                 | Vendor default  | Our adapter sends       | Why                                                                                      |
| --------------------- | --------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `formats`             | `["markdown"]`  | `["markdown"]`          | matches RAG corpus                                                                       |
| `onlyMainContent`     | true            | true                    | deterministic HTML filter, no LLM                                                        |
| `skipTlsVerification` | **true**        | **false**               | vendor-default MITM on fetch path; never silently accept                                 |
| `storeInCache`        | **true**        | **false**               | avoids operator content persisting at vendor cache by default (operator can opt back in) |
| `maxAge`              | 172800000 (48h) | 0                       | fresh fetch semantics for a fallback; avoids serving 48h-old vendor-cached copies        |
| `zeroDataRetention`   | false           | false                   | ZDR is enterprise-gated; document, do not send                                           |
| `proxy`               | `auto`          | omit                    | default behavior                                                                         |
| `timeout`             | 60000           | adapter constant (≤30s) | local tool budget                                                                        |

Fallback seam: Crawl4AI failure path (`src/crawl/index.ts`, `src/crawl/pipeline.ts`,
external recovery in `src/utils/externalRecovery.ts` where Wayback/Google-Cache
already sit). Firecrawl scrape slots alongside external recovery as a **last** resort,
after `assertSafeUrl(targetUrl)` pre-check — the vendor fetches the target on its own
infrastructure, so the local SSRF guard must run **before** the URL leaves this process.

## 3. Opt-in config semantics — recommended decision (parent approval required)

Three viable postures for "new key present":

- **A. Key-only (existing fanout convention).** `JINA_API_KEY`/`FIRECRAWL_API_KEY`
  non-empty → backend joins the all-provider fanout, exactly like
  Brave/Exa/Tavily today (`loadFromEnv` sets `searchBackend ??=`; `backendAvailable`
  checks key presence). Zero new config surface; consistent with every keyed backend.
- **B. Key + `enabled` flag** (default false). Explicit opt-in; protects operators who
  mint a key for one purpose (e.g. Firecrawl fallback only) from surprise search spend.
- **C. Key + separate paid-fallback flag only.** Search fanout key-only; the
  _scrape fallback_ additionally requires an explicit flag.

**Recommendation: C.** Key-only search-fanout join (preserves the codebase's uniform
"keyed = included" convention, smallest diff through
`SearchBackend`/`FALLBACK_ORDER`/`resolveBackends`), **plus** a separate
`firecrawl.scrapeFallback.enabled` boolean (default `false`) required on top of the key
for the billable `web_crawl` fallback. Note that `FIRECRAWL_API_KEY` enables billable Firecrawl search fanout independently of `scrapeFallback.enabled`. Leaving `scrapeFallback.enabled` unset only disables the additional crawl fallback and does not suppress search spending; if parent prefers symmetric
explicitness, option B is the approved alternative (adds `enabled` booleans to
`jina`/`firecrawl` config blocks, `backendAvailable`, health checks).

### Decisions the parent must approve (cost/compatibility)

1. **Posture A/B/C** above (recommended: C).
2. **Health probes bill paid providers.** `probeSearchBackend` sends a live
   `'health check'` query to every configured keyed backend (`src/health.ts`).
   For Jina that is ~10k tokens per probe; for Firecrawl 2 credits per probe.
   Recommend: config-only health status for `jina`/`firecrawl`
   (`unconfigured`/`healthy` without network probe), diverging from the Exa/Brave
   probe pattern. Alternative: probe like the others and accept the cost.
3. **Query expansion multiplies billable calls.** `searchWithBackends` runs every
   query variation through every backend (`queries.length × backends`). Jina/Firecrawl
   calls inherit this (≈2–3× spend). Options: accept (consistent), or cap expansion
   for paid backends (new behavior change).
4. **Firecrawl scrape fallback hardening flags** (§2 table: `skipTlsVerification:false`,
   `storeInCache:false`, `maxAge:0`). Diverging from vendor defaults costs some speed;
   sending vendor defaults is a security/retention regression. Recommended as written.
5. **Jina `content` field unused.** Excerpt-only contract; full-content mode is
   future opt-in only (`X-Return-Format`), not in any slice.
6. **`searchBackend` enum growth.** `jina`/`firecrawl` become valid `SEARCH_BACKEND`
   fallback-order values (5 places: `VALID_BACKENDS`, `VALID_SEARCH_BACKENDS`,
   `FALLBACK_ORDER`, health `webSearchBackendRemediation`, dashboard validation).
   No default changes; `codex` stays the default primary.

Constraints honored: new credentials ship **empty/unconfigured** (empty string defaults,
same as `brave.apiKey: ''`); empty key ⇒ backend absent from fanout ⇒ **zero billable
calls**; health probes per decision #2; no paid requests during implementation (tests
are hermetic with injected fetch).

## 4. Exact owned files — first bounded implementation slice

**Slice 1 (recommended first implementation): Jina Search backend only.**
Smallest seam: one adapter, one new `SearchBackend` value, no crawl-path changes.

| File                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/jinaSearch.ts`                                          | **new.** Pattern copy of `src/tools/tavilySearch.ts`: `ToolCache` (`cacheKey('jina', q, limit, safeSearch, aiSummary)`), `assertSafeUrl(JINA_API_URL)`, `retryWithBackoff`, `AbortSignal.timeout` constant (30s), `unavailableError('…Set JINA_API_KEY.')`, map `data[]` → `SearchResult { title, url, description, source: 'jina', contentKind }`; **always** send `X-Respond-With: no-content`; never log response bodies or headers |
| `src/config.ts`                                                    | `JinaConfig { apiKey?: string }`; `SearchConfig.jina`; `SearchBackend` union + `VALID_BACKENDS` + `'jina'` in `EnvConfig`; `loadFromEnv`: `JINA_API_KEY` → `cfg.jina` (+ `searchBackend ??=`); `DEFAULTS.jina = { apiKey: '' }`; merge line in `loadConfig`                                                                                                                                                                            |
| `src/config/types.ts`                                              | `MUTABLE_CONFIG_KEYS` += `'jina'`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/config/manager.ts`                                            | `SECRET_LEAF_PATHS` += `'jina.apiKey'`; `VALID_SEARCH_BACKENDS` += `'jina'`                                                                                                                                                                                                                                                                                                                                                            |
| `src/tools/webSearch.ts`                                           | `FALLBACK_ORDER` += `'jina'` (after `tavily`); `runBackend` switch case + `WebSearchDeps.jinaSearch`; `backendAvailable` case (`(cfg.jina.apiKey ?? '').length > 0`). **No** `STRICT_SAFE_BACKENDS` entry; **no** `onlyModeScope` change (`['exa','tavily']` untouched)                                                                                                                                                                |
| `src/health.ts`                                                    | `searchBackendConfigured` case; `probeSearchBackend` case per decision #2 (config-only); `webSearchBackendRemediation` case (`Set JINA_API_KEY or select another SEARCH_BACKEND.`); `OPTIONAL_CONFIG.web_search.check` += jina key; `FEATURE_REQUIREMENTS.web_search_keyed_backends` required-string += `JINA_API_KEY`                                                                                                                 |
| `config.example.json`                                              | `"jina": { "apiKey": "" }` — plain object, **no `//` comment keys** (existing `//` keys are pre-existing tolerated unknowns; this slice adds none)                                                                                                                                                                                                                                                                                     |
| `dashboard/src/pages/Providers.tsx`, `dashboard/src/api/client.ts` | provider card + field for `jina.apiKey` (masked via `getRedacted()`); second-slice concern if dashboard churn is heavy — flag to parent                                                                                                                                                                                                                                                                                                |

Slice 2: Firecrawl search adapter (`src/tools/firecrawlSearch.ts`) with the same seam.
Slice 3: Firecrawl sync scrape fallback behind `firecrawl.scrapeFallback.enabled` with
`assertSafeUrl` pre-check; touches `src/crawl/` failure path only.
Deferred slices: Diffbot (billing conflict), Serper (no official contract).

**Shared-config writer constraint:** all config-block additions flow through the
serialized writer `ConfigManager.persistEncryptedConfig` (atomic tmp+rename,
`resetConfig()` cache invalidation, `deepMergePreferNonEmpty` so empty placeholders
never erase live values). No direct `config.json`/`config.enc` edits anywhere in the
plan; tests cover env/file/dashboard-patch parity (`test/config/manager.test.ts`
pattern) so the fingerprint-sensitive merge semantics are exercised, not assumed.

## 5. Failing tests to write first (TDD, `test/` — node:test, compiled via `tsconfig.test.json`)

1. `test/jinaSearch.test.ts`
   - maps `data[]` → `SearchResult` (title/url/description, `source:'jina'`);
   - **always** sends `X-Respond-With: no-content` + `Accept: application/json` + Bearer header (assert injected fetch init);
   - empty key → `unavailableError` (no fetch issued — zero billable calls);
   - 401/402/429/5xx → `ToolError` codes matching `runBackend` classification
     (`RATE_LIMIT`/`UNAVAILABLE`/`TIMEOUT`), error payloads **never** logged;
   - abort/timeout path → `TIMEOUT` classification;
   - response body echoing the query is not present in log output (redaction test).
2. `test/webSearchJina.test.ts` (fanout integration, injected deps + `config:` override)
   - **provenance**: `source:'jina'` survives `restoreRrfProvenance`/`mergeDedupProvenance`; `engines` unions with other discoverers; `usedBackend`/`servedBackends` include `'jina'`;
   - **dedupe**: same normalized URL from jina + another backend keeps richest representation, `source` = provider of chosen content (existing `richerThan` semantics — jina description is snippet-class);
   - **strict-safe exclusion**: `safeSearch:'strict'` filters `'jina'` out of scope; with only jina configured → `validationError` naming supported backends (never silently downgraded);
   - **aiSummary**: `no` (default) — no `generatedSummary` from jina; `yes` — jina results carry none, Exa summary survives same-URL merge; `only` — scope stays `['exa','tavily']`, jina excluded, unconfigured exa+tavily → existing `validationError` text;
   - **limits**: `limit` clamped/forwarded to `num`; multi-variation expansion multiplies calls (assert count) — pins decision #3.
3. `test/config/providerMatrix.test.ts`
   - `JINA_API_KEY` env → `loadConfig().jina.apiKey` (+ fallback-order effect); file `config.json` `jina.apiKey`; env-over-file precedence; empty-string key = unconfigured;
   - dashboard patch `jina.apiKey` via `ConfigManager.update` (`MUTABLE_CONFIG_KEYS`) persists encrypted + `getRedacted()` masks to `•••`; unknown-key patch rejected;
   - `searchBackend: 'jina'` accepted by `validateConfigValues`;
   - `config.example.json` parses as strict JSON (`JSON.parse`, no exception) and contains `jina.apiKey: ""`.
4. `test/healthCheck.test.ts` (extend)
   - unconfigured jina → `web_search.jina` status `unconfigured` + remediation string;
   - configured jina → config-only `healthy` (no network call asserted) per decision #2;
   - `orderedSearchBackends` includes `'jina'` in fallback order.

## 6. Validation commands (run after slice 1)

```bash
npm run typecheck                 # tsc --noEmit (root + tsconfig.test.json)
npm run lint                      # eslint src
node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8')); console.log('valid')"
npm test -- test/jinaSearch.test.ts
npm test -- test/webSearchJina.test.ts
npm test -- test/config/providerMatrix.test.ts
npm test -- test/healthCheck.test.ts
npm test                          # full suite — no regressions in webSearch.* / config.*
npm run format:check
```

## 7. Residual risks

- Jina response schema is from dated official docs (this pass re-confirmed product
  surface, not the full JSON schema); re-verify `data[]` field names at implementation
  with a live key before merging. `page` base index (0 vs 1) unverified.
- Jina legal posture: Elastic-acquired (legal page warns T&Cs may lag); third-party
  material IP stays with the source — standard operator-risk note, same as Brave/Exa.
- Firecrawl ToS has weak third-party-content redisplay license — operator risk, unchanged
  from research artifact.
- Firecrawl `highlights` response field (separate array vs folded into `description`)
  unresolved — adapter maps `description` only until confirmed.
- Diffbot billing conflict unresolved → both Diffbot surfaces stay deferred.
- Serper blocked on a human-supplied official contract capture.
- `SEARCH_MCP_CONFIG_KEY` boot posture: the research/scout suggestion to boot with a
  secret-logging command was **not adopted**. The planning tables claim no new
  `//` comment keys in `config.example.json`; the shipped diff **overrides** that
  for the three new provider blocks, which carry `//` billable-cost warning keys
  (same tolerated pre-existing pattern as the older `//` keys).
