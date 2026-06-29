# Security audit findings

Scope: `/Users/rhinesharar/search-mcp`. Current dirty diff reviewed. No files modified except this report.

## 1. High — SSRF guard misses IPv4-mapped IPv6 compressed loopback

**Evidence:** `assertSafeUrl()` only blocks bracketed IPv6 loopback/private prefixes and only decodes IPv4-mapped addresses when inner text starts `::ffff:` then contains dotted IPv4 (`src/httpGuards.ts:95-110`, `src/httpGuards.ts:131-147`). WHATWG URL normalizes `http://[::ffff:127.0.0.1]/` to hostname `[::ffff:7f00:1]`; code then sets `ipv4 = '7f00:1'`, `isPrivateIPv4()` returns false.

**Exploit/impact:** Any tool calling `assertSafeUrl()` can be pointed at `http://[::ffff:7f00:1]:PORT/` to reach loopback services. Affects direct fetch/read/crawl/KG/browser paths using shared guard.

**Smallest safe fix:** Replace ad-hoc IP parsing with `ipaddr.js`/Node `net.isIP` plus IPv6 mapped conversion, or explicitly parse `::ffff:hhhh:hhhh` into IPv4 and block private/loopback/link-local.

**Validation:** Unit-test `assertSafeUrl()` rejects `http://[::ffff:127.0.0.1]/`, `http://[::ffff:7f00:1]/`, `http://[::ffff:0a00:0001]/`, `http://[::ffff:c0a8:0001]/`.

## 2. High — Redirects and DNS resolution not revalidated after SSRF precheck

**Evidence:** Guard comments note domain checks are best-effort and callers should validate after resolution (`src/httpGuards.ts:86-89`), but direct fetch paths call `fetch()` with default redirect-following after one precheck: `agentic_browse.fetchPage()` (`src/tools/families/agenticBrowse.ts:49-64`), KG ingest URL fetch (`src/tools/families/knowledgeGraph.ts:279-284`). Browser `navigate` checks only requested URL before `page.goto()` (`src/tools/families/browser.ts:562-565`).

**Exploit/impact:** Attacker controls public URL that 302s to `http://127.0.0.1:...`, cloud metadata, or private admin panels. Server/browser follows redirect and returns/extracts internal content. DNS rebinding can pass hostname check then resolve to private IP at connect time.

**Smallest safe fix:** For Node fetch callers, use `redirect: 'manual'`, validate each `Location`, cap redirects, and validate `response.url`. Add custom DNS/connect guard (Undici dispatcher) rejecting resolved private/loopback/link-local/metadata IPs. For browser, wrap `page.goto()` in `safeGoto()` plus route/request interception that aborts private-IP and metadata targets.

**Validation:** Integration test with local public test server returning 302 to `http://127.0.0.1:<port>/secret`; all read/crawl/KG/browser paths must fail before contacting secret server.

## 3. High — Browser navigation has unguarded `page.goto()` paths

**Evidence:** Main `browser.navigate` checks URL (`src/tools/families/browser.ts:562-565`), but other paths do not: LLM-planned `act` navigate uses `page.goto(target)` with no guard (`src/tools/families/browser.ts:812-814`), `tabs.new` navigates optional URL directly (`src/tools/families/browser.ts:1140-1144`), and download trigger navigate does same (`src/tools/families/browser.ts:1447-1451`). Dirty diff now gates browser registration on config (`src/server.ts:94-99`), but once enabled these bypasses remain.

**Exploit/impact:** Remote MCP caller or compromised LLM planning can navigate browser to internal services and then use `snapshot`, `evaluate`, `extract`, `screenshot`, `storage`, or network tools to read results. In `user` mode, browser connects to user default context preserving sessions (`src/browser/browserManager.ts:371-382`), raising impact.

**Smallest safe fix:** Create single `safeGoto(page, url, opts)` used by every browser action; validate before and after navigation; block private/metadata requests through `page.route('**/*')`; validate LLM-planned navigation targets before execution.

**Validation:** Tests for `browser.tabs {op:'new', url:'http://127.0.0.1'}`, `browser.download` navigate trigger, and `browser.act` with mock plan `{action:'navigate', target:'http://127.0.0.1'}` all return SSRF_BLOCKED.

## 4. High — Dashboard redaction omits deep-research token and browser credentials

**Evidence:** Redacted dashboard config only hides fixed paths: `mcpApiKey`, provider keys, `llm.apiToken`, etc. (`src/config/manager.ts:17-32`). It does not include `deepResearch.apiToken` or nested `browser.credentials.*.password/totpSecret`. Config loads both (`src/config.ts:1116-1119`, `src/config.ts:1171-1174`). Authenticated dashboard `/dashboard/api/config/status` returns `configManager.getRedacted()` (`src/server/dashboard-router.ts:328-330`).

**Exploit/impact:** Any dashboard session can retrieve deep research API token and browser stored login passwords/TOTP secrets in cleartext. If query-param auth leaks or dashboard exposed, compromise expands to third-party LLM account and site credentials.

**Smallest safe fix:** Add `deepResearch.apiToken`; recursively redact keys matching `/apiKey|token|secret|password|totp/i`, including values under `browser.credentials`. Prefer allowlist response model for dashboard config rather than full config clone.

**Validation:** Unit-test `getRedacted()` with populated `deepResearch.apiToken` and `browser.credentials.example.{password,totpSecret}`; assert no raw secret substrings appear in serialized output.

## 5. Medium — Query-param MCP auth enabled by default on `0.0.0.0`

**Evidence:** `/mcp` accepts `?key=` unless `MCP_ALLOW_QUERY_KEY=false` (`src/server/http.ts:39-43`). Startup logs say query-param auth is enabled by default (`src/server/http.ts:52-55`). HTTP server listens on all interfaces (`src/server/http.ts:153-154`).

**Exploit/impact:** API key in URLs leaks via browser history, reverse-proxy/access logs, Referer headers, screenshots, and support bundles. With `/mcp` bound to all interfaces, leaked key grants full MCP tool access.

**Smallest safe fix:** Default `MCP_ALLOW_QUERY_KEY=false`; require `Authorization: Bearer`; bind loopback by default and require explicit env/config for `0.0.0.0`. If query auth retained, accept only in setup/dev mode.

**Validation:** HTTP auth tests: no env => `GET /mcp?key=<valid>` returns 401; `Authorization: Bearer <valid>` succeeds. Startup log should not warn query auth enabled by default.

## 6. Medium — Knowledge-graph URL ingest reads unbounded response body

**Evidence:** KG ingest URL path validates URL then calls `fetch(content.value)` and `resp.text()` directly (`src/tools/families/knowledgeGraph.ts:279-284`). Schema caps only input string length (`content.value`) at 1,000,000 chars (`src/tools/families/knowledgeGraph.ts:49-52`), not fetched body size. Other code has `safeResponseText()` size enforcement (`src/httpGuards.ts:158-203`).

**Exploit/impact:** Attacker supplies URL returning very large/chunked body. Process buffers entire response before LLM extraction, causing memory exhaustion or long-running ingestion.

**Smallest safe fix:** Use `safeResponseText(resp, content.value, maxBytes)` with KG-specific cap (for example 1-5 MB), require text content-type, and truncate before extraction.

**Validation:** Test URL streams > cap without Content-Length; `knowledge_graph.ingest` must abort with size-limit error and process RSS stays bounded.

## 7. Medium — Browser cookie/session export too broad for exposed deployments

**Evidence:** `browser.storage list-cookies` returns all cookies from current context (`src/tools/families/browser.ts:1051-1053`). `user` mode attaches to existing Chrome default context and preserves user sessions (`src/browser/browserManager.ts:371-382`). `profile` mode persists cookies/localStorage (`src/browser/browserManager.ts:409-412`).

**Exploit/impact:** If HTTP MCP key leaks or browser tool is exposed to non-local users, attacker can exfiltrate authenticated site cookies and local browser sessions, not just automate pages.

**Smallest safe fix:** Gate `storage.list-cookies`, `storage.save/restore`, `user` mode, and `profile` mode behind separate explicit env flags such as `BROWSER_ALLOW_USER_PROFILE=true` and `BROWSER_ALLOW_COOKIE_EXPORT=true`; default to isolated ephemeral context. Redact cookie values unless export flag enabled.

**Validation:** With `BROWSER_ENABLED=true` but no extra flags, `browser.storage {op:'list-cookies'}` and `browser.session {mode:'user'}` return permission errors; isolated `navigate/snapshot` still work.

## 8. Low — Operator-configured sidecar health probes lack URL guard and response cap

**Evidence:** Dashboard provider tests fetch configured `searxng.baseUrl` and `crawl4ai.baseUrl` directly (`src/config/manager.ts:317-327`). Validation only checks URL starts with `http://` or `https://` for selected URL fields (`src/config/manager.ts:163-183`).

**Exploit/impact:** Authenticated dashboard user can make server probe arbitrary internal URLs on fixed paths and receive timing/status/error text. Malicious or compromised sidecar can return very large JSON/error responses and consume memory.

**Smallest safe fix:** Validate operator URLs with `assertSafeUrl(url, true)` while still blocking cloud metadata; normalize base URLs; use `safeResponseJson/Text()` with small caps for health/test endpoints.

**Validation:** Config test-connection to `http://169.254.169.254` or metadata host must fail before network. Mock sidecar returning > cap JSON must fail with size-limit error.
