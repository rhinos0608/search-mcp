# MCP contracts audit

Scope: `src/server.ts`, `src/tools/registry.ts`, family vs standalone registration, config gates, health, result envelopes, Zod v4 schemas, uncommitted `agentic_browse` / `fetch_focus` / `browser` / `web_crawl` diff.

Commands run:

- `npm run typecheck` ✅
- `npm run build` ✅
- `npm test -- --test-name-pattern='fetch_focus|agentic_browse|web_crawl|browser|family'` ✅ (190 pass)

## High

### 1. `health_check` advertises `outputSchema` but returns no `structuredContent`

Refs:

- `src/tools/standalone/healthCheck.ts:22` declares `outputSchema`.
- `src/tools/standalone/healthCheck.ts:54-56` returns `successResponse(makeResult(...))` only.
- `src/tools/response.ts:316-329` `successResponse()` returns text `content` only, no `structuredContent`.

Contract risk: real MCP calls fail SDK output validation. SDK requires `structuredContent` when tool has `outputSchema`; direct handler tests miss this. Likely runtime error: `Output validation error: Tool health_check has an output schema but no structured content was provided`.

Smallest safe fix: either remove `outputSchema` from `health_check`, or return structured content matching schema:

```ts
const report = await runHealthProbes(cfg);
const result = makeResult('health_check', report, Date.now() - start);
return { ...successResponse(result), structuredContent: report };
```

Tests to add/run:

- Add MCP-level call test through SDK request handler/transport, not direct `_registeredTools` handler.
- Assert `health_check` call is not `isError` and has `structuredContent.overall`.
- Run `npm run typecheck && npm test -- --test-name-pattern='health_check|outputSchema'`.

### 2. `fetch_focus` public tool removed without compatibility alias

Refs:

- `src/server.ts:14-21` no longer imports `registerFetchFocus`.
- `src/server.ts:100-103` registers `agentic_browse`, then `health_check`; no `fetch_focus`.
- `src/tools/standalone/fetchFocus.ts:15-38` still defines `registerFetchFocus`, now dead from composition root.
- `README.md` diff removes `fetch_focus` from Semantic RAG docs.

Contract risk: existing MCP clients calling `fetch_focus` now get `Tool not found`. `agentic_browse.focus` is not backward-compatible at tool-name level. No deprecation window, no alias, no health entry.

Smallest safe fix: keep `fetch_focus` as deprecated compatibility alias that delegates to same `fetchFocus()` implementation, or register it conditionally for one release while documenting migration to `agentic_browse.focus`.

Tests to add/run:

- With Crawl4AI + LLM config, assert both `fetch_focus` and `agentic_browse` are listed.
- Call `fetch_focus` direct/MCP and assert response envelope matches old shape.
- Run `npm test -- --test-name-pattern='fetch_focus|agentic_browse.focus'`.

### 3. Config gates now hide `web_crawl` and `browser` instead of surfacing actionable unavailable errors

Refs:

- `src/server.ts:77` registers `web_crawl` only when `!gated.has('web_crawl')`.
- `src/server.ts:94-99` registers `browser` only when `!gated.has('browser')`.
- `src/health.ts:49-78` puts `web_crawl` and `browser` in `GATED_TOOLS`.
- `src/tools/webCrawl.ts:86-89` already returns actionable `unavailableError` when Crawl4AI missing.
- `src/tools/families/browser.ts:377-381` already has per-action config issue for disabled browser.

Contract risk: tools disappear from `tools/list` in default/unconfigured env. Clients see `Tool not found` instead of stable discovery + actionable JSON error. Also conflicts with family-tool contract: family tools should stay registered; action availability checked at runtime.

Smallest safe fix: always register `browser`; let `browserDisabledIssue` handle all actions. Prefer restoring always-register `web_crawl` too, since handler already has actionable unavailable error. Keep health `unconfigured` status, but do not use same gate set as registration removal.

Tests to add/run:

- Default config: assert `browser` and `web_crawl` are in `_registeredTools`.
- Default config MCP call: `browser.session` and `web_crawl` return JSON error/remediation, not `Tool not found`.
- Run `npm test -- --test-name-pattern='web_crawl|browser|gated'`.

## Medium

### 4. Reddit OAuth absence marked healthy while message describes degraded path

Refs:

- `src/health.ts:287-293` returns `status: 'healthy'` for no OAuth, while message says public Reddit API may block cloud/datacenter IPs and remediation suggests OAuth.

Contract risk: `health_check` can report healthy Reddit posture when default unauthenticated path is operationally degraded. Agents/operators lose signal to configure OAuth before `reddit.search` / `reddit.comments` fail intermittently.

Smallest safe fix: restore `status: 'degraded'` for OAuth absent, or split into explicit `reddit_oauth.status = degraded` while keeping per-action Reddit tools healthy if public fallback exists.

Tests to add/run:

- No Reddit env: `configHealth(cfg).reddit_oauth.status === 'degraded'`.
- Partial env: still degraded with missing key remediation.
- Full env: healthy.

### 5. Family validation errors bypass app JSON error envelope over real MCP

Refs:

- `src/tools/registry.ts:173-190` merged input schema `superRefine()` runs strict per-action validation at SDK layer.
- `src/tools/registry.ts:239-250` handler has JSON `errorResponse()` for validation errors, but SDK input validation fires before handler during real MCP calls.

Contract risk: invalid family calls return SDK plain-text `isError` instead of project-standard JSON `{ "error": ... }` envelope. Direct `_registeredTools.handler(...)` tests give false confidence because they bypass SDK validation.

Smallest safe fix: make family discovery schema permissive enough for SDK validation to pass (`action` enum + optional fields), and keep strict per-action validation inside handler. If SDK-level validation is desired, accept plain SDK errors as contract and update tests/docs.

Tests to add/run:

- MCP-level invalid call: `reddit.semantic` missing `query` returns parseable JSON error if that is desired contract.
- Same for `agentic_browse.focus` missing `focus`.
- Run `npm test -- --test-name-pattern='validation error|family'`.

## Low

### 6. `agentic_browse` URL schemas under-specify URL format

Refs:

- `src/tools/families/agenticBrowse.ts:114-162` uses `z.string()` for `url` in `browse`, `browse_and_present`, `read`, and `focus`.
- `src/tools/standalone/fetchFocus.ts:22` old standalone uses `z.url()`.

Contract risk: generated MCP JSON schema does not tell clients URL format. Invalid URLs fail later via `assertSafeUrl()`/fetch path instead of schema guidance.

Smallest safe fix: use `z.url()` for `url` fields if SDK-level validation errors are acceptable. If JSON envelope consistency is priority, keep `z.string()` but add `.min(1)` and clearer descriptions, then validate inside handler with JSON `errorResponse()`.

Tests to add/run:

- Invalid URL for each `agentic_browse` action returns intended error shape.
- `tools/list` JSON schema exposes URL format if `z.url()` chosen.

### 7. Dead/stale `fetch_focus` registration has misleading gate comment

Refs:

- `src/tools/standalone/fetchFocus.ts:1-6` says standalone tool is gated.
- `src/tools/standalone/fetchFocus.ts:15-38` no longer gates at registration.
- `src/server.ts:100-103` no longer calls it.

Contract risk: future re-import changes behavior silently: `fetch_focus` would register even when unconfigured. Could be fine if handler returns actionable error, but comment/docs say gated.

Smallest safe fix: either remove dead standalone module, or keep it as compatibility alias and make gate behavior explicit in code/tests.

Tests to add/run:

- If alias retained: assert configured/unconfigured behavior intentionally.
- If module removed: assert no imports and docs mention migration.
