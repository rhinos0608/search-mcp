# Design: HTTP Transport, Dashboard, and Tailscale Access (V6.0)

**Date:** 2026-05-12  
**Status:** Approved — ready for implementation planning  
**Scope:** Streamable HTTP transport, React dashboard, encrypted config management, ExternalAccessProvider abstraction with Tailscale support

---

## 1. Goal

Add opt-in HTTP/HTTPS connectivity to search-mcp so users can connect any device on their Tailscale network (or the public internet, with explicit confirmation) to the same MCP server that already runs over stdio. Add a browser-based dashboard for managing API keys, provider configuration, and external access — replacing manual `config.json` editing.

---

## 2. Architecture Overview

### 2.1 Process model

One process. Stdio and HTTP are separate transports backed by separate `McpServer` instances, both sharing the same **runtime services layer** (config manager, tool implementations, corpus cache, embeddings, etc.).

```
shared SearchMcpRuntime (config, tools, corpus cache, embeddings, ...)
        ↓                              ↓
  McpServer (stdio)             McpServer (HTTP)
  StdioServerTransport          StreamableHTTPServerTransport (per-session)
```

HTTP server starts only when `HTTP_PORT` env var is set. Unset = zero overhead, existing stdio behaviour fully preserved.

### 2.2 File layout

```
src/
  index.ts                     existing entry point — extended to start HTTP when HTTP_PORT set
  server.ts                    McpServer factory — extended to accept SearchMcpRuntime
  config/
    manager.ts                 NEW: ConfigManager class (live-reloadable, encrypted)
    types.ts                   NEW: SearchMcpConfig, RedactedConfig, ProviderTestResult, ConfigPatch
  server/
    http.ts                    NEW: HTTP server entry point (Node built-in http, no Express)
    mcp-transport.ts           NEW: StreamableHTTPServerTransport wrapper, session map
    dashboard-router.ts        NEW: static file serving + API route dispatch
    auth.ts                    NEW: SessionStore, requireSession, requireMcpKey
    access-provider.ts         NEW: ExternalAccessProvider types, resolveAccessProvider, buildMcpConnectionUrl, classifyRequestOrigin, normalizeBaseUrl
    tailscale.ts               NEW: TailscaleStatus, detectTailscale, getTailscaleServeCommands, getTailscaleFunnelCommands

dashboard/                     NEW: Vite + React app
  src/
    main.tsx
    App.tsx                    auth-state router: unauthenticated → Login, authenticated → Overview
    pages/
      Login.tsx
      Overview.tsx
      Providers.tsx
      Access.tsx
    api/
      client.ts                typed fetch wrappers — only file that calls /dashboard/api/*
  index.html
  vite.config.ts
  package.json

dist-dashboard/                Vite build output (gitignored; built in CI / npm run build:dashboard)
```

---

## 3. Config Manager

### 3.1 Responsibilities

Replaces the "load once at startup" pattern in `src/config.ts` with a live-reloadable, mutation-capable manager. It is the single source of truth for config at runtime.

### 3.2 Interface

```typescript
class ConfigManager {
  load(): void
  // Decrypt config.enc using SEARCH_MCP_CONFIG_KEY → store in memory only.
  // If config.enc does not exist: generate fresh config + new MCP API key,
  // write config.enc, print mcpApiKey to stderr once ("First run: save this key").
  // If SEARCH_MCP_CONFIG_KEY not set and config.enc exists: throw, refuse to start.

  get(): Readonly<SearchMcpConfig>
  // Read-only in-memory config. Used by tool runtime.

  getRedacted(): RedactedConfig
  // Full config shape with secret fields replaced by "•••".
  // Used exclusively by dashboard API responses.

  update(patch: ConfigPatch): void
  // Apply typed patch → re-encrypt → write config.enc atomically.
  // normalizeBaseUrl() validated at this boundary, not at read time.

  testConnection(provider: string): Promise<ProviderTestResult>
  // Live connectivity check per provider (cheap: 1-result search, /health ping, etc.)

  rotateApiKey(): string
  // Generate new MCP API key, update config + re-encrypt. Returns new key (shown once).
}
```

### 3.3 Patch semantics

The dashboard never sends raw secret values back for unchanged fields. Patch uses a typed discriminated union per field:

```typescript
type FieldPatch =
  | { op: 'keep' }                // leave existing value unchanged
  | { op: 'set'; value: string }  // replace with new value
  | { op: 'clear' }               // remove / empty the field

type ConfigPatch = Partial<Record<keyof SearchMcpConfig, FieldPatch | DeepFieldPatch>>
```

The UI sentinel `"•••"` is a display-only convention. It is never sent in API requests. The dashboard maps masked fields to `{ op: 'keep' }` on save.

### 3.4 First-run behaviour

```
config.enc absent:
  → generate mcpApiKey = crypto.randomBytes(32).toString('base64url')
  → write initial config.enc with defaults
  → logger.warn({ mcpApiKey }, 'First run: MCP API key generated — save this, it will not be shown again')
  → key printed to stderr only (stdout reserved for JSON-RPC)

config.enc present, SEARCH_MCP_CONFIG_KEY absent:
  → throw ConfigKeyMissingError, server refuses to start
```

---

## 4. HTTP Server

### 4.1 Entry point (`src/server/http.ts`)

Called from `index.ts` when `HTTP_PORT` is set. Uses Node's built-in `http` module — no Express dependency.

```typescript
async function startHttpServer(runtime: SearchMcpRuntime, port: number): Promise<void>
```

### 4.2 Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/mcp` | MCP API key (Bearer) | MCP JSON-RPC (StreamableHTTP) |
| `GET` | `/mcp` | MCP API key (Bearer) | MCP server→client streaming |
| `DELETE` | `/mcp` | MCP API key (Bearer) | Session cleanup |
| `GET` | `/dashboard` | — | Serves `dist-dashboard/index.html` (auth-state routing in React) |
| `GET` | `/dashboard/*` | — | Serves `dist-dashboard/` static assets |
| `POST` | `/dashboard/api/login` | — | Validates MCP API key, sets session cookie |
| `POST` | `/dashboard/api/logout` | Session cookie | Revokes session |
| `GET` | `/dashboard/api/session` | Session cookie | `{ authenticated: boolean }` |
| `GET` | `/dashboard/api/config/status` | Session cookie | Provider health summary (redacted) |
| `GET` | `/dashboard/api/providers` | Session cookie | Provider list + configured/unconfigured status |
| `POST` | `/dashboard/api/config/update` | Session cookie | Apply `ConfigPatch` → re-encrypt |
| `POST` | `/dashboard/api/config/test-connection` | Session cookie | Live connectivity check per provider |
| `GET` | `/dashboard/api/access` | Session cookie | Current `ExternalAccessProvider` state |
| `POST` | `/dashboard/api/access/update` | Session cookie | Update access provider config |

**Important:** `exposeDashboardExternally` enforcement applies to all `/dashboard/*` routes including API routes. Public/unknown origins receive `404` (not `403`) when dashboard is not externally exposed.

### 4.3 MCP key auth

Default: `Authorization: Bearer <key>` header, validated with `crypto.timingSafeEqual`.

Optional query-param fallback: enabled only when `MCP_ALLOW_QUERY_KEY=true`. Server logs a startup warning when enabled (query params may leak into logs, proxies, browser history).

### 4.4 Session-scoped MCP transport

Each `Mcp-Session-Id` gets its own `StreamableHTTPServerTransport` instance, stored in a `Map<sessionId, transport>`. Sessions cleaned up on `DELETE /mcp` or TTL expiry. Transport abstraction:

```typescript
transport: 'streamable-http' | 'sse-legacy'  // only streamable-http implemented in v1
```

---

## 5. Auth

### 5.1 Session store

```typescript
interface Session {
  id: string        // crypto.randomUUID()
  createdAt: number
  expiresAt: number // configurable via SESSION_TTL_HOURS, default 12h
}

class SessionStore {
  create(): Session
  validate(id: string): boolean
  revoke(id: string): void
  pruneExpired(): void  // setInterval every 5m
}
```

### 5.2 Cookie

```
Set-Cookie: __Host-smcp-session=<id>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<TTL>
```

`__Host-` prefix enforced when over HTTPS (browser enforces `Secure`, `Path=/`, no `Domain`). Downgraded to unprefixed cookie on plain HTTP localhost for dev ergonomics.

### 5.3 Login endpoint

```
POST /dashboard/api/login
  body: { apiKey: string }
  → crypto.timingSafeEqual(apiKey, config.mcpApiKey)
  → on success: SessionStore.create() → Set-Cookie → 200
  → on fail: 401 after fixed 500ms delay (brute-force mitigation)
  → after 10 consecutive failures from same IP: 429 for 15 minutes
```

### 5.4 Credential model

One admin secret: the MCP API key. It gates both MCP connections (`Authorization: Bearer`) and dashboard login (`POST /dashboard/api/login`). After login, dashboard uses a session cookie — the key is never stored in browser state after the login POST completes.

**Key rotation UX:** Rotation invalidates all existing MCP clients and dashboard sessions. Dashboard shows new key once after rotation with copy button and explicit warning. Key is not placed in any URL.

**V2 note:** Splitting MCP key vs admin key (separate roles for "connect tools" vs "manage config") deferred until public exposure is common.

---

## 6. ExternalAccessProvider

### 6.1 Types

```typescript
type ExternalAccessProviderType = 'localhost' | 'manual' | 'tailscale'

type ProviderStatus =
  | 'active'
  | 'configured_unverified'
  | 'detected_mismatch'
  | 'unconfigured'
  | 'unavailable'

type ProviderReason =
  | 'tailscale_not_installed' | 'daemon_unreachable'
  | 'serve_not_detected' | 'funnel_not_detected'
  | 'manual_url_missing' | 'hostname_missing' | 'port_mismatch'
  | 'trusted_proxy_header_unverified' | 'public_dashboard_disabled'
  | 'funnel_public_mcp_only' | 'tailscale_header_missing'
  | 'tailscale_header_untrusted' | 'dashboard_exposure_disabled'

type Visibility = 'loopback' | 'tailnet' | 'public' | 'custom'

interface ExternalAccessProvider {
  type: ExternalAccessProviderType
  baseUrl: string
  mcpUrl: string            // baseUrl + /mcp (normalised)
  dashboardUrl: string      // baseUrl + /dashboard
  visibility: Visibility
  status: ProviderStatus
  authRequired: true        // assigned by resolver only, never from config input
  reason?: ProviderReason
  warnings?: string[]       // e.g. ["Funnel active: endpoint is publicly reachable"]
}
```

### 6.2 Config shape (`access` block)

```typescript
access: {
  provider: 'localhost' | 'manual' | 'tailscale'
  manualBaseUrl?: string
  manualVisibility?: Visibility | 'unknown'  // resolver maps 'unknown' → 'custom' + warning
  exposeDashboardExternally: boolean          // default false
  tailscale: {
    serveConfigured: boolean         // user intent: "I ran the serve command"
    funnelConfigured: boolean        // user intent: "I enabled funnel"
    allowDashboardOverFunnel: boolean // default false; explicit opt-in to expose /dashboard publicly
  }
}
```

### 6.3 Request origin classification

```typescript
function classifyRequestOrigin(req, config): 'loopback' | 'tailscale_serve' | 'public' | 'unknown'
```

Single choke point for all exposure decisions. Tailscale proxy headers (`X-Tailscale-User`, etc.) are trusted **only** when `classifyRequestOrigin` returns `tailscale_serve` — meaning the immediate peer is the loopback Tailscale Serve proxy. Client-supplied Tailscale headers on public/manual/unknown origins are ignored entirely.

**Default dashboard access:**
- Allowed: `loopback`, `tailscale_serve`
- Denied (404): `public`, `unknown`
- `allowDashboardOverFunnel = true` opens the `public` case only for Funnel-confirmed deployments

### 6.4 Base URL normalisation

`normalizeBaseUrl(input): string` — runs at config-write time (in `ConfigManager.update()`):
- Must be `http:` or `https:`
- No username/password
- No query string or fragment
- Path must be empty or `/` (rejects `https://example.com/mcp` as a base URL)
- Trailing slash stripped
- Error returned to dashboard immediately on invalid input

### 6.5 MCP URL helper

```typescript
function buildMcpConnectionUrl(provider: ExternalAccessProvider): string
// Returns `${provider.baseUrl}/mcp` — dumb and deterministic, no auth/config knowledge
```

Displayed in dashboard as masked field with copy button. Permanent warning shown when `visibility === 'public'`:
> "Do not paste into untrusted clients. The URL identifies a reachable MCP endpoint."

---

## 7. Tailscale Integration

### 7.1 Detection strategy (capability-based)

```typescript
interface TailscaleStatus {
  detected: boolean
  reason?: string           // for logs/UI, not machine-parsed
  version?: string
  hostname?: string
  magicDnsName?: string
  selfIp?: string
  serveActive?: boolean
  funnelActive?: boolean
  serveTarget?: string
  funnelTarget?: string
  inspectedVia: 'localapi' | 'cli' | 'none'
}
```

Detection order (graceful fallback at each step, never throws):
1. Tailscale LocalAPI socket (location varies: `/var/run/tailscale/tailscaled.sock` on Linux; macOS path depends on GUI vs CLI vs sandboxed install — probed, not hardcoded)
2. `tailscale status --json` CLI invocation
3. `tailscale serve status` for serve/funnel state (version-gated)
4. Return `{ detected: false, inspectedVia: 'none' }` with human-readable `reason`

### 7.2 Command generation (isolated, version-aware)

```typescript
function getTailscaleServeCommands(port: number, version?: string): string[]
function getTailscaleFunnelCommands(port: number, version?: string): string[]
```

CLI syntax changed at client 1.52. These functions are the **only** place that encodes version-specific syntax. Dashboard displays the output — it has no knowledge of Tailscale CLI versions.

### 7.3 Dashboard Access page states

| Detected state | Configured state | UI shown |
|---|---|---|
| `localhost` | — | `http://localhost:<port>/mcp` |
| Tailscale detected, serve not configured | `serveConfigured: false` | Hostname if known; "Configure Serve" → versioned CLI command + copy + "I configured it" |
| `serveActive: true` | `serveConfigured: true` | `https://<hostname>/mcp`, visibility: tailnet |
| `serveActive: false` | `serveConfigured: true` | Warning: "Configured but not detected" + "Show command again" + "Re-check" |
| `funnelActive: true` | `funnelConfigured: true` | Permanent public-visibility warning banner |
| `funnelActive: false` | `funnelConfigured: true` | Mismatch warning; does not claim public access is live |

### 7.4 Funnel confirmation

"Enable Funnel" button shown only when `serveConfigured: true`. Requires typing `enable funnel` in a modal:

> _"Funnel exposes this MCP server to the public internet. Tailscale identity no longer limits who can reach the endpoint. Anyone with the URL and a valid MCP API key can connect. The dashboard will remain inaccessible externally unless you also enable `allowDashboardOverFunnel`. Continue?"_

---

## 8. Dashboard UI

### 8.1 Routing

`/dashboard` performs client-side auth-state routing:
- Unauthenticated → renders `Login.tsx`
- Authenticated → renders `Overview.tsx`

Bookmarks and refreshes land correctly. No server-side redirect.

### 8.2 Pages

**Login**
- Single MCP API key field
- Rate-limit feedback shown after 3 failures
- On success: transition to Overview

**Overview**
- MCP connection URL: masked field, copy button, permanent `visibility === 'public'` warning
- Provider health grid: `ok / error / unconfigured` per provider with latency badge
- Active MCP session count
- Server version + uptime
- "Rotate API key" button → confirmation modal → new key shown once with copy button

**Providers**
- One card per provider group (Search, Crawl, Embeddings, Social, Research, Specialist, Browser, Deep Research)
- Configured/unconfigured badge per card
- Edit expander: fields shown masked as `•••`; editing replaces value on save; blank = `{ op: 'keep' }`; explicit "Clear" control = `{ op: 'clear' }`
- "Test connection" button per provider → inline latency or error result
- Save sends typed `ConfigPatch` — never raw `"•••"` strings

**Access**
- Provider selector: `localhost | manual | tailscale`
- `classifyRequestOrigin` result shown for current request
- Tailscale sub-panel (when selected): full state table per §7.3, versioned CLI commands, Funnel confirmation gate, `allowDashboardOverFunnel` toggle (disabled until Funnel confirmed)
- Manual sub-panel: base URL input → `normalizeBaseUrl` validated on blur, error inline before save
- MCP URL preview: masked, copy button

### 8.3 UI conventions

- Secret fields: masked by default, no reveal button (replace-not-reveal contract throughout)
- Destructive actions (rotate key, enable funnel, clear a field): always behind confirmation modal
- All API errors surfaced inline; no page navigations for errors
- No state stored in URL (no keys, no tokens, no config in query params)
- `dashboard/src/api/client.ts` is the **only** file that calls `/dashboard/api/*`

---

## 9. Build & Deployment

### 9.1 Build

```bash
npm run build:dashboard   # cd dashboard && vite build → dist-dashboard/
npm run build             # tsc → dist/ (MCP server, unchanged)
npm run build:all         # both
```

`dist-dashboard/` is gitignored. In CI/Docker: build step runs before image packaging.

### 9.2 Docker Compose changes

```yaml
search-mcp:
  environment:
    - HTTP_PORT=8050
    - SEARCH_MCP_CONFIG_KEY=${SEARCH_MCP_CONFIG_KEY}
    - SESSION_TTL_HOURS=12          # optional
    - MCP_ALLOW_QUERY_KEY=false     # default; query-param auth opt-in
```

### 9.3 New env vars

| Var | Default | Description |
|---|---|---|
| `HTTP_PORT` | unset | Enables HTTP server when set |
| `SESSION_TTL_HOURS` | `12` | Dashboard session lifetime |
| `MCP_ALLOW_QUERY_KEY` | `false` | Enable `?key=` query-param auth (logs warning) |
| `TAILSCALE_LOCALAPI_SOCKET` | auto-probed | Override LocalAPI socket path |

---

## 10. Security Notes

- Decrypted config lives only in process memory; never written to disk in plaintext
- `getRedacted()` is the only config view exposed to the dashboard API
- `authRequired: true` is assigned by `resolveAccessProvider()` only — never accepted from config or external input
- All timing-sensitive comparisons use `crypto.timingSafeEqual`
- `__Host-` cookie prefix enforced on HTTPS; prevents subdomain fixation
- `/dashboard` 404s on all sub-routes and API routes for disallowed origins (not just the HTML entrypoint)
- Tailscale proxy headers trusted only when `classifyRequestOrigin` returns `tailscale_serve`
- `normalizeBaseUrl` rejects paths, query strings, fragments, and embedded credentials at config-write time
- `MCP_ALLOW_QUERY_KEY=true` logs a startup warning; recommended only for legacy client compatibility

---

## 11. Implementation Invariants

These are hard requirements that must hold for every line of implementation. They are not defaults or conventions — violations are bugs.

1. **`SEARCH_MCP_CONFIG_KEY` is always required.** The server never generates or stores the encryption key. If the env var is absent and `config.enc` exists, the server refuses to start with a clear error. First-run generates a fresh config and MCP API key but still requires the operator to have set `SEARCH_MCP_CONFIG_KEY` before starting.

2. **Versioned authenticated encryption envelope.** `config.enc` uses AES-256-GCM with a per-write random salt and nonce. The key is derived from `SEARCH_MCP_CONFIG_KEY` via scrypt. The envelope includes a version byte so the format can evolve without breaking old files.

3. **Mutable-config allowlist.** `ConfigManager.update()` rejects unknown keys and validates patches against an explicit allowlist of mutable fields. No arbitrary key injection via the dashboard API.

4. **`ExternalAccessProvider` is read-only derived state.** The resolver computes it from config + runtime detection. `/dashboard/api/access/update` accepts only a typed `AccessConfigPatch` — never resolver output or raw provider objects as input.

5. **Dashboard exposure checks are first.** They run before static asset serving, the React index.html fallback, and any API dispatch for every `/dashboard/*` request. No partial exposure by route ordering.

6. **Proxy headers are never speculatively trusted.** Tailscale and other proxy headers are only treated as authoritative after `classifyRequestOrigin` confirms the immediate peer is a trusted local proxy via socket-level origin checks. Client-supplied headers on public/unknown origins are silently ignored.

7. **Dashboard POST APIs require both session cookie and same-origin validation.** Where the `Origin` header is present, it is validated against the expected host before processing. Applies to all state-mutating dashboard routes.

8. **Request bodies have explicit size limits.** All POST bodies are capped (e.g. 64KB for config patches, 1KB for login). Requests exceeding the limit receive 413 before any parsing occurs.

9. **Missing dashboard build assets do not affect `/mcp`.** If `dist-dashboard/` is absent or incomplete, `/dashboard` returns 503 with a clear message. The MCP transport continues operating normally.

10. **Key rotation has defined session/transport teardown policy.** Rotation closes all active HTTP MCP transport sessions and revokes all dashboard sessions. The rotation response documents this behaviour explicitly so callers are not surprised.

11. **Logs never contain secrets.** `Authorization` headers, session cookie values, raw config patches, and URLs containing query-param keys are never logged. The logger must strip or omit these fields at the call site, not rely on post-hoc redaction.

---

## 12. Out of Scope (V1)

- SSE legacy transport (transport abstraction is in place; implement when a real client requires it)
- Separate MCP key vs admin key (deferred to V2 when public exposure is common)
- Machine-derived key provider (B from brainstorming — optional convenience, not a separate encryption system)
- Cloudflare Tunnel / ngrok as managed providers (use `manual` + `visibility: 'public'` in the interim)
- Multi-user access or role-based permissions
