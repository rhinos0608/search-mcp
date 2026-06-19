# Architecture audit

## 1. High — availability semantics split across composition root, health, and family registry

**Refs**: `src/server.ts:52-86`, `src/tools/registry.ts:253-260`, `src/health.ts:49-78`, `src/health.ts:156-234`, `src/tools/families/github.ts:530-535`

**Design rationale**: family consolidation deepens tool discovery Interface: one family Module stays registered, unavailable action returns actionable error. Standalone tools still use composition-root gating, while family actions use runtime `configIssue`. Worse, `github.search` treats missing token as unavailable even comment says token only improves rate limits. Same config fact now has three Interfaces. Locality low; adding dependency means editing tool Module, health Module, and server Module.

**Smallest safe fix**: add availability kind to family action capability: `required | degraded | optional`. `configIssue` only blocks `required`; degraded issue appears in health/warnings but call still runs. Apply first to `github.search`. Then make standalone tools use same availability Module instead of `GATED_TOOLS` in server.

**Do now/defer**: **Do now**. This is user-visible and blocks degraded-but-valid adapters.

---

## 2. High — `webSearch` bypasses passed config, weakening test seam

**Refs**: `src/tools/standalone/webSearch.ts:19-23`, `src/tools/webSearch.ts:2`, `src/tools/webSearch.ts:32-34`, `src/tools/webSearch.ts:93-117`, `src/tools/webSearch.ts:189-205`

**Design rationale**: registration Module receives `cfg`, but search Implementation calls `loadConfig()` internally. Interface says caller can supply config; actual seam is global singleton. Tests must mutate env/cache instead of passing adapters. Deletion test: deleting config parameter from `registerWebSearch` would not break search behavior, so current seam is shallow.

**Smallest safe fix**: introduce `WebSearchRuntime` Module: `{ config, deps }`. Keep `webSearch()` convenience adapter using `loadConfig()`, but make `searchWithBackends(runtime, ...)` pure over injected config/deps. Registration passes `cfg` through.

**Do now/defer**: **Do now** before more backend or availability work.

---

## 3. High — page acquisition duplicated across read/crawl/browser/agentic browse/research

**Refs**: `src/tools/webRead.ts:71-113`, `src/tools/webCrawl.ts:78-116`, `src/tools/families/agenticBrowse.ts:47-75`, `src/tools/families/agenticBrowse.ts:80-109`, `src/tools/families/agenticBrowse.ts:226-278`, `src/tools/fetchFocus.ts:27-40`, `src/research/researchTools.ts:73-104`, `src/tools/families/browser.ts:562-565`

**Design rationale**: same domain concept — page acquisition and extraction — appears as several shallow Modules: Readability fetch, Crawl4AI crawl, Browser navigation, agentic browse read, focused fetch. Each exposes slightly different Interface: timeout, headers, SSRF, truncation, extraction method, fallback. Bugs in fetching or extraction policy spread across callers. One adapter exists per path, but no shared seam; two adapters already prove real seam.

**Smallest safe fix**: create `PageAcquisition` Module with small Interface: `acquire(url, mode, options) -> PageContent`. Put `ReadabilityAdapter`, `Crawl4AIAdapter`, `BrowserAdapter`, `RagaAdapter` behind seam. Move SSRF, timeout, headers, truncation, extraction metadata into this Module. Migrate `agentic_browse.read` first, then research `webRead/webCrawl` facade.

**Do now/defer**: **Do now** if any fetch/read/crawl/browser feature planned. Otherwise defer one sprint.

---

## 4. Medium — browser family deepens discovery but creates shallow implementation locality

**Refs**: `src/tools/families/browser.ts:45-195`, `src/tools/families/browser.ts:377-389`, `src/tools/families/browser.ts:402-533`, `src/tools/families/browser.ts:537-549`, `src/tools/families/browser.ts:650-968`, `src/tools/families/browser.ts:1027-1661`

**Design rationale**: recent family consolidation improves caller Interface: one `browser` Module, action discriminator, fewer tools. But Implementation now mixes schemas, session policy, LLM planning, network interception, storage, tabs, downloads, DOM diff, and action handlers in one file. AI-navigability suffers; changing session behavior requires scanning unrelated action code. Depth at external Interface increased, but internal locality decreased.

**Smallest safe fix**: keep public `browser` Interface unchanged. Split action definitions behind seam: `browser/family/actions/*.ts` exporting `FamilyAction`s, plus `browser/family/sessionAdapter.ts` for `withSession/getOrCreateSession`. Registry still receives one `browserFamily` array.

**Do now/defer**: **Defer** until next browser change; do before adding another browser action.

---

## 5. Medium — registry Module hides cross-cutting behavior not declared in action Interface

**Refs**: `src/tools/registry.ts:91-121`, `src/tools/registry.ts:290-348`, `src/tools/registry.ts:350-389`

**Design rationale**: `registerFamily` gives leverage by centralizing validation, response wrapping, stats, KG capture. But action Interface does not say results may be intent-filtered, output-schema-validated only as warning, or passively captured. This makes registry a deep Module with secret Interface. Handler tests can pass while production output is mutated by registry pipeline.

**Smallest safe fix**: name pipeline explicitly: `FamilyResultPipeline` Module. Add `pipeline?: { intentFilter?: boolean; kgCapture?: boolean; outputSchema?: ... }` to family/action Interface, defaulting to current behavior. Unit-test pipeline separately; action tests stay pure.

**Do now/defer**: **Defer** unless debugging output mismatch or KG capture; otherwise do with next registry change.

---

## 6. Medium — server composition root knows too much per tool

**Refs**: `src/server.ts:14-41`, `src/server.ts:52-59`, `src/server.ts:66-100`, `src/server.ts:102-108`

**Design rationale**: composition root should wire Modules, but now carries tool catalog, gating policy, KG hook exceptions, and registration order. Adding one tool requires edits in server, health, maybe docs. Interface between tools and composition is shallow: each register function slightly different (`kgHook`, gated, non-KG browser). Locality poor.

**Smallest safe fix**: introduce `ToolCatalog` Module: entries include `name`, `register`, `availability`, `capturePolicy`. `server.ts` initializes KG then iterates catalog. Browser sets `capturePolicy: none`; standalone/family difference becomes implementation detail behind catalog adapter.

**Do now/defer**: **Do now** after availability fix; this is same seam.

---

## 7. Medium — deep research tool facade preserves old tool names and swallows error modes

**Refs**: `src/research/researchTools.ts:44-51`, `src/research/researchTools.ts:55-104`, `src/research/workerAgent.ts:856-862`

**Design rationale**: `ResearchTools` is meant as a deep Module for worker agents, but Interface erases error modes into empty arrays/blank markdown and still reports pre-family names (`reddit_search`, `academic_search`, `web_read`). Recent family consolidation changed public domain language, but research kept older names. Caller loses leverage: cannot tell “no results” from “adapter unavailable.” Locality poor for retries and health-aware planning.

**Smallest safe fix**: return `ToolOutcome<T> = { ok, data, degradedReason?, adapter }` from `ResearchTools`. Align adapter names to family actions (`research.academic`, `reddit.search`, `page.read`). Keep convenience methods that unwrap for old callers during transition.

**Do now/defer**: **Defer** unless working deep research reliability; then do now.

---

## 8. Medium — test architecture observes private server internals and masks outbound fetch mistakes

**Refs**: `scripts/run-tests.cjs:64-111`, `test/setup.ts:16-27`, `test/familyConsolidation.test.ts:54-59`, `test/familyConsolidation.test.ts:74-84`

**Design rationale**: tests reach into `_registeredTools` and global setup replaces fetch with successful `{}` response. Interface under test is private SDK shape plus permissive fake network, not project seam. This makes availability and family consolidation regressions easy to miss: malformed HTTP can look like empty success, and registration tests couple to SDK internals.

**Smallest safe fix**: expose test-only `describeToolCatalog(server)` or better test `ToolCatalog` before SDK registration. Change global fetch mock to throw by default; tests needing degraded network should install explicit `Response('{}')` adapter.

**Do now/defer**: **Do now** with availability fixes; otherwise false confidence.

---

## 9. Low — docs/health still describe removed `web_read` and nonexistent web_crawl Readability fallback

**Refs**: `docs/architecture.md:101-105`, `src/server.ts:14-21`, `src/health.ts:704-709`, `src/tools/standalone/webCrawl.ts:156-168`, `src/tools/webCrawl.ts:86-90`

**Design rationale**: `webRead` remains internal to research, but no standalone `web_read` is registered. Health says web_crawl failure still has Readability fallback, yet `web_crawl` is gated on Crawl4AI and `webCrawl()` throws when sidecar missing. Interface docs now promise behavior Implementation does not provide.

**Smallest safe fix**: either document `webRead` as internal `PageAcquisition` adapter only, or wire actual Readability fallback into `web_crawl`. Update health remediation to match chosen Interface.

**Do now/defer**: **Do now** if touching docs/health; otherwise low-risk defer.
