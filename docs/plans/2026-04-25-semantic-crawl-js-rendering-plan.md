# Semantic Crawl JS Rendering Recovery Plan

**Date**: 2026-04-25  
**Status**: Ready for implementation planning  
**Primary target**: `semantic_crawl` / `web_crawl` rendering on JS-heavy sites

## Why this plan exists

Recent live tests showed a recurring failure mode in JS-rendered documentation sites: crawl4ai returns an app shell or a `Loading...` placeholder, even after a longer wait. The current `semantic_crawl` tool then happily indexes that placeholder content, which makes the semantic result look "successful" while actually being useless.

The repo already has most of the needed plumbing:

- `web_crawl` supports `waitFor`, `delayBeforeReturnHtml`, `pageTimeout`, `jsCode`, and `extractionConfig`.
- `semantic_crawl` forwards those options through to `web_crawl`.
- `semantic_crawl` already emits `warnings` through the existing tool result envelope.
- `webRead` already has a readable-content fallback path that can be reused for non-SPA recovery.

So the work here is not "add crawling support from scratch". The work is to make JS rendering **adaptive** instead of caller-driven and brittle.

## Research inputs

This plan is based on the research notes in `research/`:

- `research/agent-search-patterns.md`
  - kill-chain style fallback extraction
  - result-quality scoring and trust-oriented recovery
- `research/mcp-crawl4ai-rag-patterns.md`
  - hybrid retrieval and structured extraction patterns
- `research/synthesis-semantic-crawl-improvements.md`
  - prioritized semantic crawl improvements and implementation candidates

## Goal

Make `semantic_crawl` recover from common JS-rendering failures without changing the public result shape or breaking static-site performance.

## Non-goals

- No new external services.
- No persistence/cache redesign.
- No ranking-model changes.
- No public API breakage unless a follow-up release explicitly wants a new option.
- No attempt to fully support every SPA framework via hardcoded site-specific hacks.

## Recommended approach

Use an **internal render-recovery loop** with quality gates:

1. Run the normal crawl first.
2. Detect low-quality output (`Loading...`, shell-only markup, nav-only content, or no meaningful chunks).
3. Retry the page with a more aggressive render profile.
4. If crawl4ai still returns placeholder content, fall back to a simpler extraction path and surface a warning.

This keeps the current tool contract stable while improving coverage on dynamic docs sites.

## Why this is the best fit

### Option A — internal adaptive recovery loop, recommended

**Pros**

- No schema change for callers.
- Keeps the happy path fast.
- Can be rolled out incrementally.
- Lets us tune heuristics based on real failures.

**Cons**

- More logic inside the crawler.
- Requires good tests to avoid over-retrying normal pages.

### Option B — expose a new `renderProfile`/`crawlProfile` input

**Pros**

- User-controlled and explicit.
- Easier to force aggressive rendering when needed.

**Cons**

- Adds API surface area.
- Pushes the burden back onto callers.
- Does not solve the default bad-case automatically.

### Option C — separate HTML acquisition layer for SPA recovery

**Pros**

- Clean architectural split.
- Could support multiple renderers later.

**Cons**

- Too large for the current problem.
- Higher risk of touching unrelated behavior.

**Recommendation:** implement A now, keep B as a future escape hatch only if the heuristics prove hard to tune.

---

## Implementation plan

### Phase 1 — Detect placeholder / shell-only output

Create a small render-quality helper that scores crawl output before chunking.

**Signals to flag low-quality pages**

- Text is empty or nearly empty.
- Main chunk is literally `Loading...` or similar placeholder text.
- Output is dominated by navigation, breadcrumbs, or repeated link blocks.
- The page has a successful status but produces no meaningful chunks.
- The extracted content is mostly boilerplate with low information density.

**Output of the helper**

- `confidence` or `quality` score
- reason(s) for retry
- suggested next profile

This helper should live in a shared utility so both `web_crawl` and `semantic_crawl` can use it.

### Phase 2 — Add an adaptive render-retry sequence

If a page fails the quality gate, retry with progressively stronger rendering hints.

Suggested retry sequence:

1. Baseline crawl using existing options.
2. Retry with a longer post-load delay and a stricter `waitFor` target.
3. Retry with a broader `waitFor` target plus a small JS scroll/settle script.
4. If still unusable, fall back to a simpler extraction path.

Example candidate targets:

- `article`
- `main`
- `[role="main"]`
- a JS predicate that waits for meaningful body text instead of a spinner

The implementation should cap retries so the tool does not become slow on normal sites.

### Phase 3 — Fallback extraction for stubborn pages

When crawl4ai still returns only shell content, use a fallback path that tries to salvage readable content instead of indexing the placeholder.

Likely fallback order:

1. Reuse the rendered markdown if the retry produced enough signal.
2. Reuse existing readability-style extraction helpers where appropriate.
3. Return a warning and skip the page if the page is still unusable.

This is intentionally not a full alternate crawler. It is a last-resort salvage path.

### Phase 4 — Surface recovery diagnostics

Use the existing `warnings` mechanism in tool results to expose what happened.

Examples:

- `semantic_crawl: retried page with aggressive render profile`
- `semantic_crawl: fallback extraction used for https://...`
- `semantic_crawl: page still resolved to placeholder content and was skipped`

If we need page-level detail later, keep it additive and tucked into result metadata, not the main chunk shape.

### Phase 5 — Lock it down with fixtures and regressions

Add tests for the failure mode we observed.

Minimum fixtures:

- a static SSR page that should continue to work normally
- a JS shell page that initially returns `Loading...` but resolves after extra wait/scroll
- a page with nav-heavy boilerplate that should be rejected by the quality gate
- a page where fallback extraction is the only usable outcome

The tests should verify both:

- the returned chunks are meaningful
- the warnings reflect the recovery path

---

## Files likely to change

- `src/tools/webCrawl.ts`
- `src/tools/semanticCrawl.ts`
- `src/tools/webRead.ts` or a shared extraction helper, if the fallback path needs it
- `src/utils/renderRecovery.ts` or similar new helper
- `test/webCrawl*.test.ts`
- `test/semanticCrawl*.test.ts`
- `docs/tools.md` if any new user-facing behavior needs to be documented
- `docs/plans/index.md` for discoverability

## Suggested implementation order

1. Build the render-quality detector.
2. Add the retry loop inside `web_crawl`.
3. Wire `semantic_crawl` to propagate warnings and skip bad pages earlier.
4. Add the fallback salvage path.
5. Add fixture-based regression tests.
6. Document the new behavior.

## Acceptance criteria

- JS-heavy docs pages no longer resolve to a single `Loading...` chunk in the known failure case.
- Static pages keep their current behavior and latency.
- Low-quality shell output is retried automatically before indexing.
- Placeholder-only content is not treated as a successful semantic result.
- Tool warnings explain when recovery or fallback was used.
- Tests cover the barrier and pass consistently.

## Follow-on ideas left out on purpose

These were in the research notes but are not required to solve the barrier immediately:

- contextual embeddings
- domain trust / typosquat detection
- query expansion
- persistence or long-lived corpus storage
- code-specific adapters

Those can come later once rendering recovery is stable.

## References

- `research/agent-search-patterns.md`
- `research/mcp-crawl4ai-rag-patterns.md`
- `research/synthesis-semantic-crawl-improvements.md`
- `docs/superpowers/plans/2026-04-23-semantic-crawl-fixes.md`
- `docs/superpowers/specs/2026-04-23-semantic-crawl-design.md`
