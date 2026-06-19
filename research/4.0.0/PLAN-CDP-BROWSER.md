# CDP Browser Control — Implementation Plan

## Phase 0: Prerequisites

### 0.1 Dependency Addition

- **File**: `package.json`
- Add `playwright-core` as optional dependency
- Add `rebrowser-playwright` as optional dependency (peer to playwright-core, patches CDP leak detection)
- Do NOT bundle browsers — download on first use (pattern: Playwright MCP)
- Estimated: ~5MB for playwright-core, ~130MB for Chromium (on-demand)

### 0.2 Config Schema Extension

- **File**: `src/config.ts`
- Add `BrowserConfig` interface:
  ```ts
  interface BrowserConfig {
    enabled: boolean;
    executablePath?: string;
    headless: boolean;
    viewport: { width: number; height: number };
    userAgent?: string;
    proxyServer?: string;
    cdpEndpoint?: string;
    profileDir: string;
    maxSessionTimeMs: number;
    stealthEnabled: boolean;
    rebrowser: boolean;
    credentials?: Record<string, { username: string; password: string; totpSecret?: string }>;
  }
  ```
- Add env var resolution: `BROWSER_ENABLED`, `BROWSER_*` → config
- Add to `config.example.json`

### 0.3 Health Check Registration

- **File**: `src/health.ts`
- Add `browser` to `GATED_TOOLS` with `BROWSER_ENABLED` gate
- Add health probe: check that Playwright can find a browser binary
- Health status: `healthy` (browser available) | `degraded` (no browser binary, will download) | `unconfigured` (disabled)

---

## Phase 1: Browser Core Module

### 1.1 Types

- **File**: `src/browser/types.ts` (NEW)
- Define:
  - `BrowserSession` — session state (page, context, browser refs)
  - `BrowserSessionConfig` — launch config
  - `SnapshotNode` — accessibility tree node with stable ref
  - `SnapshotResult` — full snapshot response
  - `ActionTarget` — element reference (ref | selector | text)
  - `ActionResult` — action success/failure with optional data
  - `ExtractionResult` — structured extraction output
  - `NetworkRequest` — tracked request metadata
  - `BrowserError` — typed browser errors
  - `ProfileStorage` — serialized cookies + localStorage

### 1.2 Browser Manager

- **File**: `src/browser/browserManager.ts` (NEW)
- `BrowserManager` class:
  - `launch(config: BrowserSessionConfig): Promise<BrowserSession>`
    - Launch Chromium via playwright-core
    - Apply stealth flags (from stealth.ts)
    - Set viewport, user agent
    - Apply proxy if configured
    - Create browser context
  - `connect(cdpEndpoint: string, headers?: Record<string, string>): Promise<BrowserSession>`
    - Connect to existing CDP endpoint
    - Use playwright-core's `connectOverCDP()`
  - `close(session: BrowserSession): Promise<void>`
    - Close context, close browser
    - Clean up timers
  - `status(session: BrowserSession): SessionStatus`
    - List open pages, active URL per page, session uptime
  - Singleton pattern: one active session per MCP server instance (v1)

### 1.3 Session Management

- **File**: `src/browser/session.ts` (NEW)
- `SessionStore`:
  - `saveProfile(name: string, context: BrowserContext): Promise<void>`
    - Serialize cookies + localStorage to `{profileDir}/{name}.json`
  - `loadProfile(name: string): Promise<StorageState | null>`
    - Load stored profile data
  - `listProfiles(): Promise<string[]>`
    - List available profile names
  - `deleteProfile(name: string): Promise<void>`
- Session timeout: `setTimeout` on session creation, auto-close on expiry
- Session TTL reset on each action invocation

### 1.4 Stealth Configuration (3-layer defense)

- **File**: `src/browser/stealth.ts` (NEW)
- `buildLaunchArgs(config: BrowserSessionConfig): string[]` — Layer 1: Launch flags
  - `--disable-blink-features=AutomationControlled`
  - `--disable-dev-shm-usage`
  - Conditional `--no-sandbox` (off by default, only for Docker/CI)
  - Conditional `--proxy-server` if configured
- `buildInitScripts(config: BrowserSessionConfig): string[]` — Layer 2: Init-script patches
  - Inject before page scripts execute (`page.addInitScript()`)
  - 31+ fingerprint patches adapted from ManagedCode Playwright Stealth:
    - `navigator.webdriver` → `false`
    - `navigator.plugins` → realistic PluginArray
    - `navigator.languages` → `['en-US', 'en']`
    - WebGL `RENDERER`/\`VENDOR\` → real GPU strings ("Intel Inc.", "ANGLE (Intel)...")
    - Canvas `toDataURL()` → subtle per-session noise (random 1-2px offsets)
    - Audio `getChannelData()` → subtle per-session noise
    - `chrome.runtime` → defined (headless Chrome returns undefined)
    - Permissions API → realistic state
    - `window.outerWidth/outerHeight` → match configured viewport
  - Source: adapted from published research (see spec Appendix)
- `resolveBrowserModule(config: BrowserSessionConfig): string` — Layer 3: CDP leak fix
  - If `config.rebrowser === true`: return `'rebrowser-playwright'` (patches `Runtime.enable` detection)
  - Otherwise: return `'playwright-core'` (default)
  - `rebrowser-playwright` is an optional dependency; graceful fallback if not installed
- `buildContextOptions(config: BrowserSessionConfig): BrowserContextOptions`
  - User agent string (Chrome stable-channel UA, OS-appropriate)
  - Viewport dimensions from config
  - Locale, timezone spoofing (optional)
  - `bypassCSP: true` for extraction reliability

### 1.6 Raw CDP Session Access

- **File**: `src/browser/cdp.ts` (NEW)
- `createCDPSession(page: Page): Promise<CDPSession>`
  - Wraps `page.context().newCDPSession(page)`
  - Provides raw protocol access when high-level Playwright API is insufficient
  - Use cases: performance metrics, advanced network control, security audit headers
- `sendCommand(session: CDPSession, method: string, params?: object): Promise<unknown>`
  - Typed wrapper around `session.send()`
  - Handles common CDP domains: Network, Performance, Security, Emulation
- `enableNetworkTracking(session: CDPSession): Promise<void>`
  - `Network.enable()` for full request/response body capture
- `enablePerformanceMetrics(session: CDPSession): Promise<void>`
  - `Performance.enable()` for Core Web Vitals, JS coverage

### 1.7 Tests

- **File**: `test/browser/manager.test.ts` (NEW)
- Test: launch browser, navigate to local test page, close
- Test: connect to CDP endpoint (mock)
- Test: session timeout triggers auto-close
- Test: profile save/restore preserves cookies

---

## Phase 2: Core Browser Actions

### 2.1 Accessibility Snapshot

- **File**: `src/browser/snapshot.ts` (NEW)
- `captureSnapshot(page: Page, options?): Promise<SnapshotResult>`
  - Use Playwright's `page.accessibility.snapshot({ interestingOnly: true })`
  - Post-process to assign stable `ref` IDs (e.g., "e1", "e2", ...)
  - Map each node to { role, name, ref, value, children, ... }
  - Optionally scope to a selector
  - Optionally limit tree depth
  - Include element bounding boxes for vision mode
- `findElementByRef(snapshot: SnapshotResult, ref: string): SnapshotNode | null`
  - Walk tree to find node by ref ID
- `refToLocator(page: Page, node: SnapshotNode): Locator`
  - Convert snapshot node to Playwright Locator for action execution

### 2.2 User Actions

- **File**: `src/browser/actions.ts` (NEW)
- `click(page: Page, target: ActionTarget, options?): Promise<ActionResult>`
  - Resolve target (ref from snapshot, or CSS selector, or text match)
  - Use snapshot→locator resolution for ref-based targeting
  - Fall back to `page.locator(selector)` for selector-based
  - Fall back to `page.getByText(text)` for text-based
  - Support doubleClick, rightClick, modifiers
- `typeText(page: Page, target: ActionTarget, text: string, options?): Promise<ActionResult>`
  - Resolve target
  - Use `locator.fill(text)` (fast) or `locator.pressSequentially(text)` (slow, triggers key handlers)
  - Optionally press Enter after (submit)
- `selectOption(page: Page, target: ActionTarget, values: string[]): Promise<ActionResult>`
  - Resolve target to <select> element
  - `locator.selectOption(values)`
- `hover(page: Page, target: ActionTarget): Promise<ActionResult>`
  - Resolve target, `locator.hover()`
- `dragDrop(page: Page, from: ActionTarget, to: ActionTarget): Promise<ActionResult>`
  - Resolve both targets, `locator.dragTo(targetLocator)`
- `pressKey(page: Page, key: string): Promise<ActionResult>`
  - `page.keyboard.press(key)`
- `scroll(page: Page, deltaX: number, deltaY: number): Promise<ActionResult>`
  - `page.mouse.wheel(deltaX, deltaY)`

### 2.3 Page Evaluation

- **File**: `src/browser/actions.ts` (add to existing)
- `evaluateJs(page: Page, expression: string, target?: ActionTarget): Promise<unknown>`
  - If target: resolve element, evaluate with element as argument
  - If no target: evaluate in page context
  - Serialize result as JSON (handle circular refs, functions, symbols)
  - Timeout: 30s default, configurable

### 2.4 Screenshot

- **File**: `src/browser/actions.ts` (add to existing)
- `takeScreenshot(page: Page, options?): Promise<Buffer | string>`
  - Full page or viewport
  - Element-scoped if target provided
  - PNG or JPEG with quality
  - Return base64 string or write to file

### 2.5 Structured Extraction

- **File**: `src/browser/extraction.ts` (NEW)
- `extractStructured(page: Page, config: ExtractionConfig): Promise<unknown>`
  - Reuse existing `extractionConfig` infrastructure from `src/utils/extractionConfig.ts`
  - `css_schema`: evaluate CSS selectors against page DOM
  - `xpath_schema`: evaluate XPath expressions
  - `regex`: apply regex patterns to page text content
  - `llm`: send page HTML to LLM with extraction instruction
- `extractByInstruction(page: Page, instruction: string): Promise<unknown>`
  - NL-based extraction using LLM (if configured)
  - Falls back to full text extraction if no LLM

### 2.6 Network Interception

- **File**: `src/browser/network.ts` (NEW)
- `listRequests(session: BrowserSession, filter?: RegExp): Promise<NetworkRequest[]>`
  - Return tracked requests since page load
  - Filter by URL regex
  - Include method, URL, status, timing
- `getRequestDetails(session: BrowserSession, index: number): Promise<NetworkRequestDetail>`
  - Full request/response headers + body for a tracked request
- `addRoute(page: Page, pattern: string, handler: RouteHandler): Promise<void>`
  - `page.route(pattern, handler)`
  - Support: abort, fulfill (mock), continue, modify headers
- `removeRoute(page: Page, pattern?: string): Promise<void>`
  - `page.unroute(pattern)` or `page.unrouteAll()`
- `setNetworkState(page: Page, state: "online" | "offline"): Promise<void>`
  - `page.context().setOffline(state === "offline")`

### 2.7 Wait Strategies

- **File**: `src/browser/actions.ts` (add to existing)
- `waitFor(page: Page, options: WaitOptions): Promise<void>`
  - `waitForTime(ms)`: simple delay
  - `waitForText(text)`: `page.getByText(text).waitFor()`
  - `waitForTextGone(text)`: `page.getByText(text).waitFor({ state: 'hidden' })`
  - `waitForSelector(selector)`: `page.locator(selector).waitFor()`
  - `waitForNavigation()`: wait for page navigation to complete
  - `waitForLoadState(state)`: `page.waitForLoadState(state)`

### 2.8 Tests

- **File**: `test/browser/actions.test.ts` (NEW)
- Test: navigate → snapshot → find element → click → verify
- Test: type text → verify value
- Test: evaluate JS → verify result
- Test: screenshot produces valid image
- Test: extract with CSS schema returns correct data
- Test: network route intercepts and mocks request
- Test: wait for text appears

---

## Phase 3: Tool Family Registration

### 3.1 Tool Family Definition

- **File**: `src/tools/families/browser.ts` (NEW)
- Define 14 `FamilyAction` entries following registry pattern
- Base schema:
  ```ts
  const browserBaseSchema = z.object({
    action: z.enum([
      'navigate',
      'snapshot',
      'click',
      'type',
      'evaluate',
      'screenshot',
      'extract',
      'act',
      'wait',
      'pdf',
      'storage',
      'network',
      'tabs',
      'session',
    ]),
    // ... action-specific fields resolved via discriminatedUnion
  });
  ```
- Each action: full Zod schema with `z.literal(actionName)`
- Config gate: `BROWSER_ENABLED !== true` → configIssue returns remediation string
- LLM-dependent actions (`act`, `extract` with llm strategy) check LLM config availability
- **Note on registration pattern**: Unlike `web_crawl`, `web_read`, and `semantic_crawl` which are registered as standalone tools via `server.registerTool()` (single-action), the `browser` tool has 14 actions and naturally fits `registerFamily()` — the same pattern used by YouTube, Reddit, GitHub, Packages, and Research tool families.

### 3.2 Action Handlers

Each handler:

1. Validates that browser session exists (auto-starts if needed)
2. Gets or creates BrowserManager singleton
3. Delegates to appropriate module function
4. Returns result via `makeResult()` + `successResponse()`
5. Catches errors, returns `errorResponse()` with sanitized message

Handler signatures follow existing pattern:

```ts
handler: async (args: Record<string, unknown>, cfg: SearchConfig) => {
  // ...
};
```

### 3.3 Server Registration

- **File**: `src/server.ts`
- Import `registerBrowserTool` from `src/tools/families/browser.ts`
- Call in `createServer()` after other tool registrations
- Follow existing pattern:
  ```ts
  if (cfg.browser.enabled) {
    registerBrowserTool(server, cfg);
  } else {
    // Tool registered but returns config error when BROWSER_ENABLED=false
  }
  ```
- Actually: always register (following `registerFamily` pattern), config gate in action handler

### 3.4 Response Format

- All browser actions return `ToolResult<T>` via `makeResult()`
- Screenshots: return base64 image in `data` field, tagged with `contentType: "image/png"`
- Snapshots: return structured JSON with `ref` assignments
- Extraction: return structured data per schema
- Errors: return `isError: true` with human-readable message

### 3.5 Tests

- **File**: `test/browser/toolFamily.test.ts` (NEW)
- Test: each action schema validates correctly
- Test: config gate returns error when disabled
- Test: session auto-starts on first action
- Test: snapshot returns valid accessibility tree
- Test: click + type chain works end-to-end

---

## Phase 4: Deep Research Integration

### 4.1 Interactive Browser Agent

- **File**: `src/research/interactiveAgent.ts` (NEW)
- `InteractiveBrowserAgent` class:
  - `constructor(config: BrowserSessionConfig, llmClient?: DeepResearchLlmClient)`
  - `async executePlan(url: string, plan: InteractiveExtractionPlan): Promise<InteractiveResult>`
    1. Open browser session (with profile for auth)
    2. Navigate to URL
    3. Execute action sequence from plan
    4. Wait for content to settle (network idle or timeout)
    5. Capture snapshot + full text
    6. Extract findings per plan.extraction config
    7. Close session (or keep alive if reuse requested)
    8. Return findings, sources, screenshots
  - `async detectAndHandleBlockers(page: Page): Promise<BlockerHandlingResult>`
    - Check page content against `BOT_CHALLENGE_PATTERNS`
    - If bot detected: try stealth escalation, then report
    - If login wall: check for stored credentials, attempt login
    - If cookie consent: try to dismiss common consent patterns
    - Return: `{ handled: true }` or `{ handled: false, reason }`

### 4.2 Type Extensions

- **File**: `src/research/types.ts`
- Add:

  ```ts
  export type SourceType = /* existing */ ... | 'browser-interactive';

  export interface InteractiveExtractionPlan {
    actions: InteractiveAction[];
    extraction: {
      instruction?: string;
      selector?: string;
      schema?: ExtractionConfig;
    };
    maxTimeMs?: number;
    browserConfig?: BrowserSessionConfig;
  }

  export interface InteractiveAction {
    type: 'navigate' | 'click' | 'type' | 'wait' | 'evaluate' | 'scroll' | 'screenshot' | 'select';
    target?: string;
    value?: string;
    timeout?: number;
  }

  export interface SubQuestion {
    // ... existing fields
    requiresAuth?: boolean;
    extractionPlan?: InteractiveExtractionPlan;
  }
  ```

### 4.3 ResearchTools Extension

- **File**: `src/research/researchTools.ts`
- Add methods to `ResearchTools` interface and implementation:
  ```ts
  browserSession: (config: BrowserSessionConfig) => Promise<{ sessionId: string }>;
  browserExtract: (sessionId: string, url: string, plan: InteractiveExtractionPlan) =>
    Promise<{
      content: string;
      findings: Finding[];
      sources: WorkerSource[];
      screenshots?: string[];
    }>;
  browserClose: (sessionId: string) => Promise<void>;
  ```
- All methods catch errors and return empty/error results (existing pattern)

### 4.4 Discovery Engine Integration

- **File**: `src/research/discovery.ts`
- Add `browserSourceDiscovery()` method:
  - Called when `SubQuestion.requiresAuth === true`
  - Uses `ResearchTools.browserSession()` + `ResearchTools.browserExtract()`
  - Searches within authenticated sessions (e.g., enterprise knowledge bases, paywalled journals)
  - Returns `SourceCandidate[]` like other discovery methods

### 4.5 Worker Agent Integration

- **File**: `src/research/workerAgent.ts`
- In `readPage()` method:
  - After fetching page content via `webRead`
  - Check content against `BOT_CHALLENGE_PATTERNS` + empty content detection
  - If blocked and `extractionPlan` exists:
    - Delegate to `interactiveAgent.executePlan(url, extractionPlan)`
    - Use returned content for extraction
  - If no extraction plan: mark as failed (existing behavior)
- Extend LLM search plan prompt to include interactive extraction planning

- **Hook point detail**: Content extraction in deep research goes through two paths:
  1. `WorkerAgent.readPage()` → `ResearchTools.webRead()` (worker-based, V5.1+)
  2. `ExtractionEngine` (`src/research/extraction.ts`) → `webRead()`/`webCrawl()` (phase 3)

  The interactive fallback must hook BOTH paths. In `readPage()`, check for bot-wall patterns after `webRead` returns. In `ExtractionEngine`, add a post-read content quality check that triggers `interactiveAgent.executePlan()` when content is empty or matches `BOT_CHALLENGE_PATTERNS`.

### 4.6 Content Quality / Bot Detection

- **File**: `src/research/contentQuality.ts` (NEW, or extend existing)
- `isBotChallenge(content: string): boolean`
  - Match against `BOT_CHALLENGE_PATTERNS`
  - Check for empty content (< 50 chars)
  - Check for redirect to login pages
- `isLoginWall(content: string): boolean`
  - Common login form patterns
  - HTTP 401/403 status

### 4.7 Credential Management

- **File**: `src/browser/credentials.ts` (NEW)
- `resolveCredentials(url: string, config: BrowserConfig): BrowserCredentials | null`
  - Match URL domain against `BROWSER_CREDENTIALS` map
  - Return username, password, optional TOTP secret
- `performLogin(page: Page, credentials: BrowserCredentials, domain: string): Promise<boolean>`
  - Common login form detection (username/password fields)
  - Fill credentials
  - Submit form
  - Wait for post-login state (URL change, cookie set, or element appears)
  - Return success/failure

### 4.8 Tests

- **File**: `test/research/interactiveAgent.test.ts` (NEW)
- Test: execute plan navigates and extracts
- Test: bot detection identifies Cloudflare challenge
- Test: login form detection + credential fill
- Test: plan execution with pagination (click next → extract → repeat)
- Test: empty content triggers fallback to interactive

---

## Phase 5: Advanced Features

### 5.1 Natural Language `act` Action

- **File**: `src/browser/act.ts` (NEW)
- `actByInstruction(page: Page, instruction: string, llmClient: DeepResearchLlmClient): Promise<ActionResult>`
  - Send snapshot + instruction to LLM
  - LLM returns sequence of primitive actions
  - Execute sequence with verification between steps
  - Handle failures with retry (ask LLM for alternative approach)
- Requires `LLM_PROVIDER` config → graceful degradation to structured-only

### 5.2 Session Recording

- **File**: `src/browser/recording.ts` (NEW)
- Record all actions + snapshots for debugging
- Save as JSON timeline
- Replay capability for failed sessions
- Integrate with existing trace infrastructure

### 5.3 Interactive Semantic Crawl

- **File**: `src/tools/semanticCrawl.ts` (modify)
- New source type: `{ type: 'interactive', url: string, actions: InteractiveAction[] }`
- Crawler executes actions before chunking each page
- Enables semantic search over authenticated/gated content
  - **Integration hook**: The `webCrawl` middleware chain (`src/crawl/middleware.ts`) provides a natural extension point. A `BrowserInteractiveMiddleware` (priority 450, before Crawl4aiClient at 500) could intercept crawl requests for URLs matching interactive profiles, execute browser actions, and return extracted content — bypassing Crawl4AI entirely for those URLs. Existing SSRF guards (`assertSafeUrl()`) and domain trust filtering would still apply.

### 5.4 Parallel Browser Sessions

- Browser session pooling for worker agents
- Max concurrent sessions configurable (`BROWSER_MAX_CONCURRENT_SESSIONS`)
- Session queue with timeout

### 5.5 Docker Compose

- Add Chromium to Docker image (or use `@playwright/browser-chromium`)
- Dockerfile multi-stage: separate browser download layer for caching
- docker-compose profile: `browser` includes browser-enabled search-mcp

---

## File Manifest

### New Files

| File                                     | Purpose                                                 |
| ---------------------------------------- | ------------------------------------------------------- |
| `src/browser/types.ts`                   | Browser-specific type definitions                       |
| `src/browser/browserManager.ts`          | Browser lifecycle management                            |
| `src/browser/session.ts`                 | Session state + profile persistence                     |
| `src/browser/stealth.ts`                 | 3-layer anti-detection (flags, init-scripts, rebrowser) |
| `src/browser/cdp.ts`                     | Raw CDP session access via CDPSession                   |
| `src/browser/snapshot.ts`                | Accessibility tree capture                              |
| `src/browser/actions.ts`                 | User interaction primitives                             |
| `src/browser/extraction.ts`              | Structured data extraction                              |
| `src/browser/network.ts`                 | Network interception                                    |
| `src/browser/credentials.ts`             | Login credential management                             |
| `src/browser/recording.ts`               | Session recording (Phase 5)                             |
| `src/browser/act.ts`                     | NL instruction execution (Phase 5)                      |
| `src/tools/families/browser.ts`          | MCP tool family registration                            |
| `src/research/interactiveAgent.ts`       | Orchestrator browser integration                        |
| `src/research/contentQuality.ts`         | Bot detection + content assessment                      |
| `test/browser/manager.test.ts`           | Browser manager tests                                   |
| `test/browser/actions.test.ts`           | Action primitive tests                                  |
| `test/browser/toolFamily.test.ts`        | Tool family integration tests                           |
| `test/research/interactiveAgent.test.ts` | Orchestrator integration tests                          |

### Modified Files

| File                            | Change                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `package.json`                  | Add `playwright-core` dependency                                   |
| `src/config.ts`                 | Add `BrowserConfig` + env var resolution                           |
| `src/health.ts`                 | Add browser health probe + gate                                    |
| `src/server.ts`                 | Register browser tool family                                       |
| `src/types.ts`                  | Add browser-related types (if needed)                              |
| `src/research/types.ts`         | Add `InteractiveExtractionPlan`, `browser-interactive` source type |
| `src/research/researchTools.ts` | Add `browserSession`, `browserExtract`, `browserClose`             |
| `src/research/extraction.ts`    | Add interactive fallback content quality check                     |
| `src/research/discovery.ts`     | Add `browserSourceDiscovery()`                                     |
| `src/research/workerAgent.ts`   | Interactive fallback extraction, extended LLM prompts              |
| `config.example.json`           | Add browser config section                                         |
| `docker-compose.yml`            | Add browser profile (Phase 5)                                      |
| `Dockerfile`                    | Add Chromium layer (Phase 5)                                       |

---

## Risk Assessment

| Risk                                 | Likelihood | Impact   | Mitigation                                                                                           |
| ------------------------------------ | ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Playwright dependency too large      | Medium     | Medium   | playwright-core without browsers is ~5MB. Browser downloaded on demand.                              |
| Bot detection bypasses stealth       | High       | Medium   | 3-layer defense: flags → init-scripts → rebrowser CDP leak fix → CDP endpoint → user profile → abort |
| Browser memory leaks                 | Medium     | High     | Session TTL, max session time, explicit close on orchestrator completion                             |
| CDP protocol changes break things    | Low        | Medium   | Playwright abstracts CDP; we depend on Playwright, not raw CDP                                       |
| SSRF via browser navigation          | Medium     | Critical | Reuse existing `assertSafeUrl()` on every navigate call                                              |
| Credential exposure in MCP transport | Low        | Critical | Credentials never in tool parameters; env vars only; output scrubbing                                |
| Multi-session resource exhaustion    | Low        | Medium   | V1: single session. Phase 5: pool with max + queue                                                   |

---

## Estimated Effort

| Phase                        | Effort         | Risk Level  |
| ---------------------------- | -------------- | ----------- |
| 0: Prerequisites             | 0.5 day        | Low         |
| 1: Browser Core Module       | 2 days         | Medium      |
| 2: Core Browser Actions      | 3 days         | Medium      |
| 3: Tool Family Registration  | 2 days         | Low         |
| 4: Deep Research Integration | 3 days         | Medium-High |
| 5: Advanced Features         | 4 days         | Medium      |
| **Total**                    | **~14.5 days** |             |

---

## Success Criteria

1. `browser` tool family accessible via MCP when `BROWSER_ENABLED=true`
2. Navigate → snapshot → click → type → extract works end-to-end
3. Session state persists across actions within a session
4. Profile save/restore preserves login state across sessions
5. Deep research orchestrator can extract content behind login walls
6. Bot detection triggers fallback to interactive extraction
7. New `test/browser/` and `test/research/interactiveAgent.test.ts` test suites pass
8. Existing tests continue to pass (no regressions)
9. `npm run lint` + `npm run typecheck` clean
10. Docker build succeeds with browser profile (Phase 5)
