# CDP Browser Control — Specification

## Overview

Add Chrome DevTools Protocol (CDP) browser control to search-mcp as two deliverables:

1. **`browser` MCP tool family** — standalone interactive browser control via Playwright + CDP
2. **Deep research CDP integration** — orchestrator can navigate login walls, paginated SPAs, and interactive flows

Competitors (Firecrawl MCP, Playwright MCP, Browserbase MCP) have moved beyond read-only scraping into full browser control. This spec defines how search-mcp catches up while maintaining its self-hosted, zero-cloud-dependency philosophy.

---

## Competitive Analysis

| Feature | Firecrawl MCP | Playwright MCP (MS) | Browserbase MCP | **search-mcp target** |
|---|---|---|---|---|
| Engine | Chrome CDP (cloud) | Playwright (local) | Stagehand+CDP (cloud) | Playwright (local) + CDP endpoint |
| Transport | cloud HTTP | STDIO / SSE | SHTTP (hosted) | STDIO (existing) + optional SSE |
| Session model | TTL 30-3600s | Persistent profile | Session lifecycle | Isolated + persistent profiles |
| Element targeting | NL prompts | Accessibility tree refs | NL commands | Accessibility tree refs (Playwright) |
| Auth handling | Manual action chain | Manual + storage state | Manual | Manual + storage state save/restore |
| Stealth | Proxy + anti-bot | Launch flags + init scripts | Advanced stealth (Scale) | 3-layer: flags + init-script patches + rebrowser (CDP leak fix) |
| Pricing | 2 credits/min | Free (OSS) | Free tier → Scale | Free (OSS, self-hosted) |
| Screenshots | Yes | Yes | Yes | Yes |
| JS execution | Yes | Yes | Via act | Yes (evaluate) |
| Network interception | No | Yes (route) | No | Yes (route) |
| Tab management | No | Yes | No | Yes |
| Form filling | NL | Structured + NL | NL | Structured (primary) + NL (optional) |
| PDF generation | Yes | Yes (opt-in) | No | Yes |
| Deep research aware | No | No | No | **Yes — key differentiator** |

**Key insight**: Playwright MCP is the dominant OSS solution (32k stars). Our differentiator: deep integration with the deep research orchestrator so interactive browser sessions become first-class research primitives — not just standalone automation.

---

## Deliverable 1: `browser` Tool Family

### Registration

```
Family: "browser"
Actions: navigate | snapshot | click | type | evaluate | screenshot |
         extract | act | wait | pdf | storage | network | tabs | session
```

Follows existing `registerFamily()` pattern in `src/tools/registry.ts`. Each action has its own Zod schema and handler.

### Architecture

```
MCP Client
    │
    ▼
┌──────────────────────────────────────┐
│  src/tools/families/browser.ts       │  ← Tool family registration
│  (action dispatch, schema validation) │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  src/browser/                         │  ← NEW module
│  ├── browserManager.ts               │     Browser lifecycle (launch/connect/close)
│  ├── session.ts                       │     Session state (cookies, storage, profiles)
│  ├── snapshot.ts                      │     Accessibility tree snapshots
│  ├── actions.ts                       │     Click, type, select, hover, drag
│  ├── extraction.ts                    │     Structured data extraction
│  ├── network.ts                       │     Route, intercept, monitor
│  ├── stealth.ts                       │     Anti-detection (flags, init-scripts, rebrowser)
│  ├── cdp.ts                           │     Raw CDP session access via CDPSession
│  └── types.ts                         │     Browser-specific types
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Playwright (npm: playwright-core)            │  ← Primary abstraction
│  ├── page.context().newCDPSession(page)       │     Raw CDP when needed
│  ├── rebrowser-playwright (optional)          │     CDP leak patched fork
│  └── Chromium (@playwright/browser-chromium)  │     On-demand download
│  + optional CDP endpoint connection           │
└──────────────────────────────────────────────┘
```

**Dual API access**: Playwright provides the high-level API (navigation, accessibility tree, locators, network routing). When raw CDP is needed (performance metrics, advanced network control, security audits), `page.context().newCDPSession(page)` exposes the full Chrome DevTools Protocol. This gives us the best of both: Playwright's reliability and CDP's power without maintaining a separate CDP client library.

### Actions Detail

#### `navigate`
Navigate to a URL. Supports waitUntil states (load, domcontentloaded, networkidle).

```ts
{
  action: "navigate",
  url: string,
  waitUntil?: "load" | "domcontentloaded" | "networkidle",
  timeout?: number
}
```

#### `snapshot`
Capture accessibility tree snapshot of current page. Returns structured element tree with stable refs for subsequent actions. This is the primary "observation" primitive.

```ts
{
  action: "snapshot",
  selector?: string,       // scope to element
  depth?: number,          // tree depth limit
  includeHidden?: boolean
}
// Returns: accessibility tree with { role, name, ref, children, value, ... }
```

#### `click`
Click an element by accessibility ref, CSS selector, or text.

```ts
{
  action: "click",
  target: string,          // ref (e.g. "e42"), selector, or text
  button?: "left" | "right" | "middle",
  doubleClick?: boolean,
  modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[]
}
```

#### `type`
Type text into an editable element.

```ts
{
  action: "type",
  target: string,
  text: string,
  submit?: boolean,        // press Enter after
  slowly?: boolean         // character-by-character vs fill
}
```

#### `evaluate`
Execute arbitrary JavaScript in the page context. Returns JSON-serializable result.

```ts
{
  action: "evaluate",
  expression: string,      // e.g. "document.title" or "() => { return {...} }"
  target?: string          // scope to element (passed as argument)
}
```

#### `screenshot`
Capture a screenshot of the page or element.

```ts
{
  action: "screenshot",
  target?: string,         // element ref or selector
  fullPage?: boolean,
  type?: "png" | "jpeg",
  quality?: number         // 0-100 for jpeg
}
// Returns: base64 image or writes to file
```

#### `extract`
Extract structured data using a schema or natural language instruction. Uses the existing `extractionConfig` infrastructure.

```ts
{
  action: "extract",
  instruction?: string,               // NL extraction prompt
  schema?: ExtractionConfig,          // css_schema | xpath_schema | regex | llm
  selector?: string                   // scope extraction to element
}
```

#### `act`
Composite action: perform a natural-language instruction by chaining primitive actions. Uses LLM to decompose instruction if LLM is configured; otherwise falls back to structured-only.

```ts
{
  action: "act",
  instruction: string,     // e.g. "Click login, fill email field with user@test.com, press submit"
  timeout?: number
}
```

#### `wait`
Wait for a condition: time, text to appear/disappear, or selector.

```ts
{
  action: "wait",
  time?: number,           // seconds
  text?: string,           // wait for text to appear
  textGone?: string,       // wait for text to disappear
  selector?: string        // wait for selector
}
```

#### `pdf`
Save current page as PDF.

```ts
{
  action: "pdf",
  filename?: string,
  format?: string,         // page format e.g. "A4"
  landscape?: boolean
}
```

#### `storage`
Manage browser storage: save/restore state, list/clear cookies, localStorage, sessionStorage.

```ts
{
  action: "storage",
  op: "save" | "restore" | "list-cookies" | "clear-cookies" |
      "list-local" | "clear-local" | "list-session" | "clear-session",
  filename?: string,       // for save/restore
  key?: string,            // for single-item operations
  value?: string
}
```

#### `network`
Network interception and monitoring.

```ts
{
  action: "network",
  op: "list-requests" | "get-request" | "route" | "unroute" | "set-state",
  pattern?: string,        // URL pattern for route
  status?: number,         // mock response status
  body?: string,           // mock response body
  state?: "online" | "offline"
}
```

#### `tabs`
Tab management: list, create, close, select.

```ts
{
  action: "tabs",
  op: "list" | "new" | "close" | "select",
  index?: number,          // tab index
  url?: string             // URL for new tab
}
```

#### `session`
Browser lifecycle management.

```ts
{
  action: "session",
  op: "start" | "close" | "status",
  profile?: string,        // persistent profile name
  headless?: boolean,
  viewport?: { width: number, height: number },
  userAgent?: string,
  proxy?: string,          // proxy server URL
  cdpEndpoint?: string,    // connect to existing CDP endpoint
  executablePath?: string  // custom browser executable
}
```

### Session Model

Inspired by Playwright MCP's model:

1. **Isolated sessions** (default): Each `session start` creates a fresh browser context. Storage is in-memory. On `session close`, everything is discarded.

2. **Persistent profiles** (`profile: "name"`): Browser state (cookies, localStorage, IndexedDB) persists to disk at `~/.cache/search-mcp/browser-profiles/<name>/`. Reusing the same profile name restores previous state — critical for maintaining login sessions across research phases.

3. **CDP endpoint connection** (`cdpEndpoint: "ws://..."`): Connect to an existing Chrome/Chromium instance. Useful for debugging, using the user's logged-in browser, or connecting to cloud browser services.

4. **Session TTL**: Optional timeout that auto-closes the browser after inactivity period. Default: no timeout (explicit close required).

### Anti-Detection (Stealth)

Modern bot-detection systems (Cloudflare, DataDome, PerimeterX) detect automation through multiple vectors. Our stealth strategy layers three defenses:

**Layer 1: Launch flags** (always applied when `stealthEnabled: true`)
```
--disable-blink-features=AutomationControlled
--no-sandbox (configurable, off by default)
--disable-dev-shm-usage
```

**Layer 2: Init-script patches** (inject before page scripts execute)
31+ fingerprint masking patches adapted from ManagedCode Playwright Stealth research:
- `navigator.webdriver` → false
- `navigator.plugins` → realistic array
- `navigator.languages` → configured locale
- WebGL vendor/renderer → real GPU strings (e.g., "Intel Inc.", "ANGLE (Intel...")
- Canvas fingerprinting → subtle per-session noise
- Audio fingerprinting → subtle per-session noise
- `chrome.runtime` → defined (headless detection vector)
- Permissions API → realistic state per spec
- `window.outerWidth/outerHeight` → match viewport

**Layer 3: CDP leak prevention** (critical)
Bot detectors monitor for `Runtime.enable` CDP commands — these are a dead giveaway that a debugger/protocol client is attached. Two mitigation paths:
- **Option A: rebrowser-playwright** — drop-in replacement for `playwright-core` that patches Runtime.enable detection (rebrowser-patches project). Preferred for sensitive sites. Requires `BROWSER_REBROWSER=true`. Drop-in: `import { chromium } from 'rebrowser-playwright'`.
- **Option B: Raw CDP manual control** — use Playwright's `page.context().newCDPSession(page)` to manage CDP commands carefully, avoiding `Runtime.enable` unless explicitly needed for `evaluate` actions.

**Additional stealth configuration:**
- Realistic user-agent strings (Chrome stable-channel UA, OS-appropriate)
- Viewport dimensions matching real devices
- Locale, timezone, geolocation spoofing
- Proxy rotation support for IP diversity

---


