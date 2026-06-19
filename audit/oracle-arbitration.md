# Oracle Arbitration — search-mcp System Audit

**Scope:** `/Users/rhinesharar/search-mcp`. Working tree contains 9 modified files (uncommitted, user-owned) plus 5 audit reports in `audit/`. Decision = which fixes land now, which defer, which need product owner.

**Inputs verified against working tree:**

- `git diff --stat` → 9 files, +168/-74 lines
- `src/server.ts:77, 94-99` (gate additions), `src/health.ts:288` (`healthy` flip), `src/tools/families/agenticBrowse.ts:100-103` (entity decode fix), `:145-156, 225-279` (`read`/`browse_and_present` duplicate), `:282-308` (`focus` action)
- `src/tools/standalone/fetchFocus.ts:15-38` (registration function now dead — no caller in `src/server.ts`)
- `src/httpGuards.ts:86-148` (SSRF guard), `src/server/http.ts:39-43, 154` (query-key auth + bind), `src/config/manager.ts:17-32` (redaction list)
- `src/research/jobManager.ts:578-582, 611-615` (timer leak + force-expire math), `src/utils/corpusCache.ts:998-1010` (key mismatch), `src/research/sourceRanking.ts:98-107` (future-date)
- `src/tools/standalone/healthCheck.ts:22-48, 54-56` (outputSchema declared, no structuredContent)

**SDK confirmation:** `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:196-198` throws `Output validation error: Tool health_check has an output schema but no structured content was provided`. Real MCP runtime break, not hypothetical.

---

## Summary Matrix

| #       | Finding                                                                  | Severity | Decision                 | Why                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------ | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1      | SSRF: IPv4-mapped IPv6 loopback bypass                                   | High     | **Apply now**            | Cross-cuts every fetch tool; trivial regex fix; no behavior change for legitimate URLs                                                                                            |
| S2      | SSRF: redirects/DNS not revalidated                                      | High     | **Defer (need design)**  | Touches fetch stack + browser CDP; requires Undici dispatcher or DNS hook — design choice between fail-closed redirect and dispatcher-level guard                                 |
| S3      | Browser unguarded `page.goto()`                                          | High     | **Apply now (partial)**  | Add `assertSafeUrl()` at the 3 bypass sites (lines 813, 1143, 1450). Route-interceptor full fix is the design question in S2                                                      |
| S4      | Dashboard redaction leak (`deepResearch.apiToken`, browser creds)        | High     | **Apply now**            | Two-line change to `SECRET_LEAF_PATHS`; doesn't shift UX; credential exposure is unambiguous                                                                                      |
| S5      | Query-key MCP auth default-on `0.0.0.0`                                  | Medium   | **Defer (product)**      | Changing default is breaking for any deployed instance relying on query-param. Needs deprecation notice / opt-in migration                                                        |
| S6      | KG ingest unbounded response body                                        | Medium   | **Apply now**            | Switch to existing `safeResponseText(resp, url, maxBytes=5MB)`. Reuses shipped code                                                                                               |
| S7      | Browser cookie/session export too broad                                  | Medium   | **Defer (product)**      | Default-secure-isolated is a UX choice. Not blocking                                                                                                                              |
| S8      | Sidecar health probes lack URL guard + size cap                          | Low      | **Defer (low risk)**     | Only reachable via authenticated dashboard                                                                                                                                        |
| C1      | `health_check` outputSchema without structuredContent                    | High     | **Apply now**            | Live MCP runtime break, SDK-confirmed. Add `structuredContent: report` to the success return                                                                                      |
| C2      | `fetch_focus` removed without compat alias                               | High     | **Apply now**            | Add deprecation alias re-registering `fetch_focus` that delegates to `agentic_browse.focus`. Mark with deprecation message in description                                         |
| C3      | `web_crawl` + `browser` gated from registration (breaks family contract) | High     | **Apply now**            | Restore always-register; let `configIssue`/runtime gate produce actionable errors. Already partially true for `web_crawl` (handler has `unavailableError` at `webCrawl.ts:86-89`) |
| C4      | Reddit OAuth status flipped to `healthy`                                 | Medium   | **Defer (product)**      | Public JSON path is intentional; message string preserves warning. Status taxonomy question                                                                                       |
| C5      | Family SDK validation plain text vs JSON envelope                        | Medium   | **Defer (low risk)**     | Behavior is consistent; not a regression. Would need SDK-level contract change                                                                                                    |
| C6      | `agentic_browse` URL schemas under-specify                               | Low      | **Defer**                | Schema change is breaking; `z.url()` vs `z.string().min(1)` is style preference                                                                                                   |
| C7      | Dead `fetchFocus.ts` standalone module + misleading comment              | Low      | **Apply now (cleanup)**  | Delete module + clean comment in module-level doc                                                                                                                                 |
| A1      | Availability semantics split (3 modules)                                 | High     | **Defer (refactor)**     | Touches every tool + health + server. Risky without follow-up window                                                                                                              |
| A2      | `webSearch` bypasses passed config                                       | High     | **Defer (refactor)**     | Same risk profile as A1; test-only seam                                                                                                                                           |
| A3      | Page acquisition duplicated across 5+ paths                              | High     | **Defer (refactor)**     | Seismic refactor; deferred behind A1/A2                                                                                                                                           |
| A4      | Browser family locality shallow                                          | Medium   | **Defer**                | Do with next browser change                                                                                                                                                       |
| A5      | Registry hides pipeline behavior                                         | Medium   | **Defer**                | Do with next registry change                                                                                                                                                      |
| A6      | Server composition root knows too much per tool                          | Medium   | **Defer (with A1)**      | Same seam                                                                                                                                                                         |
| A7      | Deep research facade erases error modes                                  | Medium   | **Defer**                | Do with reliability work                                                                                                                                                          |
| A8      | Tests observe private server internals + permissive fetch mock           | Medium   | **Defer**                | Coupled with A1                                                                                                                                                                   |
| A9      | Docs describe removed `web_read`/nonexistent fallback                    | Low      | **Apply now (docs)**     | Low-risk doc fix; remove or correct references in `docs/quickstart.md:293`, `docs/mcp-quickstart.md:81, 172`                                                                      |
| R1      | `stripHtml` entity decode (already fixed in diff)                        | Fix      | **Verified**             | Diff at `agenticBrowse.ts:100-103` already corrects the no-op. F1 from RAG audit = done                                                                                           |
| R2      | `read` and `browse_and_present` byte-identical                           | Fix      | **Apply now**            | Delete `read` action; keep `browse_and_present` as canonical name. Update test `familyConsolidation.test.ts:43` and README diff. Avoid the alias-on-alias sprawl                  |
| R3      | `corpusCache.invalidateCorpus` variant key mismatch                      | Fix      | **Apply now**            | Multi-line edit; race condition; tests feasible                                                                                                                                   |
| R4      | `disarmJob` doesn't `clearTimeout(runtimeTimeout)`                       | Fix      | **Apply now**            | 4-line fix in `jobManager.ts:578-582`. Applies to `complete`/`fail`/`markCancelled`/`shutdown` paths                                                                              |
| R5      | Force-expire threshold compounds with extensions                         | Fix      | **Apply now**            | 1-line fix: `job.maxTimeMs * 2` → `job.originalMaxTimeMs * 2` at `jobManager.ts:615`                                                                                              |
| R6      | `discoverWithPass` plateau on pass 1                                     | Note     | **Defer (N)**            | Functionality exists; optimization, not bug                                                                                                                                       |
| R7      | `freshnessScore` future-dated = fresh                                    | Fix      | **Apply now**            | 2-line fix in `sourceRanking.ts:98-107`                                                                                                                                           |
| R8      | `crawlSeeds` JSDoc duplicate                                             | Note     | **Apply now (cosmetic)** | 1-line delete                                                                                                                                                                     |
| R9      | Dead `applyReranking` fallback branch                                    | Note     | **Defer**                | Dead code but not buggy; remove with R6 perf pass                                                                                                                                 |
| R10-R19 | Various notes (sync fs, byte counter, OAuth message, docStore bounds)    | Note     | **Defer**                | Notes, not fixes. Triage by follow-up                                                                                                                                             |

---

## (a) Apply Now — Fixes With Confined Blast Radius

### S1: SSRF guard IPv4-mapped IPv6 compressed loopback

- **File:** `src/httpGuards.ts:131-148`
- **What:** `::ffff:hhhh:hhhh` form. WHATWG URL normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`. Current code checks `inner.slice(7)` against dotted `isPrivateIPv4`, which rejects dotted input only.
- **Fix:** Extract IPv6-mapped IPv6 hex form, decode `hhhh:hhhh` to IPv4 octets, run `isPrivateIPv4`. Test cases per audit §1.
- **Risk:** Pure regex/normalization addition. Legitimate `[::ffff:a00:1]` still rejected (private). No false positives.
- **Validation:** Add `test/httpGuards/ssrfV6.test.ts` with the 4 vectors from audit §1.

### S3 (partial): Browser unguarded goto bypasses

- **Files:** `src/tools/families/browser.ts:813, 1143, 1450`
- **What:** `act` LLM-plan `navigate`, `tabs.new` with URL, `download` trigger `navigate` all call `page.goto(target)` with no `assertSafeUrl()`.
- **Fix:** Add `assertSafeUrl(target)` before each `goto`. Line 1643 already has the guard on `diff` action — apply same pattern.
- **Risk:** Browser is opt-in (`BROWSER_ENABLED=true`). If anyone is navigating to internal IPs intentionally, they hit the same guard as `browser.navigate` already does.
- **Defer:** The full route-interceptor (`page.route('**/*')`) and CDP-level guard is a deeper fix tied to S2 design.

### S4: Dashboard redaction deep-research + browser creds

- **File:** `src/config/manager.ts:17-32`
- **What:** `SECRET_LEAF_PATHS` lacks `deepResearch.apiToken` and any path under `browser.credentials.*`.
- **Fix:** Add `'deepResearch.apiToken'`. For credentials, replace fixed-path matching with a pattern check: any leaf where path includes `credentials` and key matches `/password|totp|secret/i`. Alternative: switch to `redactValue` matching `/password|secret|totp|apiKey|apiToken|token/i` on key names (broader; check with product).
- **Recommendation:** Start with explicit list — `deepResearch.apiToken`, plus the credential pattern — to keep blast radius narrow. Broader regex matching is a follow-up.
- **Validation:** Unit-test `getRedacted()` with populated `deepResearch.apiToken` and `browser.credentials.example.{password,totpSecret}`.

### S6: KG ingest unbounded response body

- **File:** `src/tools/families/knowledgeGraph.ts:279-285`
- **What:** `resp.text()` reads unbounded body after `assertSafeUrl()`.
- **Fix:** Replace with `safeResponseText(resp, content.value, 5 * 1024 * 1024)`. Already imported elsewhere in repo. Add content-type guard (`!text/html && !text/plain && !application/json` → reject).
- **Risk:** 5MB cap aligns with existing `safeResponseText` default behavior; LLM extraction already slices upstream.

### C1: health_check outputSchema without structuredContent

- **File:** `src/tools/standalone/healthCheck.ts:54-56`
- **What:** `outputSchema` declared at `:22-48`; `successResponse(makeResult(...))` returns text `content` only. SDK throws `Output validation error` at real MCP runtime (`mcp.js:196-198`).
- **Fix:** Either (A) drop `outputSchema` if MCP envelope-only is desired, or (B) add `structuredContent: report` to the return. **Recommend (B)** — explicit schema is part of the registered tool contract; pairing it with structured output is the correct fix.
- **Code:**
  ```ts
  const report = await runHealthProbes(cfg);
  const result = makeResult('health_check', report, Date.now() - start);
  return { ...successResponse(result), structuredContent: report };
  ```
- **Validation:** Need MCP-level call test (not direct `_registeredTools.handler`) — current suite uses the latter. Add `test/healthCheckOutputSchema.test.ts` that calls through the SDK transport.

### C2: fetch_focus compat alias

- **File:** New `src/tools/standalone/fetchFocusAlias.ts` OR extend `src/tools/standalone/fetchFocus.ts`
- **What:** Diff removes `fetch_focus` from `src/server.ts:14-21` and `src/server.ts:102-103`. Existing MCP clients calling `fetch_focus` get `Tool not found`. Internal agent strategy still uses the name as a string (`agentTools.ts:467`) — that is internal, not an MCP client.
- **Fix:** Add a deprecation alias that registers `fetch_focus` (only when Crawl4AI + LLM config present) and delegates to `fetchFocus()`. Add description note: "Deprecated: use agentic_browse.focus. Will be removed in next major release."
- **Risk:** Two MCP tool names mapping to same implementation. Low cost. Logged as deprecation in `health_check` for observability.
- **Note:** Audit's C7 (dead standalone module) flips meaning once alias is added — module is alive again. Delete becomes wrong if alias retained. **Decision: keep module, mark as alias, update header comment.**

### C3: web_crawl + browser gated from registration

- **Files:** `src/server.ts:77, 94-99`
- **What:** Diff moved `web_crawl` and `browser` to "register only if not gated." This violates family-tool contract (AGENTS.md §Architecture: family tools stay registered; unavailable actions return actionable errors).
- **For browser:** Already a family. `browserDisabledIssue` at `browser.ts:377-381` exists. Just remove the `gated.has('browser')` wrapper.
- **For web_crawl:** Standalone. Handler throws `unavailableError('crawl4ai sidecar is not configured...')` at `webCrawl.ts:86-89`. Just remove the `gated.has('web_crawl')` wrapper.
- **Test impact:** `test/familyConsolidation.test.ts` has `GATED_STANDALONE_TOOLS` set that includes `web_crawl`. Update test set or change expectations.
- **Risk:** Slightly noisier `tools/list` in default env. Operators see the tool; calling it returns a clear remediation error. Aligns with stated contract.

### C7: Dead `fetchFocus.ts` standalone — keep as alias (see C2 above)

- Once C2 lands, this finding is no longer "dead." Update module header comment to reflect alias role.

### A9: Doc references to removed `web_read`

- **Files:** `docs/quickstart.md:293`, `docs/mcp-quickstart.md:81, 172`, `docs/architecture.md:283-284`
- **What:** Docs still describe `web_read`. It was removed in commit `a766839` ("refactor: remove deprecated web_read tool and consolidate to web_crawl"). Docs not updated.
- **Fix:** Remove `web_read` rows. Add `agentic_browse` family line. Cross-reference `web_crawl` (which uses Readability per audit A9 note: `web_crawl` is gated but handler has Readability fallback in `crawlResultShaping.ts:readabilityFallbackResult`).
- **Risk:** Pure docs. No code impact.

### R2: read / browse_and_present duplicate

- **File:** `src/tools/families/agenticBrowse.ts:252-279` (the `read` action)
- **What:** Body is byte-identical to `browse_and_present` (`:225-251`). Both call `documentStore.set(...)`. Description for `read` says "one call" but so does `browse_and_present`. Surface bloat + schema validator switch bloat.
- **Fix:** Delete `readSchema` (`:145-156`) and the `read` action entry (`:253-279`). Update test `test/familyConsolidation.test.ts:43` FAMILY_TOOLS map: drop `read` from the `agentic_browse` action array. Drop `read` from the navigate/extract URL param block (`:182-198`).
- **Risk:** `read` was added in this very diff (per `git diff src/tools/families/agenticBrowse.ts`). No released client should depend on it. README at `:14` was updated to list `read` in this diff — drop from README too.
- **Tie-breaker:** Audit says "delete `read`, keep `browse_and_present`" OR "delete `browse_and_present`." README diff currently shows `read` in the doc list. README is the public contract. **Decision: delete `browse_and_present`** to match the public-facing README diff which advertises `read` as the surface name. This also matches the audit's "if `read` is the new preferred name (matches `agentic_browse.read` documented in `README.md:13`)" note.

### R3: corpusCache.invalidateCorpus variant key mismatch

- **File:** `src/utils/corpusCache.ts:998-1010`
- **What:** `getOrBuildCorpus` keys `pendingBuilds` with `stableStringify(normalizeSource(source)) + variantSuffix` where `variantSuffix = variant ? `|${variant}` : ''`. `invalidateCorpus` deletes only the no-variant key, missing variant builds.
- **Fix:** In `invalidateCorpus`, delete all keys starting with `stableStringify(normalizeSource(opts.source))` (both bare and `|variant`).
  ```ts
  if (opts?.source !== undefined) {
    const baseKey = stableStringify(normalizeSource(opts.source));
    pendingBuilds.delete(baseKey);
    for (const key of pendingBuilds.keys()) {
      if (key.startsWith(baseKey + '|')) pendingBuilds.delete(key);
    }
  }
  ```
- **Risk:** Narrow. Adds at most one Map iteration. Cancel-race window closes for variant builds.

### R4: disarmJob clearTimeout leak

- **File:** `src/research/jobManager.ts:578-582`
- **What:** `setTimeout` at `:561-566` fires up to `maxTimeMs` later (5–45 min). `disarmJob` clears `abortController` only. `extendRuntime` correctly clears at `:389`, so leaks are in `complete`/`fail`/`markCancelled`/`shutdown`.
- **Fix:**
  ```ts
  private disarmJob(job: InternalJob): void {
    if (job.runtimeTimeout) {
      clearTimeout(job.runtimeTimeout);
      job.runtimeTimeout = undefined;
    }
    job.abortController = undefined;
  }
  ```
- **Risk:** Comment at `:579-580` says "No separate runtime timer to clear" — comment is stale; fix the comment too.

### R5: Force-expire threshold compounds with extensions

- **File:** `src/research/jobManager.ts:611-615`
- **What:** `now - job.startedAt > Math.max(this.ttlMs, job.maxTimeMs * 2)`. After one extension to 2× original, threshold = 4× original. Should be invariant on `originalMaxTimeMs`.
- **Fix:** Change `job.maxTimeMs * 2` → `job.originalMaxTimeMs * 2` at `:615`.
- **Risk:** One identifier swap. Total-extension cap (`:372-375`) prevents unbounded extensions; the threshold was just protecting against never-extended stale jobs.

### R7: freshnessScore treats future dates as fresh

- **File:** `src/research/sourceRanking.ts:98-107`
- **What:** `days < 30` → 1.0. `days < 0` (future) still hits this branch.
- **Fix:** Add `if (days < 0) return 0.1;` before `if (days < 30) return 1.0;`. 0.1 is the lowest bucket (effectively demoted to stale).
- **Risk:** Future-dated parser/clock skew source is now visible as low-quality. Legitimate today/yesterday unchanged.

### R8: crawlSeeds JSDoc duplicated

- **File:** `src/tools/semanticCrawl.ts:894-896`
- **Fix:** Delete one of the duplicate doc lines.
- **Risk:** Cosmetic.

---

## (b) Defer — Risk Outweighs Benefit Without Planning

### S2: Redirects/DNS revalidation

- **Why defer:** Requires choosing between (a) `redirect: 'manual'` per fetch caller with manual `Location` revalidation + cap, or (b) Undici dispatcher with custom DNS hook + connect-time IP check. Browser path needs `page.route('**/*')` interceptor. Both touch code paths outside the audit's flagged scope. Decision belongs to a security/design pass, not a quick fix.
- **Mitigation in interim:** S3 partial fix (assertSafeUrl at unguarded goto sites) catches the most common attacker paths.

### S5: Query-key MCP auth default

- **Why defer:** Existing deployed instances may rely on `?key=` in MCP clients. Flipping default is breaking. Needs release note + opt-in window.
- **Recommendation:** Document and add a `MCP_REQUIRE_BEARER=true` env that deprecates query-key when set. Don't change default yet.
- **Same call:** Loopback vs `0.0.0.0` default — already bound `0.0.0.0`. Changing this is breaking for container/network deployments.

### S7: Browser cookie/session export gating

- **Why defer:** Behavior is current design. Isolated ephemeral context as default is a UX change. Document current exposure in security.md; gate behind flags in next major.

### S8: Sidecar URL guard + size cap

- **Why defer:** Only reachable via authenticated dashboard. Low risk; tag for follow-up.

### C4: Reddit OAuth status = healthy

- **Why defer:** The status flip is intentional (public JSON API is supported path). `message` retains the warning. Whether to add a `'healthy_with_caveats'` status or `caveats: string[]` is a product-level status taxonomy decision.
- **Suggestion:** Track in `health.ts` `ToolHealth` extension proposal.

### C5: Family SDK validation plain-text vs JSON envelope

- **Why defer:** Behavior is consistent with MCP SDK contract. Project envelope is only for runtime errors, not parse errors. Acceptable. If changed, would need a project-wide contract rewrite.

### C6: URL schemas under-specify

- **Why defer:** `z.url()` vs `z.string().min(1)` is style/debate. Behavior at runtime identical. Low risk to leave.

### A1–A8: Architectural refactors

- **Why defer:** Availability-kind refactor (A1), `WebSearchRuntime` seam (A2), `PageAcquisition` (A3), registry pipeline (A5), `ToolCatalog` (A6), `ToolOutcome` (A7), test seam (A8) all touch multiple modules and have blast radius beyond current diff. Recommend bundling into a single architecture-pass branch with test scaffolding first.
- **Triage order:** A1 (availability) and A2 (webSearch seam) first because they're pre-conditions for A3 and A6.

### R6, R9, R10–R19: Performance/notes

- **Why defer:** Not bugs. `discoverWithPass` pass-1 plateau (R6) is an optimization; dead `applyReranking` (R9) is dead code; sync fs (R10/R11), `Buffer.byteLength` (R12), `agenticBrowse.fetchPage` timeout (R13), freshness/pathDepth interaction (R14), `--pretty false` confusion (R15), Reddit gate comment (R16), Reddit status flip (R17), documentStore bounds (R18) are all flagged for future cleanup.
- **Document:** Roll into a single follow-up issue.

---

## (c) Product Owner Decisions Needed

### P1: fetch_focus alias retention

- **Question:** Keep `fetch_focus` as a deprecation alias (1 release window), or hard-remove?
- **Trade-off:** Alias = client compat. No alias = cleaner surface but any pinned-client breaks immediately.
- **Default recommendation:** Keep alias for one release, document migration in CHANGELOG, remove in next minor.

### P2: `read` vs `browse_and_present` canonical name

- **Question:** Audit and current README diff both mention `read`. The duplicate action body lives in this uncommitted diff. Either `read` (matches README) or `browse_and_present` (the older name).
- **Default recommendation:** Delete `browse_and_present`, keep `read`. Matches README diff and is the cleaner surface.

### P3: web_crawl / browser always-register contract

- **Question:** Audit says "always register family tools; surface runtime errors." Current diff hides both via `gated`. AGENTS.md §Architecture states this contract for families but not for standalone `web_crawl`.
- **Default recommendation:** Always register `web_crawl` and `browser` family. Add `web_crawl` to "always register" semantics; document that `web_crawl` is the only standalone with this contract. Confirms family contract.

### P4: Dashboard redaction — allowlist vs regex

- **Question:** Match secrets by explicit leaf list (current pattern + `deepResearch.apiToken`) or by regex on key name (`/password|secret|totp|apiKey|token/i`)?
- **Trade-off:** Explicit list is surgical, low false positives. Regex catches future additions but can over-redact (e.g., redact `countTokens`).
- **Default recommendation:** Explicit list for now. Track regex-based pattern in a follow-up.

### P5: Query-key auth default + bind interface

- **Question:** Should `MCP_ALLOW_QUERY_KEY` default to `false` in next major? Should HTTP server bind to loopback by default?
- **Trade-off:** Both are breaking for deployed instances. Operators may rely on remote HTTP access via query-string auth.
- **Default recommendation:** Document current exposure. Add `MCP_REQUIRE_BEARER=true` opt-in flag. Flip defaults at next major release (announce in CHANGELOG).

### P6: Reddit OAuth `healthy` vs `healthy_with_caveats` status

- **Question:** Add new `ToolHealth.status` value, or add `caveats: string[]` field?
- **Default recommendation:** Add `caveats: string[]` to `ToolHealth`. Backward-compatible. Existing `'healthy'` continues to mean "no caveats."

### P7: Browser surface deprecation — cookie export, user mode

- **Question:** Default-secure-isolated browser, or default-as-current (user mode if set, cookie export if set)?
- **Default recommendation:** Current behavior is OK if `BROWSER_ENABLED=false` by default (already true). Add explicit `BROWSER_ALLOW_COOKIE_EXPORT` and `BROWSER_ALLOW_USER_MODE` flags to make intent visible.

---

## Validation Plan For "Apply Now" Set

After fixes land, run:

```bash
npm run typecheck                                  # 0 errors
npm test                                            # ≥1699 pass (current baseline)
npm test -- test/httpGuards/                        # new S1 tests
npm test -- test/healthCheckOutputSchema.test.ts    # new C1 MCP-level test
npm test -- test/familyConsolidation.test.ts        # updated R2 + C3 expectations
npm test -- test/fetchFocusRegistration.test.ts     # updated C2 expectations
npm test -- test/corpusCache/invalidate.test.ts     # new R3 test
npm test -- test/research/jobManager.test.ts        # new R4/R5 tests
```

Expected: ≥ current 1699 passing + ~25 new. Existing 2 skipped unchanged.

Boot smoke:

```bash
node -e "import('./dist/src/server.js').catch(e => { console.error(e); process.exit(1); })"
```

---

## Risk-Tiered Apply Order

**Tier 1 — security (do first, smallest blast radius):**
S1 → S4 → S6 → S3 (partial) → R3 → R5 → R4 → R7

**Tier 2 — contracts (do after security, slightly broader):**
C1 → C2 → C3 → C7 → R2 → R8

**Tier 3 — cleanup:**
A9 → C7 module comment update

Each tier independently committable. Tier 1 fixes are user-owned diff lines + audit-cited spots. Tier 2 changes MCP-visible surface (test expectations, README). Tier 3 is docs + comment.

Do **not** batch with refactors (A1–A8) — keep that on a separate branch with its own validation window.
