import type {
  Page,
  BrowserContext,
  Browser as PlaywrightBrowser,
  CDPSession,
} from 'playwright-core';

export type BrowserEngine = 'playwright' | 'cloak';

/** Active browser session state. */
export interface BrowserSession {
  /** Unique session identifier. */
  id: string;
  /** Playwright Browser instance (always set in v1; CDP connections also return a Browser). */
  browser: PlaywrightBrowser;
  /** Playwright BrowserContext (isolated context). */
  context: BrowserContext;
  /** Currently active page. */
  page: Page;
  /** Open pages indexed by index. */
  pages: Page[];
  /** Raw CDP session for the active page (lazy-init). */
  cdpSession: CDPSession | null;
  /** Session creation timestamp (ISO). */
  createdAt: string;
  /** Last activity timestamp (ISO). Updated on each action. */
  lastActivityAt: string;
  /** Profile name if using persistent profile, null for isolated. */
  profileName: string | null;
  /** Timeout handle for auto-close. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /** How the session was created. */
  source: 'launch' | 'cdp' | 'user' | 'profile';
  /** Browser backend used to launch the session. */
  browserEngine: BrowserEngine;
}

/** Configuration for browser session launch or connect. */
export interface BrowserSessionConfig {
  /** Launch a new Chromium browser. */
  headless: boolean;
  /** Viewport dimensions. */
  viewport: { width: number; height: number };
  /** Browser user-agent string. Empty = use default. */
  userAgent: string;
  /** Proxy server URL (e.g. http://proxy:8080). Empty = none. */
  proxyServer: string;
  /** Path to Chromium executable. Empty = auto-detect. */
  executablePath: string;
  /** Profile name for persistent storage. Null = isolated session. */
  profile: string | null;
  /** Whether to apply anti-detection measures. */
  stealthEnabled: boolean;
  /** Whether to use rebrowser-playwright for CDP leak fix. */
  rebrowser: boolean;
  /** Max session lifetime in ms before auto-close. */
  maxSessionTimeMs: number;
  /** Bypass Content Security Policy (default: false). */
  bypassCSP: boolean;
  /** Domain credentials map (domain → {username, password, totpSecret?}). */
  credentials: Record<string, { username: string; password: string; totpSecret?: string }>;
  /** Browser automation backend. CloakBrowser is optional and imported only when selected. */
  browserEngine: BrowserEngine;
  /** Enable CloakBrowser wrapper-level humanized input behavior. */
  cloakHumanize: boolean;
  /** CloakBrowser humanization preset. */
  cloakHumanPreset: 'default' | 'careful';
  /** Optional locale routed through CloakBrowser binary flags. */
  cloakLocale: string;
  /** Optional timezone routed through CloakBrowser binary flags. */
  cloakTimezone: string;
  /** Let CloakBrowser infer locale/timezone from proxy IP. */
  cloakGeoip: boolean;
  /** Include CloakBrowser's default stealth fingerprint arguments. */
  cloakStealthArgs: boolean;
}

/** CDP endpoint connection configuration. */
export interface CDPEndpointConfig {
  /** WebSocket URL of the CDP endpoint (e.g. ws://127.0.0.1:9222/devtools/browser/...). */
  endpoint: string;
  /** Optional headers for the WebSocket connection. */
  headers?: Record<string, string>;
}

/** Accessibility tree snapshot node. */
export interface SnapshotNode {
  /** Stable reference ID (e.g. "e1", "e2") for subsequent actions. */
  ref: string;
  /** ARIA role. */
  role: string;
  /** Accessible name. */
  name: string;
  /** Current value (for form controls). */
  value?: string;
  /** Bounding box { x, y, width, height }. */
  box?: { x: number; y: number; width: number; height: number };
  /** Child nodes. */
  children: SnapshotNode[];
}

/** Full accessibility snapshot result. */
export interface SnapshotResult {
  /** Page URL at time of snapshot. */
  url: string;
  /** Page title. */
  title: string;
  /** Accessibility tree root. */
  root: SnapshotNode;
  /** Number of elements in tree. */
  elementCount: number;
}

/** Element targeting strategies. */
export type ActionTarget =
  | { type: 'ref'; ref: string }
  | { type: 'selector'; selector: string }
  | { type: 'text'; text: string };

/** Result of a browser action. */
export interface ActionResult {
  /** Whether the action succeeded. */
  success: boolean;
  /** Human-readable result message. */
  message: string;
  /** Optional result data (e.g. screenshot base64, evaluation result). */
  data?: unknown;
}

/** Structured extraction result. */
export interface ExtractionResult {
  /** Extracted data (typed per schema). */
  data: unknown;
  /** Whether extraction was successful on this page. */
  success: boolean;
  /** Warnings during extraction. */
  warnings?: string[];
}

/** Tracked network request metadata. */
export interface NetworkRequest {
  /** Request index (1-based). */
  index: number;
  /** HTTP method. */
  method: string;
  /** Request URL. */
  url: string;
  /** Response status code (or 0 if pending). */
  status: number;
  /** Timing in ms. */
  timing: number;
}

/** Full network request detail with headers and body. */
export interface NetworkRequestDetail {
  /** Request headers. */
  requestHeaders: Record<string, string>;
  /** Request body (if captured). */
  requestBody?: string;
  /** Response headers. */
  responseHeaders: Record<string, string>;
  /** Response body (if captured). */
  responseBody?: string;
}

/** Route handler types. */
export type RouteHandlerAction =
  | { type: 'abort' }
  | { type: 'fulfill'; status: number; body?: string; headers?: Record<string, string> }
  | { type: 'continue' }
  | { type: 'headers'; headers: Record<string, string> };

/** Serialized profile storage. */
export interface ProfileStorage {
  /** Profile name. */
  name: string;
  /** Last saved timestamp (ISO). */
  savedAt: string;
  /** Playwright storage state (cookies, localStorage, etc.). */
  storageState: unknown;
}

/** Typed browser error. */
export class BrowserError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'LAUNCH_FAILED'
      | 'CONNECT_FAILED'
      | 'SESSION_NOT_FOUND'
      | 'ACTION_FAILED'
      | 'MODE_MISMATCH'
      | 'TIMEOUT'
      | 'SSRF_BLOCKED',
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** Stealth health check result. */
export interface StealthHealthReport {
  /** Overall stealth pass/fail/degraded. */
  status: 'pass' | 'fail' | 'degraded';
  /** Individual checks. */
  checks: {
    name: string;
    passed: boolean;
    detail: string;
  }[];
  /** Summary message. */
  summary: string;
}

/** Session status report. */
export interface SessionStatus {
  /** Session ID. */
  id: string;
  /** Number of open tabs. */
  tabCount: number;
  /** Active tab index. */
  activeTabIndex: number;
  /** Active tab URL. */
  activeUrl: string;
  /** Session uptime in ms. */
  uptimeMs: number;
  /** Whether using a CDP endpoint connection. */
  isCDPEndpoint: boolean;
  /** Profile name (null if isolated). */
  profileName: string | null;
  /** Browser mode in use. */
  mode: 'stealth' | 'user' | 'profile';
  /** Browser backend in use. */
  browserEngine: BrowserEngine;
  /** Stealth health report (null when not in stealth mode). */
  stealthHealth: StealthHealthReport | null;
}

/** Typed result for interactive extraction. */
export interface InteractiveResult {
  /** Extracted content from the page. */
  content: string;
  /** Page title. */
  title: string;
  /** Page URL at time of extraction. */
  url: string;
  /** Screenshots taken during execution (base64). */
  screenshots: string[];
  /** Any findings extracted. */
  findings: { text: string; confidence: number }[];
  /** Warnings encountered during execution. */
  warnings: string[];
}

/** Blocker handling result. */
export interface BlockerHandlingResult {
  /** Whether the blocker was handled. */
  handled: boolean;
  /** Reason if not handled. */
  reason?: string;
  /** Whether login was performed. */
  loginPerformed?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// § Wait conditions (enhanced)
// ───────────────────────────────────────────────────────────────────────────

/** Condition-based wait specification. */
export interface WaitCondition {
  /** Condition type: visible (element appears), gone (element removed), has-text (contains text), count (number of matches). */
  condition: 'visible' | 'gone' | 'has-text' | 'count';
  /** CSS selector for the target element. */
  selector: string;
  /** Max time to wait for the condition in ms (default 30000). */
  timeout?: number;
  /** For has-text: expected text content. */
  text?: string;
  /** For count: expected number of matching elements. */
  count?: number;
  /** For count: comparison operator (default '>='). */
  countOperator?: '>=' | '<=' | '==' | '>' | '<';
}

/** Enhanced wait result with condition details. */
export interface WaitResult {
  /** Whether the condition was met before timeout. */
  satisfied: boolean;
  /** The condition that was checked. */
  condition: WaitCondition;
  /** Time elapsed in ms. */
  elapsedMs: number;
  /** Actual count for count-based conditions. */
  actualCount?: number;
  /** Actual text found for has-text conditions. */
  actualText?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// § Dialog handling
// ───────────────────────────────────────────────────────────────────────────

/** Browser dialog event. */
export interface DialogResult {
  /** Dialog type. */
  type: 'alert' | 'confirm' | 'prompt';
  /** Dialog message text. */
  message: string;
  /** Whether the dialog was accepted (false = dismissed). */
  accepted: boolean;
  /** Text entered for prompt dialogs (empty if dismissed or alert). */
  promptText?: string;
}

/** Configuration for auto-handling dialogs. */
export interface DialogHandlerConfig {
  /** Auto-accept all dialogs (true) or auto-dismiss (false). */
  accept: boolean;
  /** Default text for prompt dialogs. */
  promptText?: string;
  /** Maximum dialogs to auto-handle before stopping. */
  maxDialogs?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// § Frame context
// ───────────────────────────────────────────────────────────────────────────

/** Frame information for context switching. */
export interface FrameInfo {
  /** Frame name attribute. */
  name: string;
  /** Frame URL. */
  url: string;
  /** Depth from root (0 for top-level, 1 for direct child, etc.). */
  depth: number;
  /** Frame index within its parent (0-based). */
  index: number;
}

/** Result of switching frame context. */
export interface FrameSwitchResult {
  /** Whether the frame was found and switched. */
  success: boolean;
  /** Frame info that was switched to. */
  frame?: FrameInfo;
  /** All available frames at time of switch. */
  availableFrames: FrameInfo[];
}

// ───────────────────────────────────────────────────────────────────────────
// § Scroll-to-load (infinite scroll)
// ───────────────────────────────────────────────────────────────────────────

/** Result of infinite scroll / lazy-load handler. */
export interface ScrollToLoadResult {
  /** Number of scroll operations performed. */
  scrolls: number;
  /** Whether new content appeared during the last scroll. */
  newContentFound: boolean;
  /** Document height in px after scrolling. */
  finalHeight: number;
  /** Document height in px before scrolling. */
  initialHeight: number;
  /** Reason scrolling stopped. */
  stoppedReason: 'no-new-content' | 'max-scrolls' | 'timeout' | 'bottom-reached';
  /** Total time elapsed in ms. */
  elapsedMs: number;
}

// ───────────────────────────────────────────────────────────────────────────
// § Pagination
// ───────────────────────────────────────────────────────────────────────────

/** Pagination configuration. */
export interface PaginateConfig {
  /** CSS selector for the "next" link/button. If omitted, auto-detect common patterns. */
  nextSelector?: string;
  /** Maximum pages to collect (default 10). */
  maxPages?: number;
  /** Wait between pages in ms (default 2000). */
  waitBetweenMs?: number;
  /** Content selector to extract from each page. If omitted, returns page body text. */
  contentSelector?: string;
  /** Whether to extract full page content or just the content area. */
  extractMode?: 'full' | 'content-only';
}

/** Result of pagination walk. */
export interface PaginateResult {
  /** Number of pages collected. */
  pages: number;
  /** URLs visited. */
  urls: string[];
  /** Content from each page. */
  content: PaginatePageContent[];
  /** Whether pagination ended because no more pages were found. */
  exhausted: boolean;
}

/** Content from a single paginated page. */
export interface PaginatePageContent {
  /** Page URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Extracted text content. */
  text: string;
  /** Page number (1-based). */
  pageNumber: number;
}

// ───────────────────────────────────────────────────────────────────────────
// § Download interception
// ───────────────────────────────────────────────────────────────────────────

/** Configuration for download interception. */
export interface DownloadConfig {
  /** Directory to save the downloaded file. */
  savePath?: string;
  /** Accept downloads automatically (default true). */
  autoAccept?: boolean;
  /** Maximum download size in bytes (default 50MB). */
  maxSize?: number;
}

/** Result of intercepting a file download. */
export interface DownloadResult {
  /** Suggested filename from the server. */
  filename: string;
  /** MIME type. */
  mimeType: string;
  /** File size in bytes. */
  size: number;
  /** File content as base64 (when within size limits). */
  data?: string;
  /** Path where the file was saved (when savePath is configured). */
  savedPath?: string;
  /** Download URL. */
  url: string;
}

// ───────────────────────────────────────────────────────────────────────────
// § Table extraction
// ───────────────────────────────────────────────────────────────────────────

/** Configuration for table extraction. */
export interface TableExtractConfig {
  /** CSS selector to target a specific table. If omitted, extracts all tables. */
  selector?: string;
  /** Maximum tables to extract (default 10). */
  maxTables?: number;
  /** Include table captions in output (default true). */
  includeCaptions?: boolean;
  /** Flatten colspan/rowspan into individual cells (default true). */
  flattenSpans?: boolean;
}

/** Structured table data. */
export interface TableData {
  /** Table index on the page (0-based). */
  index: number;
  /** Table caption text, if present. */
  caption?: string;
  /** Column headers. */
  headers: string[];
  /** Table rows as header→value maps. */
  rows: Record<string, string>[];
  /** Number of data rows. */
  rowCount: number;
  /** Number of columns. */
  columnCount: number;
  /** CSS selector used to locate this table. */
  selector: string;
}

/** Result of extracting tables from a page. */
export interface TableExtractResult {
  /** All extracted tables. */
  tables: TableData[];
  /** Total tables found on the page. */
  totalTables: number;
}

// ───────────────────────────────────────────────────────────────────────────
// § Enhanced network interception
// ───────────────────────────────────────────────────────────────────────────

/** Configuration for network resource blocking. */
export interface NetworkBlockConfig {
  /** Resource types to block. */
  blockTypes?: ('image' | 'font' | 'stylesheet' | 'media' | 'script' | 'fetch' | 'websocket' | 'other')[];
  /** URL patterns to block (glob-style). */
  blockPatterns?: string[];
  /** URL patterns to allow (overrides blockPatterns). */
  allowPatterns?: string[];
}

/** Configuration for request header injection. */
export interface NetworkInjectConfig {
  /** URL patterns to match (glob-style). When omitted, injects on all requests. */
  patterns?: string[];
  /** Headers to add or override. */
  headers: Record<string, string>;
}

/** Configuration for request/response modification. */
export interface NetworkModifyConfig {
  /** URL patterns to match. */
  patterns: string[];
  /** New status code for the response. */
  status?: number;
  /** Replacement body text. */
  body?: string;
  /** Replacement headers. */
  headers?: Record<string, string>;
}

/** Result of enhanced network operations. */
export interface NetworkInterceptResult {
  /** Operation performed. */
  operation: 'block' | 'inject' | 'modify' | 'unblock' | 'list-intercepts';
  /** Number of rules applied. */
  rulesApplied: number;
  /** Active intercept rules summary. */
  activeRules?: { type: string; pattern: string }[];
}

// ───────────────────────────────────────────────────────────────────────────
// § Resource timing
// ───────────────────────────────────────────────────────────────────────────

/** Navigation Timing API data. */
export interface NavigationTiming {
  /** Time to first byte (ms). */
  ttfb: number;
  /** DOM Content Loaded (ms). */
  domContentLoaded: number;
  /** Page Load complete (ms). */
  loadComplete: number;
  /** First Paint (ms). */
  firstPaint: number;
  /** First Contentful Paint (ms). */
  firstContentfulPaint: number;
  /** DOM Interactive (ms). */
  domInteractive: number;
  /** DNS lookup time (ms). */
  dnsTime: number;
  /** TCP connection time (ms). */
  tcpTime: number;
  /** TLS handshake time (ms). */
  tlsTime: number;
  /** Total request time (ms). */
  requestTime: number;
  /** Total response time (ms). */
  responseTime: number;
}

/** Single resource timing entry. */
export interface ResourceTimingEntry {
  /** Resource URL. */
  url: string;
  /** Resource type (script, stylesheet, image, etc.). */
  type: string;
  /** Duration in ms. */
  duration: number;
  /** Transfer size in bytes. */
  transferSize: number;
  /** Start time relative to navigation (ms). */
  startTime: number;
  /** DNS lookup time (ms). */
  dnsTime: number;
  /** TCP connection time (ms). */
  tcpTime: number;
  /** Request time (ms). */
  requestTime: number;
  /** Response time (ms). */
  responseTime: number;
}

/** Complete resource timing report. */
export interface ResourceTimingResult {
  /** Navigation timing summary. */
  navigation: NavigationTiming | null;
  /** Resource timing entries (sorted by duration). */
  resources: ResourceTimingEntry[];
  /** Total resource count. */
  totalResources: number;
  /** Total transfer size in bytes. */
  totalTransferSize: number;
  /** Summary of slow resources (>200ms). */
  slowResources: ResourceTimingEntry[];
  /** Page URL. */
  url: string;
}

// ───────────────────────────────────────────────────────────────────────────
// § DOM diff
// ───────────────────────────────────────────────────────────────────────────

/** A single change in the DOM diff. */
export interface DomChange {
  /** Type of change. */
  type: 'added' | 'removed' | 'modified' | 'text-changed' | 'attribute-changed';
  /** CSS selector path to the changed element. */
  path: string;
  /** Tag name of the changed element. */
  tag?: string;
  /** For added/removed: element text content. */
  text?: string;
  /** For text-changed: old text content. */
  oldText?: string;
  /** For text-changed: new text content. */
  newText?: string;
  /** For attribute-changed: attribute name. */
  attributeName?: string;
  /** For attribute-changed: old attribute value. */
  oldValue?: string;
  /** For attribute-changed: new attribute value. */
  newValue?: string;
}

/** Result of structural DOM diff between two snapshots. */
export interface DiffResult {
  /** Number of elements added. */
  additions: number;
  /** Number of elements removed. */
  removals: number;
  /** Number of elements modified. */
  modifications: number;
  /** Detailed list of changes. */
  changes: DomChange[];
  /** Whether any structural changes were detected. */
  hasChanges: boolean;
  /** Total elements in the before snapshot. */
  beforeCount: number;
  /** Total elements in the after snapshot. */
  afterCount: number;
}
