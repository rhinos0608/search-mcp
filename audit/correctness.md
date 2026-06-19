# Correctness / Regression Audit

**Scope:** uncommitted diff (`git status` working tree) on `main` of `/Users/rhinesharar/search-mcp`.
**Inputs read:** diff vs HEAD, `src/server.ts`, `src/health.ts`, `src/tools/families/agenticBrowse.ts`, `src/tools/standalone/fetchFocus.ts`, `src/tools/registry.ts`, `src/tools/redditSearch.ts`, `src/tools/fetchFocus.ts`, `test/familyConsolidation.test.ts`, `test/fetchFocusRegistration.test.ts`, `scripts/run-tests.cjs`, `src/research/strategies/agentTools.ts`, `src/config.ts` (deepResearch shape).
**No `plan.md` / `progress.md` exist at the repo root** (only `AGENTS.md`, `CLAUDE.md`, `ROADMAP.md`, `README.md`, `SPEC_context_window_protection.md`, `ANALYSIS_context-mode_patterns.md`).

**Validation already run:**

- `npm run typecheck` → 0 errors (`tsconfig.json` + `tsconfig.test.json`).
- `npm test` → **1699 pass / 0 fail / 2 skipped** (full suite, ~32 s).
- Targeted `npm test -- test/fetchFocusRegistration.test.ts test/familyConsolidation.test.ts` → **35/35 pass**.

No blockers found. Two Notes and two Observations follow.

---

## Review

### Correct

- **`web_crawl` and `browser` registration now honour `GATED_TOOLS`.** `src/server.ts:77, 94-99` was previously registering these tools unconditionally despite them being listed in `GATED_TOOLS` in `src/health.ts:50, 73`. Pre-diff, when `CRAWL4AI_BASE_URL` was unset the tool was registered and threw at runtime; with the new `if (!gated.has('web_crawl'))` guard, it disappears from the MCP tool list with a clear "Tool not registered (unconfigured)" log line. Latent bug fixed cleanly.
- **`fetch_focus` consolidation is wired through every layer.** `src/server.ts:21` no longer imports `registerFetchFocus`; `src/health.ts:73-78` removed the stale `fetch_focus` gate rule; `src/tools/standalone/fetchFocus.ts` still exports the function but the function is dead — the only callers are now `src/tools/families/agenticBrowse.ts:22, 289` via the `focus` action. The README (`README.md:13, 84`) and tests (`test/familyConsolidation.test.ts:416-422`, `test/fetchFocusRegistration.test.ts`) all consistently advertise the new `agentic_browse.focus` location. No orphan references found in the live code (`src/`, `test/`).
- **Internal `fetch_focus` tool name in agent strategy is a non-issue.** `src/research/strategies/agentTools.ts:467` defines a tool named `fetch_focus` for the LLM agent loop, which is an internal LLM tool, not an MCP tool. Renaming not required for the consolidation, and changing it would be out of scope.
- **`agentic_browse.focus` `configIssue` semantics are correct.** `src/tools/families/agenticBrowse.ts:298-306` checks `cfg.crawl4ai.baseUrl.length === 0` and `!cfg.deepResearch.baseUrl || !cfg.deepResearch.model`. `SearchConfig.deepResearch.baseUrl` and `.model` are typed as `string` (default `''`, see `src/config.ts:329, 331`), so the `!` check correctly matches the original `fetchFocus()` precondition in `src/tools/fetchFocus.ts:19, 23`. The error string ("Set CRAWL4AI_BASE_URL to use agentic_browse.focus.") is a clean superset of the prior `Set CRAWL4AI_BASE_URL plus DEEP_RESEARCH_BASE_URL and DEEP_RESEARCH_MODEL to enable fetch_focus.` remediation.
- **`redditSearch` relevance-only semanticMatch gate is a deliberate fix.** `src/tools/redditSearch.ts:170` now triggers `semanticMatch` only when `sort === 'relevance'`. Previously, semanticMatch ran for any sort, then the result was re-fed into `multiSignalRescore` keyed off `rescoreSort`, which is a wasteful double-ranking for `new/hot/top`. The new gate short-circuits to the cheap rescore path for non-relevance sorts. Schema default (`SORT_SEMANTIC.default('relevance')` in `src/tools/families/reddit.ts:204`) preserves prior behaviour for callers that don't specify `sort`.
- **Family-merge schema in `src/tools/registry.ts:145-191`** correctly disambiguates the merged `agentic_browse` schema: `browse_and_present` and `read` both use `url: string` and `maxChars: number`, but those fields share the same Zod type so the second insertion is the same `allFields.set(key, z.unknown())` path used for every other conflict, and the strict per-action `safeParse` in `superRefine` handles validation. Typecheck confirms 0 errors.

### Blocker

_None._ Typecheck clean, full test suite green, no orphan registrations, no unhandled runtime paths.

### Note

- **`browse_and_present` and `read` are byte-identical.** `src/tools/families/agenticBrowse.ts:225-279` defines two actions with the same Zod schema, the same handler body, and the same return shape. The `read` description says "in one call" but so does `browse_and_present`'s description. This isn't a regression (both pre-existed/regressed together in this diff), but it inflates the MCP tool surface area for clients and adds a no-op action to the schema validator's switch. **Smallest safe fix:** delete one of the two actions. If `read` is the new preferred name (matches `agentic_browse.read` documented in `README.md:13`), remove `browse_and_present` and drop it from `FAMILY_TOOLS` in `test/familyConsolidation.test.ts:43`. If both must stay, document the distinction in the description strings. **Validation:** `npm run typecheck && npm test -- test/familyConsolidation.test.ts`.

- **`fetchFocus.ts` is still a top-level export but only reachable via `agentic_browse.focus`.** `src/tools/fetchFocus.ts` is now an implementation detail of the `agentic_browse` family. It is no longer imported from `src/tools/standalone/fetchFocus.ts` (the standalone registration is now a dead file) — but `src/tools/standalone/fetchFocus.ts` is still on disk and still exports `registerFetchFocus` (no `unused-export` lint hit because `noUnusedLocals` only catches locals, not module exports). If the consolidation is intended to be total, delete `src/tools/standalone/fetchFocus.ts`. **Smallest safe fix:** `rm src/tools/standalone/fetchFocus.ts` (no other importers). **Validation:** `npm run typecheck && npm test`.

### Observation

- **Reddit OAuth health is now `healthy` when unauthenticated, not `degraded`.** `src/health.ts:288` was changed from `'degraded'` to `'healthy'`. The accompanying `remediation` string ("Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable OAuth access…") still nudges the user, so the change is intentional and signals that the public JSON API is a fully supported mode, not a degraded one. Pre-existing follow-up: the `reddit_oauth` indicator is still reported in `configHealth()` (`src/health.ts:151`), but with status `healthy` it can no longer contribute to a `degraded` `overall` for the `health_check` MCP tool (`src/health.ts:746-760`). The `RATE_LIMIT_TOOL_MAP` still lists `reddit.search`/`reddit.comments` (`src/health.ts:645-646`), so rate-limit hits will still surface as `rate_limited`. Behaviour change is consistent; no action required.

- **`run-tests.cjs` no longer forces `tsc --pretty false`.** `scripts/run-tests.cjs:90-93` removed the two `--pretty false` args. Effect: when `tsc` runs and produces type errors, the output is now pretty-printed to stderr instead of single-line. Tsc exit status is still honoured, so CI/CLI failure detection is unaffected. **Validation:** `npm test` (already green).

- **`configHealth()` now reports `reddit_oauth: healthy` for the unauthenticated path** while the message text still mentions "Reddit may block from cloud/datacenter IPs". If the user reads only the `status` field, this could understate risk. Mitigated by the `message` and `remediation` fields, which still surface the warning. Pre-existing pattern, not introduced by this diff.

---

## Tool-surface delta

| Tool                                      | Before                             | After                                            | Notes                                      |
| ----------------------------------------- | ---------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `fetch_focus` (standalone)                | registered, gated on config        | **removed** from MCP                             | Now `agentic_browse.focus`                 |
| `web_crawl` (standalone)                  | registered, always                 | **gated** on `CRAWL4AI_BASE_URL`                 | Fixes pre-existing bug                     |
| `browser` (family)                        | registered, always                 | **gated** on `BROWSER_ENABLED`                   | Matches existing `GATED_TOOLS` rule        |
| `agentic_browse.focus` (new action)       | n/a                                | registered, gated on Crawl4AI + DeepResearch LLM | Replaces standalone `fetch_focus`          |
| `agentic_browse.read` (new action)        | n/a                                | registered, no gating                            | Identical to existing `browse_and_present` |
| `health_check` (`reddit_oauth` indicator) | `degraded` for unauth              | `healthy` for unauth                             | Documented change in `src/health.ts:288`   |
| `reddit.search` (MCP)                     | always-semantic when embedding set | semantic only on `sort=relevance`                | Intentional fix                            |

## Suggested minimal follow-up (low risk)

1. Drop `src/tools/standalone/fetchFocus.ts` (no other importers) → confirms consolidation is total.
2. Remove `browse_and_present` from `agentic_browse` and the `FAMILY_TOOLS` test map if `read` is the preferred alias; alternatively differentiate the descriptions.

Neither is required to land the diff as-is.

## Validation commands (re-runnable)

```bash
npm run typecheck
npm test
npm test -- test/fetchFocusRegistration.test.ts test/familyConsolidation.test.ts
node -e "import('./dist/src/server.js').catch(e => { console.error('boot fail:', e); process.exit(1); })"  # post-build smoke
```
