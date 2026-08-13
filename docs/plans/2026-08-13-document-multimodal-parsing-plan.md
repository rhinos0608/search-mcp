# Document & Multimodal Parsing Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Tasks 2 and 4 are independent and may run in parallel after Task 1. Task 3 depends on Task 2 (it reuses the shared `ParsedDocument` type defined in Task 2's `types.ts`), so it must wait for Task 2. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When web search/fetch returns only a thin snippet of a document (e.g. an arxiv PDF abstract), fetch and parse the full document into clean markdown — with optional multimodal (figure/table) extraction — all in-process, no new sidecar.

**Approach:** Add an in-process, config-gated document parser that plugs into the existing `documentExtraction.ts` binary-format seam. Tiered: HTML-first for arxiv/HTML-twin URLs → `pdf-parse` v2 for PDFs → `officeparser` for office docs. `web_search` auto-enriches thin document snippets (capped top-N). An opt-in multimodal tier rasterizes figures/pages and describes them via the already-configured `LlmConfig` vision endpoint. Disabled by default → behavior unchanged.

**Riskiest assumption:** Pure-JS `pdf-parse` v2 text/table quality is "good enough" for born-digital academic PDFs. Mitigated by HTML-first tier (arxiv ~90% have native HTML) handling the priority case before PDF parsing is ever reached.

## Decisions to review

- **Trigger = A (auto, capped):** `web_search` automatically parses thin document-snippet results, capped to top-N (default 3). Alternative: explicit param only. Late-change cost: low — gated by config + a cap constant, easy to flip to opt-in.
- **Multimodal = opt-in (ii):** VLM figure/table pass is off unless caller passes `multimodal: true` AND `LlmConfig` is configured. Alternative: always-on. Late-change cost: low — a param + config check.
- **New deps:** `pdf-parse` v2 (Apache-2.0), `officeparser` (MIT). Both permissive. Rejected: `mupdf`/`pymupdf-wasm` (AGPL). Late-change cost: medium (swapping a parser lib later touches one module each).
- **OCR out of scope for v1:** `tesseract.js` deferred (research: trap for bulk; rare need). Pivot signal below.
- **Default OFF:** entire feature gated by `DOCUMENT_PARSING_ENABLED`. When unset, `documentExtraction.ts` binary short-circuit behaves exactly as today.

## Known unknowns

- **pdf-parse v2 table quality on academic tables** — Default: ship heuristic `getTable` output; Pivot signal: reviewer/manual check shows garbled tables → contain by routing tables through the opt-in VLM tier, not by adding a sidecar now.
- **Node/pdfjs version floor** — pdf-parse v2 requires Node `>=20.16.0 <21 || >=22.3.0`; repo `engines` was `>=18`. Resolution: bump `engines` to `>=20.16.0` to match the installed pdf-parse floor; CI already runs Node 22 (satisfies it). `pdf-parse` and `officeparser` are loaded only via lazy dynamic `import()` inside the parser modules (never a static top-level import), so a missing or incompatible dependency cannot break installation or startup on supported runtimes — the multimodal feature flag is not used to protect any import. Pivot: if install fails on a supported runtime, worker reports before further changes.
- **`@napi-rs/canvas` for rasterization** — needed only by the opt-in multimodal tier (page/figure raster). Default: make it an optional dependency loaded via dynamic import inside the VLM module; if missing, multimodal tier degrades to text + a warning. Contain: never import it at top level of any always-loaded module.

## Global Constraints

- TypeScript strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- ESM-only. Local imports need `.js` extensions. Zod v4: `import { z } from "zod/v4"`.
- Config precedence: encrypted file → env → `DEFAULTS`. Pattern: `interface → DEFAULTS → EnvConfig → loadFromEnv() → merge in loadConfig()`.
- Sidecar/HTTP calls: `AbortSignal.timeout(...)`, `getUserAgent()` User-Agent, optional `Authorization: Bearer`. All outbound fetches go through `assertSafeUrl()` (SSRF guard).
- Tests: `node:test` (compiled to `dist/` then run via `npm test`). Commands: `npm run typecheck`, `npm run lint`, `npm test`.
- Never commit `config.json` / `config.enc` / keys. No commits unless user asks.
- Errors sanitized (no stack traces) in `ToolResult`. Warnings are structured strings appended to `warnings[]`.

---

### Task 1: Dependencies + config gate

**Outcome:** `DOCUMENT_PARSING_ENABLED` (and a `multimodal` sub-flag) is threaded through config with the standard precedence; `pdf-parse` and `officeparser` are installed; health check + example files reflect the new gate. Feature is OFF by default.

**Files:**

- Modify: `package.json` (add `pdf-parse`, `officeparser`; run install to update `package-lock.json`)
- Modify: `src/config.ts` — add `DocumentParsingConfig` interface, `DEFAULTS.documentParsing`, `EnvConfig.documentParsing`, `loadFromEnv()` block (`DOCUMENT_PARSING_ENABLED`, `DOCUMENT_PARSING_MULTIMODAL`, optional `DOCUMENT_PARSING_MAX_ENRICH` cap), and merge block in `loadConfig()`
- Modify: `src/health.ts` and/or `src/tools/standalone/healthCheck.ts` — surface `documentParsing.enabled`
- Modify: `.env.example`, `config.example.json`, `AGENTS.md` config section (one line)
- Test: `test/config/documentParsing.test.ts`

**Interfaces:**

- Produces: `DocumentParsingConfig { enabled: boolean; multimodal: boolean; maxEnrich: number }` on `SearchConfig.documentParsing`. `DEFAULTS.documentParsing = { enabled: false, multimodal: false, maxEnrich: 3 }`. Mirror the `crawl4ai` config exactly (config.ts:152-155, 573-580, 1032-1040).
- Consumes: existing `LlmConfig` (config.ts:176-180) — no change, reused by Task 7.
- **Hard bounds (enforced before any parsing/enrichment):** validate `DOCUMENT_PARSING_MAX_ENRICH` — parse as a non-negative integer and clamp to a sane ceiling (e.g. 0–10); invalid values fall back to the default (3).

**Checks:**

- Red: `test/config/documentParsing.test.ts` asserting `DOCUMENT_PARSING_ENABLED=true` yields `enabled:true` — fails before merge block exists.
- Green: `npm run typecheck && npm test -- test/config/documentParsing.test.ts` passes; default config has `documentParsing.enabled === false`.

- [ ] Add deps, run install, confirm lockfile updated and permissive licenses.
- [ ] Add config interface/defaults/env/merge mirroring `crawl4ai`.
- [ ] Surface in health check; update example/env/docs.
- [ ] Write + run config test.

---

### Task 2: PDF parser module

**Outcome:** A pure-JS module converts a fetched PDF (bytes or URL) into markdown + extracted embedded images + best-effort tables, with warnings. No wiring yet.

**Files:**

- Create: `src/utils/documentParsers/pdf.ts`
- Test: `test/documentParsers/pdf.test.ts` (fixture: a tiny born-digital PDF committed under `test/fixtures/`)

**Interfaces:**

- Produces: `export async function parsePdf(input: ArrayBuffer | Uint8Array, opts?: { maxPages?: number }): Promise<ParsedDocument>` where
  `ParsedDocument = { markdown: string; title: string; images: { data: Uint8Array; mime: string; page: number }[]; tables: string[]; warnings: SemanticCrawlWarning[] }`. Put `ParsedDocument` in `src/utils/documentParsers/types.ts` (shared by Tasks 3, 5, 7). `SemanticCrawlWarning` is the typed warning union from `src/types.ts` — never a bare string.
- Uses `pdf-parse` v2 (`getText`/`getParagraph` for markdown-ish text, `getImage` for embedded images, `getTable` for heuristic tables). Consult installed package's actual API surface before coding; do not assume method names — verify against `node_modules/pdf-parse`.
- **Hard bound:** `maxPages` is enforced by passing `first` to the pdfjs parse params so a huge PDF is never fully parsed before formatter trimming.

**Checks:**

- Red: `test/documentParsers/pdf.test.ts` expects non-empty markdown from the fixture — fails before module exists.
- Green: `npm test -- test/documentParsers/pdf.test.ts` passes; markdown contains known fixture text; no throw on a zero-image PDF.

- [ ] Implement `parsePdf` + shared `ParsedDocument` type.
- [ ] Commit a small text-based PDF fixture; write + run test.

---

### Task 3: Office parser module

**Outcome:** A module converts docx/pptx/xlsx (and epub) bytes into markdown via `officeparser`, returning the shared `ParsedDocument` shape.

**Files:**

- Create: `src/utils/documentParsers/office.ts`
- Test: `test/documentParsers/office.test.ts` (fixture: tiny `.docx` under `test/fixtures/`)

**Interfaces:**

- Produces: `export async function parseOffice(input: Uint8Array | ArrayBuffer, ext: string): Promise<ParsedDocument>`. Reuses `ParsedDocument` from Task 2's `types.ts` (including `warnings: SemanticCrawlWarning[]`).
- Uses `officeparser` (verify its actual API — likely `parseOfficeAsync(buffer)` → string; check `node_modules/officeparser`). Map its plain-text/markdown output into `ParsedDocument.markdown`; `images`/`tables` may be empty for v1.
- **Hard bound:** cap the input byte size before `parseOfficeAsync` and bound archive expansion so a huge docx/xlsx cannot exhaust memory during unzip/parse.

**Checks:**

- Red: test expects fixture docx text in markdown — fails before module.
- Green: `npm test -- test/documentParsers/office.test.ts` passes.

- [ ] Implement `parseOffice`; write + run test with docx fixture.

---

### Task 4: HTML-first tier (arxiv + HTML-twin)

**Outcome:** URL helpers return HTML alternatives to try before binary parsing: arxiv `abs`/`pdf` id → `https://arxiv.org/html/<id>` and `https://ar5iv.labs.arxiv.org/html/<id>`, plus the existing generic HTML fallback.

**Files:**

- Modify: `src/utils/documentUtils.ts` — add `arxivHtmlUrls(url: string): string[]` and extend `documentFallbackUrls()` to prepend arxiv HTML candidates (ordered: `arxiv.org/html` → `ar5iv...` → existing abstract/strip-ext fallbacks), deduped.
- Test: `test/documentUtils.test.ts` (extend if exists, else create)

**Interfaces:**

- Consumes: existing `arxivPdfToAbstract` regex (documentUtils.ts:54-66) for id extraction — factor the `\d{4}\.\d{4,6}` id parse into a small helper reused by `arxivHtmlUrls`.
- Produces: ordered `string[]` of HTML candidate URLs (may be empty for non-arxiv/non-doc URLs).

**Checks:**

- Red: test asserts `arxivHtmlUrls('https://arxiv.org/pdf/2402.08954')` includes `https://arxiv.org/html/2402.08954` — fails before helper.
- Green: `npm test -- test/documentUtils.test.ts` passes; non-arxiv URL yields `[]`.

- [ ] Add `arxivHtmlUrls` + extend `documentFallbackUrls`; write + run test.

---

### Task 5: Dispatch wiring in documentExtraction.ts

**Outcome:** When `documentParsing.enabled`, the binary short-circuit (documentExtraction.ts:166-168) instead runs the tiered pipeline: HTML-first candidates (fetch HTML, return if usable) → fetch bytes → `parsePdf` for `.pdf` / `parseOffice` for office exts → assemble `DocumentExtractionResult`. When disabled or all tiers fail, return `unsupported: true` (unchanged fallback behavior). Extend the result type to optionally carry extracted images for the multimodal tier.

**Files:**

- Modify: `src/utils/documentExtraction.ts` — inject config, branch on `enabled`, call parsers, add `images?: ParsedDocument['images']` to `DocumentExtractionResult`.
- Test: `test/documentExtraction.test.ts` (extend/create) — mock fetch + parsers.

**Interfaces:**

- Consumes: `parsePdf` (Task 2), `parseOffice` (Task 3), `documentFallbackUrls`/`arxivHtmlUrls` (Task 4), `SearchConfig.documentParsing` (Task 1). `extractDocumentUrl` signature gains an optional `config?: SearchConfig` (default `loadConfig()`) — keep back-compat for the 3 existing callers (webCrawl.ts, semanticCrawl.ts ×2) which pass only `{ timeoutMs }`.
- Produces: `DocumentExtractionResult` now with optional `images`; `success:true` + markdown when any tier yields content.
- Constraint: every outbound fetch (HTML candidates + byte fetch) passes `assertSafeUrl()` and `AbortSignal.timeout`.
- **Hard bound:** cap fetched response bytes — abort the byte fetch once it exceeds a hard limit (e.g. 20 MiB) so a large document is never fully downloaded before formatter trimming.

**Checks:**

- Red: test with `enabled:true` + mocked PDF bytes expects `success:true` markdown — fails before dispatch.
- Green: `npm test -- test/documentExtraction.test.ts` passes; with `enabled:false` a `.pdf` URL still returns `{ unsupported:true }` (regression guard); existing callers still typecheck.

- [ ] Add config branch + tiered dispatch + `images` field.
- [ ] Verify 3 existing callers unaffected; write + run tests.

---

### Task 6: web_search auto-enrichment (trigger A, capped)

**Outcome:** After ranking, `web_search` enriches up to `documentParsing.maxEnrich` top results whose URL is a document and whose `contentKind` is `snippet`/unset: fetch+parse full document, replace `description`/content with parsed markdown (budget-trimmed), set `contentKind:'full'`. Gated by `documentParsing.enabled`; no-op when disabled. Bounded, parallel, per-result failures isolated (keep original snippet on failure).

**Files:**

- Create: `src/tools/webSearchDocEnrich.ts` — `enrichDocumentSnippets(results: SearchResult[], cfg: SearchConfig): Promise<SearchResult[]>`
- Modify: `src/tools/standalone/webSearch.ts` — call enrichment after `searchImpl(...)` and before scrub/format, config-gated.
- Test: `test/webSearchDocEnrich.test.ts`

**Interfaces:**

- Consumes: `extractDocumentUrl(url, { config })` (Task 5), `isDocumentUrl` (documentUtils), `SearchResult.contentKind` (types.ts:105).
- Produces: same `SearchResult[]`, enriched entries have `contentKind:'full'` and expanded content. Cap = `cfg.documentParsing.maxEnrich`. Only enriches results already within the returned `limit` window (do not fetch docs the user won't see).

**Checks:**

- Red: test with a doc-snippet result + `enabled:true` expects `contentKind:'full'` and parsed content — fails before enrichment.
- Green: `npm test -- test/webSearchDocEnrich.test.ts` passes; `enabled:false` returns results unchanged; a failing fetch leaves the original snippet intact; cap respected.

- [ ] Implement enrichment module (bounded, isolated failures).
- [ ] Wire into standalone web_search, config-gated; write + run tests.

---

### Task 7: Multimodal VLM tier (opt-in)

**Outcome:** When `documentParsing.multimodal` AND `LlmConfig.baseUrl` are set, the PDF path rasterizes figure regions/pages and asks the configured vision LLM to describe figures / transcribe complex tables, appending results to the markdown. Opt-in via a `multimodal` param on `web_search` and `web_crawl`. Degrades to text (with warning) if `@napi-rs/canvas` or LLM is unavailable.

**Files:**

- Create: `src/utils/documentParsers/vlm.ts` — `describeVisuals(doc: ParsedDocument, pdfBytes: Uint8Array, cfg: SearchConfig): Promise<string[]>` (markdown snippets)
- Modify: `src/utils/documentParsers/pdf.ts` — expose a page/region rasterizer (dynamic-import `@napi-rs/canvas` or pdf-parse `getScreenshot`); guard so always-loaded paths never require canvas.
- Modify: `src/utils/documentExtraction.ts` — when `multimodal`, invoke `describeVisuals` and append to markdown.
- Modify: `src/tools/standalone/webSearch.ts` + `src/tools/standalone/webCrawl.ts` — add optional `multimodal: z.boolean().optional().default(false)` param, plumb to enrichment/extraction.
- Test: `test/documentParsers/vlm.test.ts` (mock the LLM HTTP call; assert prompt shape + graceful degradation when canvas/LLM missing)

**Interfaces:**

- Consumes: `LlmConfig` (baseUrl/provider/apiToken), OpenAI-compatible vision chat (`POST {baseUrl}/chat/completions`, image_url base64). Reuse any existing chat helper if one exists (check `src/research/llm/chat.ts` / browser.act LLM client) rather than writing a new HTTP client.
- Produces: markdown strings appended under a `### Figures` / `### Tables (transcribed)` heading.
- Constraint: opt-in only; zero LLM calls when `multimodal:false` or LLM unconfigured. `@napi-rs/canvas` imported only via dynamic import inside this tier.
- **Warning contract:** `describeVisuals` returns `VisualDescriptionResult` with `snippets: string[]` and `warnings: SemanticCrawlWarning[]`. The following typed warning variants are added to the `SemanticCrawlWarning` union:
  - `{ code: 'DOCUMENT_PARSING_CANVAS_UNAVAILABLE'; message: string }` — `@napi-rs/canvas` could not be loaded; rasterization is unavailable.
  - `{ code: 'DOCUMENT_PARSING_VISION_LLM_UNAVAILABLE'; message: string }` — the configured vision LLM endpoint is unreachable or unconfigured.
  - `{ code: 'DOCUMENT_PARSING_EMPTY_VISUAL_OUTPUT'; message: string }` — the vision LLM returned no usable description for a figure/table.
    When canvas or the LLM is unavailable, `describeVisuals` emits the corresponding typed warning and degrades to text. `DocumentExtractionResult.warnings` uses `SemanticCrawlWarning[]`. The caller merges the warning into the parser result's `warnings` array without dropping existing entries.

**Checks:**

- Red: test with `multimodal:true` + mocked vision LLM expects a figure-description string in output — fails before module.
- Green: `npm test -- test/documentParsers/vlm.test.ts` passes; with LLM unconfigured returns `[]` + a warning, no throw; `multimodal:false` never calls the LLM.

- [ ] Implement rasterizer (dynamic canvas) + `describeVisuals` reusing existing LLM chat client.
- [ ] Add opt-in param to web_search/web_crawl; wire into extraction; write + run tests.

---

## Final verification (parent, after all tasks)

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm test` full suite green (no regressions).
- [ ] Manual smoke (feature ON): `DOCUMENT_PARSING_ENABLED=true` — `web_search` on an arxiv query enriches the arxiv result to full text via HTML tier; a `.pdf`-only URL parses via pdf-parse.
- [ ] Manual smoke (feature OFF / default): identical behavior to `main` (binary URLs return unsupported, no new fetches).
- [ ] Whole-change review via `requesting-code-review`.
