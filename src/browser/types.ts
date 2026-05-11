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
