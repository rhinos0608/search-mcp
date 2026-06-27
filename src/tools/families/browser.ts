/**
 * Consolidated Browser tool family.
 *
 * Exposes interactive browser control via Playwright + CDP as a single MCP tool
 * with a discriminated-union `action` field.
 *
 * Actions:
 *   navigate          — Navigate to a URL
 *   snapshot          — Capture accessibility tree snapshot
 *   click             — Click an element
 *   type              — Type text into a field
 *   evaluate          — Execute JavaScript in page context
 *   screenshot        — Take a screenshot
 *   extract           — Extract structured data
 *   act               — Natural language instruction (requires LLM)
 *   wait / wait_for   — Wait for conditions
 *   dialog_handle     — Handle alert/confirm/prompt dialogs
 *   iframe_context    — List frames or switch into an iframe
 *   scroll_to_load    — Infinite scroll / lazy-load handler
 *   paginate          — Auto-walk paginated content
 *   download          — Intercept file downloads
 *   table_extract     — Extract structured HTML tables
 *   network_intercept — Block resources, inject headers, modify responses
 *   resource_timing   — Navigation Timing / Resource Timing API data
 *   diff              — Structural DOM diff between snapshots
 *   pdf               — Save page as PDF (requires headless)
 *   storage           — Manage browser storage state
 *   network           — Network interception
 *   tabs              — Tab management
 *   session           — Browser session lifecycle
 */

import { z } from 'zod/v4';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { DownloadResult } from '../../browser/types.js';
import { assertSafeUrl } from '../../httpGuards.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { logger } from '../../logger.js';
import { callOpenAiChatCompletion } from '../../utils/llmChat.js';
import type { Cookie } from 'playwright-core';

// ── Action schemas (discriminated on "action") ──────────────────────────────

const navigateSchema = z.object({
  action: z.literal('navigate').describe('Navigate to a URL'),
  url: z.string().describe('The URL to navigate to'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .default('domcontentloaded')
    .describe('Navigation wait condition: load | domcontentloaded | networkidle'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .default(30000)
    .describe('Navigation timeout in ms'),
});

const snapshotSchema = z.object({
  action: z.literal('snapshot').describe('Capture accessibility tree snapshot of the page'),
  selector: z.string().optional().describe('Scope snapshot to a CSS selector'),
  includeHidden: z.boolean().optional().default(false).describe('Include hidden elements in tree'),
});

const clickSchema = z
  .object({
    action: z.literal('click').describe('Click an element'),
    target: z
      .string()
      .optional()
      .describe('Element ref (from snapshot), CSS selector, or visible text'),
    selector: z
      .string()
      .optional()
      .describe('Alias for target — use this if unsure which field to use'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
  })
  .refine((v) => !!(v.target ?? v.selector), {
    message: 'target is required (or pass selector as alias)',
    path: ['target'],
  });

const typeSchema = z
  .object({
    action: z.literal('type').describe('Type text into an editable element'),
    target: z.string().optional().describe('Element ref (from snapshot) or CSS selector'),
    selector: z
      .string()
      .optional()
      .describe('Alias for target — use this if unsure which field to use'),
    text: z.string().describe('Text to type'),
    submit: z.boolean().optional().default(false).describe('Press Enter after typing'),
    slowly: z.boolean().optional().default(false).describe('Type character-by-character'),
  })
  .refine((v) => !!(v.target ?? v.selector), {
    message: 'target is required (or pass selector as alias)',
    path: ['target'],
  });

const evaluateSchema = z.object({
  action: z.literal('evaluate').describe('Execute JavaScript in the page context'),
  expression: z.string().describe('JavaScript expression or function body'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Execution timeout in ms'),
});

const screenshotSchema = z.object({
  action: z.literal('screenshot').describe('Take a screenshot of the page or element'),
  fullPage: z.boolean().optional().default(false).describe('Capture full scrollable page'),
  type: z.enum(['png', 'jpeg']).optional().default('png'),
  quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (1-100)'),
});

const extractSchema = z.object({
  action: z.literal('extract').describe('Extract structured data from the page'),
  instruction: z
    .string()
    .optional()
    .describe('Natural language extraction instruction (requires LLM config)'),
});

const actSchema = z.object({
  action: z
    .literal('act')
    .describe('Execute a natural-language instruction by chaining browser actions'),
  instruction: z
    .string()
    .describe('NL instruction (e.g., "Click login, fill email, press submit")'),
  timeout: z
    .number()
    .int()
    .min(5000)
    .max(300000)
    .optional()
    .default(60000)
    .describe('Max execution time in ms'),
});

const waitSchema = z.object({
  action: z.literal('wait').describe('Wait for a condition on the page'),
  time: z.number().min(0.1).max(60).optional().describe('Seconds to wait'),
  text: z.string().optional().describe('Wait for text to appear'),
  textGone: z.string().optional().describe('Wait for text to disappear'),
  selector: z.string().optional().describe('Wait for CSS selector to appear'),
  loadState: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .describe('Wait for page load state'),
});

const pdfSchema = z.object({
  action: z.literal('pdf').describe('Save current page as PDF'),
  format: z.string().optional().default('A4').describe('Page format (e.g., A4, Letter)'),
  landscape: z.boolean().optional().default(false),
});

const storageSchema = z.object({
  action: z.literal('storage').describe('Manage browser storage state'),
  op: z
    .enum(['save', 'restore', 'list-cookies', 'clear-cookies', 'list-profiles'])
    .describe('Storage operation'),
  filename: z.string().optional().describe('Profile name for save/restore'),
});

const networkSchema = z.object({
  action: z.literal('network').describe('Network interception and monitoring'),
  op: z
    .enum(['list-requests', 'get-request', 'route', 'unroute', 'set-state'])
    .describe('Network operation'),
  pattern: z.string().optional().describe('URL pattern for route'),
  index: z.number().int().min(1).optional().describe('Request index for get-request'),
  state: z.enum(['online', 'offline']).optional().describe('Network state for set-state'),
});

const tabsSchema = z.object({
  action: z.literal('tabs').describe('Tab management'),
  op: z.enum(['list', 'new', 'close', 'select']).describe('Tab operation'),
  index: z.number().int().min(0).optional().describe('Tab index'),
  url: z.string().optional().describe('URL for new tab'),
});

const sessionSchema = z.object({
  action: z.literal('session').describe('Browser session lifecycle management'),
  op: z.enum(['start', 'close', 'status', 'discover']).describe('Session operation'),
  headless: z.boolean().optional().default(true).describe('Run browser in headless mode'),
  profile: z.string().optional().describe('Persistent profile name'),
  cdpEndpoint: z.string().optional().describe('Connect to existing CDP endpoint (ws://...)'),
  mode: z
    .enum(['stealth', 'user', 'profile'])
    .optional()
    .describe(
      'Browser mode: stealth (headless CDP), user (connect to your browser), profile (persistent Chrome profile)',
    ),
  browserPort: z
    .number()
    .int()
    .min(0)
    .max(65535)
    .optional()
    .describe('CDP port for user-browser mode (0 = auto-detect 9222, 9223, 9229)'),
  browserEngine: z
    .enum(['playwright', 'cloak'])
    .optional()
    .describe('Browser backend: playwright (default) or cloak (optional CloakBrowser package)'),
});

// ── New action schemas (V4.1) ────────────────────────────────────────────────

const waitForSchema = z.object({
  action: z.literal('wait_for').describe('Wait for one or more condition-based element states'),
  conditions: z
    .array(
      z.object({
        condition: z.enum(['visible', 'gone', 'has-text', 'count']).describe('Condition type'),
        selector: z.string().describe('CSS selector for the target element'),
        timeout: z.number().int().min(1000).max(60000).optional().describe('Max wait time in ms'),
        text: z.string().optional().describe('Expected text for has-text condition'),
        count: z.number().int().min(0).optional().describe('Expected count for count condition'),
        countOperator: z
          .enum(['>=', '<=', '==', '>', '<'])
          .optional()
          .describe('Comparison operator for count condition'),
      }),
    )
    .describe('Array of conditions to wait for in sequence'),
});

const dialogSchema = z.object({
  action: z.literal('dialog_handle').describe('Handle browser dialogs (alert/confirm/prompt)'),
  op: z
    .enum(['auto-accept', 'auto-dismiss', 'handle-current', 'stop', 'history', 'clear'])
    .describe('Dialog operation'),
  accept: z.boolean().optional().describe('Accept (true) or dismiss (false) for handle-current'),
  promptText: z.string().optional().describe('Default text for prompt dialogs when auto-accepting'),
  maxDialogs: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Max dialogs to auto-handle before stopping'),
});

const iframeSchema = z.object({
  action: z.literal('iframe_context').describe('List frames or switch into an iframe'),
  op: z
    .enum(['list', 'switch', 'main'])
    .describe('Iframe operation: list, switch (to named frame), or main (back to main frame)'),
  by: z
    .enum(['name', 'url', 'index', 'selector'])
    .optional()
    .describe('How to locate the frame (for switch)'),
  value: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Frame identifier value (for switch)'),
});

const scrollToLoadSchema = z.object({
  action: z.literal('scroll_to_load').describe('Infinite scroll / lazy-load handler'),
  maxScrolls: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum scroll operations (default 50)'),
  scrollDelayMs: z
    .number()
    .int()
    .min(100)
    .max(10000)
    .optional()
    .describe('Delay between scrolls in ms'),
  direction: z.enum(['down', 'up']).optional().describe('Scroll direction'),
  scrollPixels: z.number().int().min(50).max(5000).optional().describe('Pixels per scroll step'),
  timeoutMs: z.number().int().min(1000).max(300000).optional().describe('Max total time in ms'),
  scrollContainer: z
    .string()
    .optional()
    .describe('CSS selector for scroll container (default: window)'),
});

const paginateSchema = z.object({
  action: z.literal('paginate').describe('Auto-walk paginated content'),
  nextSelector: z
    .string()
    .optional()
    .describe('CSS selector for next link (auto-detected if omitted)'),
  maxPages: z.number().int().min(1).max(100).optional().describe('Maximum pages to collect'),
  waitBetweenMs: z
    .number()
    .int()
    .min(500)
    .max(30000)
    .optional()
    .describe('Wait between pages in ms'),
  contentSelector: z.string().optional().describe('CSS selector for content area'),
  extractMode: z.enum(['full', 'content-only']).optional().describe('Extraction mode'),
});

const downloadSchema = z.object({
  action: z.literal('download').describe('Intercept file downloads and return content'),
  op: z.enum(['intercept', 'start-collection', 'get-collected']).describe('Download operation'),
  savePath: z.string().optional().describe('Directory to save downloaded files'),
  maxSize: z
    .number()
    .int()
    .min(1)
    .max(500000000)
    .optional()
    .describe('Maximum download size in bytes'),
  trigger: z
    .object({
      action: z.string().describe('Action to trigger download (click, navigate)'),
      target: z.string().optional().describe('Target for click action'),
      url: z.string().optional().describe('URL for navigate action'),
    })
    .optional()
    .describe('Action to trigger the download'),
});

const tableExtractSchema = z.object({
  action: z.literal('table_extract').describe('Extract structured HTML tables'),
  selector: z.string().optional().describe('CSS selector for a specific table'),
  maxTables: z.number().int().min(1).max(50).optional().describe('Maximum tables to extract'),
  includeCaptions: z.boolean().optional().describe('Include table captions in output'),
  flattenSpans: z.boolean().optional().describe('Flatten colspan/rowspan into individual cells'),
});

const networkInterceptSchema = z.object({
  action: z
    .literal('network_intercept')
    .describe('Enhanced network interception: block, inject headers, modify responses'),
  op: z.enum(['block', 'inject', 'modify', 'unblock', 'list']).describe('Interception operation'),
  blockTypes: z
    .array(
      z.enum(['image', 'font', 'stylesheet', 'media', 'script', 'fetch', 'websocket', 'other']),
    )
    .optional()
    .describe('Resource types to block'),
  blockPatterns: z.array(z.string()).optional().describe('URL patterns to block (glob-style)'),
  allowPatterns: z
    .array(z.string())
    .optional()
    .describe('URL patterns to allow (overrides blocks)'),
  injectPatterns: z.array(z.string()).optional().describe('URL patterns for header injection'),
  injectHeaders: z
    .record(z.string(), z.string())
    .optional()
    .describe('Headers to inject {key: value}'),
  modifyPatterns: z.array(z.string()).optional().describe('URL patterns for response modification'),
  modifyStatus: z.number().int().min(100).max(599).optional().describe('New HTTP status code'),
  modifyBody: z.string().optional().describe('Replacement response body'),
  modifyHeaders: z
    .record(z.string(), z.string())
    .optional()
    .describe('Replacement response headers'),
});

const resourceTimingSchema = z.object({
  action: z
    .literal('resource_timing')
    .describe('Return Navigation Timing and Resource Timing API data'),
});

const diffSchema = z.object({
  action: z
    .literal('diff')
    .describe('Take a DOM snapshot, perform actions, return structural diff'),
  actions: z
    .array(
      z.object({
        action: z
          .enum(['click', 'type', 'select', 'wait', 'navigate', 'scroll'])
          .describe('Action to perform'),
        target: z.string().optional().describe('Target selector'),
        value: z.string().optional().describe('Value (for type/select)'),
        time: z.number().optional().describe('Wait time in seconds'),
      }),
    )
    .describe('Actions to perform between snapshots'),
  selector: z.string().optional().describe('Scope diff to a CSS selector (default: body)'),
  maxChanges: z.number().int().min(1).max(500).optional().describe('Maximum changes to report'),
});

// ── Config gates ─────────────────────────────────────────────────────────────

function browserDisabledIssue(cfg: SearchConfig): string | null {
  if (!cfg.browser.enabled) {
    return 'Set BROWSER_ENABLED=true to enable interactive browser control via Playwright/CDP or CloakBrowser.';
  }
  return null;
}

function llmRequiredForAct(cfg: SearchConfig): string | null {
  if (!cfg.llm.provider) {
    return 'LLM provider not configured. Set LLM_PROVIDER to use browser.act (e.g., "gpt-4o-mini" for OpenAI-compatible endpoint).';
  }
  return null;
}

// ── Session management helpers (lazy-load browser module) ────────────────────

/** Track which pages have request tracking active to avoid duplicate listeners. */
const trackingPages = new WeakSet();

/** Track download collectors per page to avoid casting Page to Record<string, unknown>. */
const downloadCollectors = new WeakMap<
  object,
  { cleanup: () => void; waitForDownloads: () => Promise<DownloadResult[]> }
>();

async function getOrCreateSession(
  cfg: SearchConfig,
  opts?: {
    headless?: boolean;
    profile?: string;
    cdpEndpoint?: string;
    mode?: string;
    browserPort?: number;
    browserEngine?: string;
    cloakHumanize?: boolean;
    cloakHumanPreset?: 'default' | 'careful';
    cloakLocale?: string;
    cloakTimezone?: string;
    cloakGeoip?: boolean;
    cloakStealthArgs?: boolean;
  },
): Promise<{ sessionId: string; mode: string }> {
  const { BrowserError } = await import('../../browser/types.js');
  const { browserManager } = await import('../../browser/browserManager.js');

  // Determine the effective mode for this request
  const requestedMode = opts?.mode;
  const effectiveMode: 'stealth' | 'user' | 'profile' =
    requestedMode === 'stealth' || requestedMode === 'user' || requestedMode === 'profile'
      ? requestedMode
      : cfg.browser.mode;

  const existing = browserManager.getActiveSession();
  if (existing) {
    const currentMode = browserManager.getMode();
    // If modes match, reuse the session
    if (currentMode === effectiveMode) {
      return { sessionId: existing.id, mode: currentMode };
    }
    // Modes differ — reject with clear error
    throw new BrowserError(
      `A ${currentMode ?? 'unknown'} session is already active. ` +
        `Close it first before starting a ${effectiveMode} session. ` +
        `Use browser.session { op: "close" }.`,
      'MODE_MISMATCH',
    );
  }

  const config = {
    headless: opts?.headless ?? cfg.browser.headless,
    viewport: cfg.browser.viewport,
    userAgent: cfg.browser.userAgent,
    proxyServer: cfg.browser.proxyServer,
    executablePath: cfg.browser.executablePath,
    profile: opts?.profile ?? (cfg.browser.profileDir || null),
    stealthEnabled: cfg.browser.stealthEnabled,
    rebrowser: cfg.browser.rebrowser,
    maxSessionTimeMs: cfg.browser.maxSessionTimeMs,
    bypassCSP: cfg.browser.bypassCSP,
    credentials: cfg.browser.credentials,
    browserEngine:
      opts?.browserEngine === 'cloak' || opts?.browserEngine === 'playwright'
        ? opts.browserEngine
        : cfg.browser.browserEngine,
    cloakHumanize: opts?.cloakHumanize ?? cfg.browser.cloakHumanize,
    cloakHumanPreset: opts?.cloakHumanPreset ?? cfg.browser.cloakHumanPreset,
    cloakLocale: opts?.cloakLocale ?? cfg.browser.cloakLocale,
    cloakTimezone: opts?.cloakTimezone ?? cfg.browser.cloakTimezone,
    cloakGeoip: opts?.cloakGeoip ?? cfg.browser.cloakGeoip,
    cloakStealthArgs: opts?.cloakStealthArgs ?? cfg.browser.cloakStealthArgs,
  };

  // Mode: user-browser (connect to user's Chrome)
  if (effectiveMode === 'user') {
    const port = opts?.browserPort ?? cfg.browser.browserPort;
    try {
      const session = await browserManager.connectToUserBrowser(port === 0 ? 'auto' : port, config);
      return { sessionId: session.id, mode: 'user' };
    } catch (err) {
      if (cfg.browser.autoConnect) {
        // autoConnect: fall back to stealth mode instead of failing
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'User browser not available (autoConnect=true) — falling back to stealth mode',
        );
      } else {
        throw err;
      }
    }
  }

  // Mode: profile (persistent Chrome profile)
  if (effectiveMode === 'profile') {
    const profileName = opts?.profile ?? cfg.browser.profileDir;
    if (!profileName) {
      throw new Error(
        'Profile name is required for profile mode. Set BROWSER_PROFILE_DIR or pass profile parameter.',
      );
    }
    const sessionConfig = { ...config, profile: profileName };
    const session = await browserManager.launchWithProfile(sessionConfig);
    return { sessionId: session.id, mode: 'profile' };
  }

  // Mode: stealth (default — headless CDP)
  if (opts?.cdpEndpoint) {
    const session = await browserManager.connect({ endpoint: opts.cdpEndpoint }, config);
    return { sessionId: session.id, mode: 'stealth' };
  }

  const session = await browserManager.launch(config);
  return { sessionId: session.id, mode: 'stealth' };
}

async function withSession<T>(
  cfg: SearchConfig,
  fn: (
    page: NonNullable<
      ReturnType<typeof import('../../browser/browserManager.js').browserManager.getActiveSession>
    >['page'],
  ) => Promise<T>,
): Promise<T> {
  const { browserManager } = await import('../../browser/browserManager.js');

  // Auto-create a session if none exists (lazy init)
  let session = browserManager.getActiveSession();
  if (!session) {
    await getOrCreateSession(cfg);
    session = browserManager.getActiveSession();
  }

  if (!session) {
    throw new Error('No active browser session. Use browser.session { op: "start" } first.');
  }
  browserManager.touchSession(session, cfg.browser.maxSessionTimeMs);
  return fn(session.page);
}

// ── Family definition ───────────────────────────────────────────────────────

const browserFamily: FamilyDefinition = {
  name: 'browser',
  description:
    'Interactive browser control via Playwright + CDP, with optional CloakBrowser launch backend. Use the `action` field to choose: ' +
    '"navigate" to go to a URL, "snapshot" to capture the page structure as accessible elements, ' +
    '"click"/"type" to interact, "evaluate" to run JavaScript, "screenshot" to capture images, ' +
    '"extract" to pull structured data, "act" for natural-language instructions, ' +
    '"wait" / "wait_for" for conditions, "dialog_handle" for alert/confirm/prompt, ' +
    '"iframe_context" to switch frames, "scroll_to_load" for infinite scroll, ' +
    '"paginate" to walk paginated content, "download" to intercept file downloads, ' +
    '"table_extract" for structured tables, "network_intercept" to block/inject/modify requests, ' +
    '"resource_timing" for performance data, "diff" for DOM change detection, ' +
    'and "session" / "tabs" / "storage" / "network" / "pdf" for lifecycle management.',
  actions: [
    // ── navigate ──────────────────────────────────────────────────────────
    {
      name: 'navigate',
      description: 'Navigate the browser to a URL',
      schema: navigateSchema,
      handler: async (args, cfg) => {
        const { url, waitUntil, timeout } = args as {
          url: string;
          waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
          timeout: number;
        };
        assertSafeUrl(url);
        return withSession(cfg, async (page) => {
          await page.goto(url, { waitUntil, timeout });
          // Invalidate snapshot refs and iframe context after navigation
          const { browserManager } = await import('../../browser/browserManager.js');
          const session = browserManager.getActiveSession();
          if (session) {
            session.lastSnapshotRoot = null;
            // Clear stale iframe reference — new page means detached frames
            const { activeFrameByPage } = await import('../../browser/iframeContext.js');
            activeFrameByPage.delete(page);
          }
          return { url: page.url(), title: await page.title() };
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── snapshot ──────────────────────────────────────────────────────────
    {
      name: 'snapshot',
      description: 'Capture accessibility tree snapshot of the current page',
      schema: snapshotSchema,
      handler: async (args, cfg) => {
        const { selector, includeHidden } = args as { selector?: string; includeHidden: boolean };
        return withSession(cfg, async (page) => {
          const { captureSnapshot } = await import('../../browser/snapshot.js');
          const opts: { includeHidden?: boolean; selector?: string } = { includeHidden };
          if (selector !== undefined) opts.selector = selector;
          const result = await captureSnapshot(page, opts);
          // Store snapshot root on session for ref-based click/type targeting
          const { browserManager } = await import('../../browser/browserManager.js');
          const activeSession = browserManager.getActiveSession();
          if (activeSession) activeSession.lastSnapshotRoot = result.root;
          return result;
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── click ─────────────────────────────────────────────────────────────
    {
      name: 'click',
      description: 'Click an element by ref, CSS selector, or visible text',
      schema: clickSchema,
      handler: async (args, cfg) => {
        const rawArgs = args;
        const explicitSelector =
          typeof rawArgs.selector === 'string' && rawArgs.selector ? rawArgs.selector : undefined;
        const target =
          typeof rawArgs.target === 'string' && rawArgs.target
            ? rawArgs.target
            : (explicitSelector ?? '');
        const { button, doubleClick } = rawArgs as {
          button: 'left' | 'right' | 'middle';
          doubleClick: boolean;
        };
        return withSession(cfg, async (page) => {
          const { click, resolveRefTarget } = await import('../../browser/actions.js');
          // When selector was explicitly provided, treat it as CSS selector directly
          if (explicitSelector !== undefined) {
            return click(
              page,
              { type: 'selector', selector: explicitSelector },
              { button, doubleClick },
            );
          }
          // Detect ref targets: "ref:e20" prefix or bare "e20" pattern
          const refId = target.startsWith('ref:')
            ? target.slice(4)
            : /^e\d+$/.test(target)
              ? target
              : null;
          if (refId) {
            try {
              const { browserManager } = await import('../../browser/browserManager.js');
              const session = browserManager.getActiveSession();
              const snapshotRoot = session?.lastSnapshotRoot;
              if (!snapshotRoot) {
                return {
                  success: false,
                  message: `Cannot resolve ref "${refId}" — no snapshot captured yet. Use the snapshot action first, then retry click with this ref.`,
                };
              }
              const locator = resolveRefTarget(page, snapshotRoot, refId);
              if (doubleClick) {
                await locator.dblclick({ button });
              } else {
                await locator.click({ button });
              }
              return { success: true, message: `Click on ref "${refId}" succeeded` };
            } catch (err) {
              return {
                success: false,
                message: `Click on ref "${refId}" failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          // Existing CSS/text targeting
          const targetObj =
            target.startsWith('#') || target.startsWith('.') || target.startsWith('[')
              ? { type: 'selector' as const, selector: target }
              : { type: 'text' as const, text: target };
          return click(page, targetObj, { button, doubleClick });
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── type ─────────────────────────────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into an editable element',
      schema: typeSchema,
      handler: async (args, cfg) => {
        const rawArgs = args;
        const explicitSelector =
          typeof rawArgs.selector === 'string' && rawArgs.selector ? rawArgs.selector : undefined;
        const target =
          typeof rawArgs.target === 'string' && rawArgs.target
            ? rawArgs.target
            : (explicitSelector ?? '');
        const { text, submit, slowly } = rawArgs as {
          text: string;
          submit: boolean;
          slowly: boolean;
        };
        return withSession(cfg, async (page) => {
          const { typeText, resolveRefTarget } = await import('../../browser/actions.js');
          // When selector was explicitly provided, treat it as CSS selector directly
          if (explicitSelector !== undefined) {
            return typeText(page, { type: 'selector', selector: explicitSelector }, text, {
              submit,
              slowly,
            });
          }
          // Detect ref targets: "ref:e20" prefix or bare "e20" pattern
          const refId = target.startsWith('ref:')
            ? target.slice(4)
            : /^e\d+$/.test(target)
              ? target
              : null;
          if (refId) {
            try {
              const { browserManager } = await import('../../browser/browserManager.js');
              const session = browserManager.getActiveSession();
              const snapshotRoot = session?.lastSnapshotRoot;
              if (!snapshotRoot) {
                return {
                  success: false,
                  message: `Cannot resolve ref "${refId}" — no snapshot captured yet. Use the snapshot action first, then retry type with this ref.`,
                };
              }
              const locator = resolveRefTarget(page, snapshotRoot, refId);
              if (slowly) {
                await locator.pressSequentially(text);
              } else {
                await locator.fill(text);
              }
              if (submit) await page.keyboard.press('Enter');
              return { success: true, message: `Type on ref "${refId}" succeeded` };
            } catch (err) {
              return {
                success: false,
                message: `Type on ref "${refId}" failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          // Existing CSS/text targeting
          const targetObj =
            target.startsWith('#') || target.startsWith('.') || target.startsWith('[')
              ? { type: 'selector' as const, selector: target }
              : { type: 'text' as const, text: target };
          return typeText(page, targetObj, text, { submit, slowly });
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── evaluate ──────────────────────────────────────────────────────────
    {
      name: 'evaluate',
      description: 'Execute JavaScript in the page context',
      schema: evaluateSchema,
      handler: async (args, cfg) => {
        const { expression, timeout } = args as { expression: string; timeout: number };
        return withSession(cfg, async (page) => {
          const { evaluateJs } = await import('../../browser/actions.js');
          return evaluateJs(page, expression, timeout);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── screenshot ────────────────────────────────────────────────────────
    {
      name: 'screenshot',
      description: 'Take a screenshot of the page',
      schema: screenshotSchema,
      handler: async (args, cfg) => {
        const { fullPage, type, quality } = args as {
          target?: string;
          fullPage: boolean;
          type: 'png' | 'jpeg';
          quality?: number;
        };
        return withSession(cfg, async (page) => {
          const { takeScreenshot } = await import('../../browser/actions.js');
          const opts: { fullPage?: boolean; type?: 'png' | 'jpeg'; quality?: number } = {
            fullPage,
            type,
          };
          if (quality !== undefined) opts.quality = quality;
          const result = await takeScreenshot(page, opts);
          const response: Record<string, unknown> = { ...result };
          if (quality !== undefined && type !== 'jpeg') {
            response.warnings = [
              'quality parameter only applies to jpeg screenshots; ignored for png',
            ];
          }
          return response;
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── extract ───────────────────────────────────────────────────────────
    {
      name: 'extract',
      description: 'Extract structured data from the page using a schema or NL instruction',
      schema: extractSchema,
      handler: async (args, cfg) => {
        const { instruction } = args as { instruction?: string; selector?: string };
        return withSession(cfg, async (page) => {
          const { extractByInstruction } = await import('../../browser/extraction.js');
          const llmConfig = cfg.llm.provider
            ? {
                provider: cfg.llm.provider,
                apiToken: cfg.llm.apiToken ?? '',
                baseUrl: cfg.llm.baseUrl,
              }
            : undefined;
          return extractByInstruction(page, instruction ?? 'Extract the main content', llmConfig);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── act ────────────────────────────────────────────────────────────────
    {
      name: 'act',
      description:
        'Execute a natural-language instruction by chaining browser actions (requires LLM)',
      schema: actSchema,
      handler: async (args, cfg) => {
        const { instruction, timeout } = args as { instruction: string; timeout: number };
        return withSession(cfg, async (page) => {
          const startTime = Date.now();
          const timeBudget = timeout;

          // Helper to call LLM for action planning
          async function callLlmForActions(
            _pageState: string,
            instr: string,
            stateSnippetArg: string,
          ): Promise<unknown[]> {
            const url = page.url();
            const title = await page.title();
            const promptContent =
              'Page URL: ' +
              url +
              '\n' +
              'Page Title: ' +
              title +
              '\n' +
              'Page snapshot: ' +
              stateSnippetArg +
              '\n' +
              'Instruction: ' +
              instr;

            const response = await callOpenAiChatCompletion({
              baseUrl: cfg.llm.baseUrl || 'https://api.openai.com',
              model: cfg.llm.provider,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a browser automation assistant. Given a page state and a natural language instruction, return a JSON array of actions to perform. Each action has: { "action": string (one of: navigate, click, type, wait, scroll, press, screenshot, extract, select), "target": string (CSS selector or visible text, omit for screenshot/wait), "value": string (text for type, seconds for wait, pixel amount for scroll, key name for press), "submit": boolean (optional, for type actions to press Enter after). Return ONLY valid JSON — no explanation, no markdown fences. Respond with an empty array if no actions are needed.',
                },
                {
                  role: 'user',
                  content: promptContent,
                },
              ],
              ...(cfg.llm.apiToken ? { apiToken: cfg.llm.apiToken } : {}),
              temperature: 0.3,
              maxTokens: 2048,
            });
            if (!response.success) {
              throw new Error(response.error ?? 'LLM action planning failed');
            }
            const content = response.content;
            try {
              return JSON.parse(content) as unknown[];
            } catch (parseErr) {
              logger.error(
                { err: String(parseErr), content: content.slice(0, 200) },
                'LLM act response is not valid JSON',
              );
              return [];
            }
          }

          // Get page state snapshot
          const bodyText = await page.evaluate(() => {
            /* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/prefer-nullish-coalescing */
            const walk = (el: Element, depth: number): unknown => {
              if (depth <= 0 || el.nodeType !== 1) return null;
              const tag = el.tagName.toLowerCase();
              const role = el.getAttribute('role') || tag;
              const name = el.getAttribute('aria-label') || '';
              const text = (el.textContent || '').trim().slice(0, 100);
              const children: unknown[] = [];
              for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
                const cn = walk(c, depth - 1);
                if (cn) children.push(cn);
              }
              if (!name && !text && children.length === 0) return null;
              return { role, name: name || text.slice(0, 60), tag };
            };
            const root = document.body || document.documentElement;
            return walk(root, 8);
          });
          const pageState = JSON.stringify(bodyText);
          const stateSnippet = pageState.slice(0, 3000);

          // Get action plan from LLM
          const plan = await callLlmForActions(stateSnippet, instruction, stateSnippet);
          if (!Array.isArray(plan) || plan.length === 0) {
            return {
              actions: [],
              result: 'No actions generated — instruction may be ambiguous or already satisfied.',
            };
          }

          // Execute each action
          const results: { action: string; success: boolean; message: string; data?: string }[] =
            [];
          for (const step of plan) {
            if (Date.now() - startTime > timeBudget) {
              results.push({
                action: 'timeout',
                success: false,
                message: 'Timed out — budget exhausted',
              });
              break;
            }
            const s = step as Record<string, unknown>;
            const actionName = typeof s.action === 'string' ? s.action : '';
            const target = typeof s.target === 'string' ? s.target : '';
            const value = typeof s.value === 'string' ? s.value : '';
            const submit = !!s.submit;
            try {
              switch (actionName) {
                case 'navigate': {
                  assertSafeUrl(target);
                  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 });
                  results.push({
                    action: 'navigate',
                    success: true,
                    message: `Navigated to ${target}`,
                  });
                  break;
                }
                case 'click': {
                  if (!target) {
                    results.push({
                      action: 'click',
                      success: false,
                      message: 'No target provided',
                    });
                    break;
                  }
                  if (
                    target.startsWith('#') ||
                    target.startsWith('.') ||
                    target.startsWith('[') ||
                    target.startsWith(':')
                  ) {
                    await page.locator(target).click();
                  } else {
                    await page.getByText(target, { exact: false }).first().click();
                  }
                  results.push({ action: 'click', success: true, message: `Clicked ${target}` });
                  break;
                }
                case 'type': {
                  if (!target) {
                    results.push({ action: 'type', success: false, message: 'No target provided' });
                    break;
                  }
                  if (
                    target.startsWith('#') ||
                    target.startsWith('.') ||
                    target.startsWith('[') ||
                    target.startsWith(':')
                  ) {
                    await page.locator(target).fill(value);
                  } else {
                    await page.getByText(target, { exact: false }).first().fill(value);
                  }
                  if (submit) {
                    await page.keyboard.press('Enter');
                  }
                  results.push({ action: 'type', success: true, message: `Typed into ${target}` });
                  break;
                }
                case 'wait': {
                  const parsedSec = parseFloat(value || '1');
                  const seconds = Number.isNaN(parsedSec) ? 1 : parsedSec;
                  await page.waitForTimeout(Math.min(seconds, 30) * 1000);
                  results.push({
                    action: 'wait',
                    success: true,
                    message: `Waited ${String(seconds)}s`,
                  });
                  break;
                }
                case 'scroll': {
                  const parsedPx = parseInt(value || '300', 10);
                  const pixels = Number.isNaN(parsedPx) ? 300 : parsedPx;
                  await page.mouse.wheel(0, pixels);
                  results.push({
                    action: 'scroll',
                    success: true,
                    message: `Scrolled ${String(pixels)}px`,
                  });
                  break;
                }
                case 'press': {
                  await page.keyboard.press(value || 'Enter');
                  results.push({
                    action: 'press',
                    success: true,
                    message: `Pressed ${value || 'Enter'}`,
                  });
                  break;
                }
                case 'screenshot': {
                  const { takeScreenshot } = await import('../../browser/actions.js');
                  const shot = await takeScreenshot(page, { fullPage: true });
                  results.push({
                    action: 'screenshot',
                    success: shot.success,
                    message: shot.success ? 'Screenshot taken' : shot.message,
                  });
                  break;
                }
                case 'extract': {
                  const text = await page.evaluate(() => document.body.innerText);
                  results.push({
                    action: 'extract',
                    success: true,
                    message: 'Content extracted',
                    data: text.slice(0, 5000),
                  });
                  break;
                }
                case 'select': {
                  if (!target) {
                    results.push({
                      action: 'select',
                      success: false,
                      message: 'No target provided',
                    });
                    break;
                  }
                  const values = value
                    .split(',')
                    .map((v: string) => v.trim())
                    .filter(Boolean);
                  if (values.length === 0) {
                    results.push({
                      action: 'select',
                      success: false,
                      message: `Select requires a value for ${target}`,
                    });
                    break;
                  }
                  await page.locator(target).selectOption(values);
                  results.push({
                    action: 'select',
                    success: true,
                    message: `Selected in ${target}`,
                  });
                  break;
                }
                default: {
                  results.push({
                    action: actionName,
                    success: false,
                    message: `Unknown action: ${actionName}`,
                  });
                }
              }
            } catch (actionErr) {
              results.push({
                action: actionName,
                success: false,
                message: `${actionName} failed: ${actionErr instanceof Error ? actionErr.message : String(actionErr)}`,
              });
            }
          }

          return {
            actions: results,
            totalActions: results.length,
            succeeded: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            finalUrl: page.url(),
            finalTitle: await page.title(),
          };
        });
      },
      configIssue: (cfg) => {
        const disabled = browserDisabledIssue(cfg);
        if (disabled) return disabled;
        return llmRequiredForAct(cfg);
      },
    },
    // ── wait ──────────────────────────────────────────────────────────────
    {
      name: 'wait',
      description: 'Wait for a condition (time, text, selector, or load state)',
      schema: waitSchema,
      handler: async (args, cfg) => {
        const { time, text, textGone, selector, loadState } = args as {
          time?: number;
          text?: string;
          textGone?: string;
          selector?: string;
          loadState?: 'load' | 'domcontentloaded' | 'networkidle';
        };
        return withSession(cfg, async (page) => {
          const { waitFor } = await import('../../browser/actions.js');
          const opts: Record<string, unknown> = {};
          if (time !== undefined) opts.time = time;
          if (text !== undefined) opts.text = text;
          if (textGone !== undefined) opts.textGone = textGone;
          if (selector !== undefined) opts.selector = selector;
          if (loadState !== undefined) opts.loadState = loadState;
          return waitFor(page, opts);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── pdf ────────────────────────────────────────────────────────────────
    {
      name: 'pdf',
      description: 'Save current page as PDF (requires headless mode)',
      schema: pdfSchema,
      handler: async (args, cfg) => {
        const { format, landscape } = args as {
          filename?: string;
          format: string;
          landscape: boolean;
        };
        const allowedFormats = new Set([
          'Letter',
          'Legal',
          'Tabloid',
          'Ledger',
          'A0',
          'A1',
          'A2',
          'A3',
          'A4',
          'A5',
          'A6',
        ]);
        const safeFormat = allowedFormats.has(format) ? format : 'A4';
        return withSession(cfg, async (page) => {
          const buffer = await page.pdf({ format: safeFormat, landscape, printBackground: true });
          return { data: buffer.toString('base64'), contentType: 'application/pdf' };
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── storage ───────────────────────────────────────────────────────────
    {
      name: 'storage',
      description: 'Manage browser storage (save/restore profiles, list/clear cookies)',
      schema: storageSchema,
      handler: async (args, cfg) => {
        const { op, filename } = args as { op: string; filename?: string };
        return withSession(cfg, async (page) => {
          const { sessionStore } = await import('../../browser/session.js');
          switch (op) {
            case 'save': {
              if (!filename) throw new Error('filename is required for storage.save');
              await sessionStore.saveProfile(filename, page.context());
              return { saved: filename };
            }
            case 'restore': {
              const state = filename ? await sessionStore.loadProfile(filename) : null;
              if (state) {
                await page.context().addCookies((state as { cookies: Cookie[] }).cookies);
              }
              return { restored: state !== null };
            }
            case 'list-cookies': {
              const cookies = await page.context().cookies();
              return { cookies };
            }
            case 'clear-cookies': {
              await page.context().clearCookies();
              return { cleared: true };
            }
            case 'list-profiles': {
              const profiles = await sessionStore.listProfiles();
              return { profiles };
            }
            default:
              throw new Error(`Unknown storage op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── network ───────────────────────────────────────────────────────────
    {
      name: 'network',
      description: 'Network interception and monitoring',
      schema: networkSchema,
      handler: async (args, cfg) => {
        const { op, pattern, index, state } = args as {
          op: string;
          pattern?: string;
          index?: number;
          state?: 'online' | 'offline';
        };
        return withSession(cfg, async (page) => {
          const {
            listRequests,
            getRequestDetails,
            addRoute,
            removeRoute,
            startRequestTracking,
            setNetworkState,
          } = await import('../../browser/network.js');
          switch (op) {
            case 'list-requests': {
              let filter: RegExp | undefined;
              if (pattern) {
                try {
                  filter = new RegExp(pattern);
                } catch {
                  throw new Error(`Invalid regex pattern: ${pattern}`);
                }
              }
              return { requests: listRequests(page, filter) };
            }
            case 'get-request': {
              if (!index) throw new Error('index is required for network.get-request');
              return { request: getRequestDetails(page, index) };
            }
            case 'route': {
              if (!pattern) throw new Error('pattern is required for network.route');
              if (!trackingPages.has(page)) {
                startRequestTracking(page);
                trackingPages.add(page);
              }
              await addRoute(page, pattern, { type: 'continue' });
              return { routed: pattern };
            }
            case 'unroute': {
              await removeRoute(page, pattern);
              const { stopRequestTracking: stopTracking } =
                await import('../../browser/network.js');
              stopTracking(page);
              trackingPages.delete(page);
              return { unrouted: true };
            }
            case 'set-state': {
              if (!state) throw new Error('state is required for network.set-state');
              await setNetworkState(page, state);
              return { networkState: state };
            }
            default:
              throw new Error(`Unknown network op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── tabs ──────────────────────────────────────────────────────────────
    {
      name: 'tabs',
      description: 'Tab management: list, create, close, select',
      schema: tabsSchema,
      handler: async (args, _cfg) => {
        const { op, index, url } = args as { op: string; index?: number; url?: string };
        const { browserManager } = await import('../../browser/browserManager.js');
        const session = browserManager.getActiveSession();
        if (!session) throw new Error('No active browser session');
        browserManager.touchSession(session, _cfg.browser.maxSessionTimeMs);
        switch (op) {
          case 'list': {
            // Re-derive pages from context to avoid stale references
            session.pages = session.context.pages();
            const tabs = session.pages.map((p, i) => ({
              index: i,
              url: p.url(),
              isActive: p === session.page,
            }));
            return { tabs, activeIndex: session.pages.indexOf(session.page) };
          }
          case 'new': {
            const newPage = await session.context.newPage();
            session.pages.push(newPage);
            if (url) {
              assertSafeUrl(url);
              await newPage.goto(url);
            }
            return { index: session.pages.length - 1, url: newPage.url() };
          }
          case 'close': {
            if (index === undefined) throw new Error('index is required for tabs.close');
            session.pages = session.context.pages();
            const page = session.pages[index];
            if (!page) throw new Error(`No tab at index ${String(index)}`);
            await page.close();
            session.pages.splice(index, 1);
            // If we closed the active tab, switch to nearest
            if (page === session.page) {
              const replacement =
                session.pages[Math.min(index, session.pages.length - 1)] ??
                (await session.context.newPage());
              // Add new pages created by context.newPage() to session.pages
              if (!session.pages.includes(replacement)) {
                session.pages.push(replacement);
              }
              session.page = replacement;
              session.lastSnapshotRoot = null;
            }
            return { closed: index, activeIndex: session.pages.indexOf(session.page) };
          }
          case 'select': {
            if (index === undefined) throw new Error('index is required for tabs.select');
            session.pages = session.context.pages();
            const page = session.pages[index];
            if (!page) throw new Error(`No tab at index ${String(index)}`);
            await page.bringToFront();
            session.page = page;
            session.lastSnapshotRoot = null;
            return { selected: index, url: session.page.url() };
          }
          default:
            throw new Error(`Unknown tabs op: ${op}`);
        }
      },
      configIssue: browserDisabledIssue,
    },
    // ── session ───────────────────────────────────────────────────────────
    {
      name: 'session',
      description:
        'Browser session lifecycle: start, close, check status, or discover user browsers',
      schema: sessionSchema,
      handler: async (args, cfg) => {
        const { op, headless, profile, cdpEndpoint, mode, browserPort, browserEngine } = args as {
          op: string;
          headless?: boolean;
          profile?: string;
          cdpEndpoint?: string;
          mode?: string;
          browserPort?: number;
          browserEngine?: string;
        };
        // Cloak params removed from schema; use server config defaults
        const cloakHumanize = cfg.browser.cloakHumanize;
        const cloakHumanPreset = cfg.browser.cloakHumanPreset as 'default' | 'careful' | undefined;
        const cloakLocale = cfg.browser.cloakLocale;
        const cloakTimezone = cfg.browser.cloakTimezone;
        const cloakGeoip = cfg.browser.cloakGeoip;
        const cloakStealthArgs = cfg.browser.cloakStealthArgs;
        const { browserManager } = await import('../../browser/browserManager.js');
        switch (op) {
          case 'start': {
            const sessionOpts: Record<string, unknown> = {};
            if (headless !== undefined) sessionOpts.headless = headless;
            if (profile !== undefined) sessionOpts.profile = profile;
            if (cdpEndpoint !== undefined) sessionOpts.cdpEndpoint = cdpEndpoint;
            if (mode !== undefined) sessionOpts.mode = mode;
            if (browserPort !== undefined) sessionOpts.browserPort = browserPort;
            if (browserEngine !== undefined) sessionOpts.browserEngine = browserEngine;
            if (cloakHumanize !== undefined) sessionOpts.cloakHumanize = cloakHumanize;
            if (cloakHumanPreset !== undefined) sessionOpts.cloakHumanPreset = cloakHumanPreset;
            if (cloakLocale !== undefined) sessionOpts.cloakLocale = cloakLocale;
            if (cloakTimezone !== undefined) sessionOpts.cloakTimezone = cloakTimezone;
            if (cloakGeoip !== undefined) sessionOpts.cloakGeoip = cloakGeoip;
            if (cloakStealthArgs !== undefined) sessionOpts.cloakStealthArgs = cloakStealthArgs;
            const session = await getOrCreateSession(cfg, sessionOpts);
            return session;
          }
          case 'close': {
            const session = browserManager.getActiveSession();
            if (session) {
              await browserManager.close(session);
              return { closed: true };
            }
            return { closed: false, message: 'No active session' };
          }
          case 'status': {
            const session = browserManager.getActiveSession();
            if (!session) return { active: false, message: 'No active session' };
            return { active: true, ...browserManager.getStatus(session) };
          }
          case 'discover': {
            const browsers = await browserManager.discoverUserBrowsers(
              browserPort ? [...new Set([browserPort, 9222, 9223, 9229])] : undefined,
            );
            return {
              browsers,
              hint:
                browsers.length === 0
                  ? 'No Chrome instances found with remote debugging enabled. Start Chrome with: chrome --remote-debugging-port=9222 and ensure chrome://inspect/#remote-debugging is enabled.'
                  : null,
            };
          }
          default:
            throw new Error(`Unknown session op: ${op}`);
        }
      },
      configIssue: browserDisabledIssue,
    },
    // ── wait_for (condition-based) ────────────────────────────────────────
    {
      name: 'wait_for',
      description: 'Wait for condition-based element state (visible, gone, has-text, count)',
      schema: waitForSchema,
      handler: async (args, cfg) => {
        const { conditions } = args as {
          conditions: {
            condition: 'visible' | 'gone' | 'has-text' | 'count';
            selector: string;
            timeout?: number;
            text?: string;
            count?: number;
            countOperator?: '>=' | '<=' | '==' | '>' | '<';
          }[];
        };
        return withSession(cfg, async (page) => {
          const { waitForConditions } = await import('../../browser/waitForEnhanced.js');
          const results = await waitForConditions(page, conditions);
          return {
            results,
            allSatisfied: results.every((r) => r.satisfied),
            totalConditions: results.length,
            satisfiedCount: results.filter((r) => r.satisfied).length,
          };
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── dialog_handle ─────────────────────────────────────────────────────
    {
      name: 'dialog_handle',
      description: 'Handle browser dialogs (alert, confirm, prompt)',
      schema: dialogSchema,
      handler: async (args, cfg) => {
        const { op, accept, promptText, maxDialogs } = args as {
          op: string;
          accept?: boolean;
          promptText?: string;
          maxDialogs?: number;
        };
        return withSession(cfg, async (page) => {
          const {
            startDialogHandler,
            stopDialogHandler,
            handleCurrentDialog,
            getDialogHistory,
            clearDialogHistory,
          } = await import('../../browser/dialogs.js');

          switch (op) {
            case 'auto-accept':
              startDialogHandler(page, {
                accept: true,
                promptText: promptText ?? '',
                maxDialogs: maxDialogs ?? 50,
              });
              return { started: true, mode: 'auto-accept' };
            case 'auto-dismiss':
              startDialogHandler(page, {
                accept: false,
                maxDialogs: maxDialogs ?? 50,
              });
              return { started: true, mode: 'auto-dismiss' };
            case 'handle-current': {
              const result = await handleCurrentDialog(page, accept ?? true, promptText);
              return { handled: result !== null, result };
            }
            case 'stop':
              stopDialogHandler(page);
              return { stopped: true };
            case 'history':
              return { history: getDialogHistory(page) };
            case 'clear':
              clearDialogHistory(page);
              return { cleared: true };
            default:
              throw new Error(`Unknown dialog op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── iframe_context ────────────────────────────────────────────────────
    {
      name: 'iframe_context',
      description: 'List frames or switch into an iframe',
      schema: iframeSchema,
      handler: async (args, cfg) => {
        const { op, by, value } = args as {
          op: string;
          by?: 'name' | 'url' | 'index' | 'selector';
          value?: string | number;
        };
        return withSession(cfg, async (page) => {
          const { listFrames, switchToFrame } = await import('../../browser/iframeContext.js');

          switch (op) {
            case 'list': {
              const frames = listFrames(page);
              return { frames, totalFrames: frames.length };
            }
            case 'main': {
              const { getActiveFrame, activeFrameByPage } =
                await import('../../browser/iframeContext.js');
              const current = getActiveFrame(page);
              if (!current) {
                return { success: true, message: 'Already on main frame' };
              }
              activeFrameByPage.delete(page);
              return { success: true, message: 'Switched back to main frame' };
            }
            case 'switch': {
              if (!by || value === undefined) {
                throw new Error('by and value are required for iframe_context.switch');
              }
              // Guard: index requires number, name/url/selector require string
              if (by === 'index' && typeof value !== 'number') {
                throw new Error('value must be a number when by is "index"');
              }
              if (
                (by === 'name' || by === 'url' || by === 'selector') &&
                typeof value !== 'string'
              ) {
                throw new Error('value must be a string when by is "name", "url", or "selector"');
              }
              return switchToFrame(page, { by, value });
            }
            default:
              throw new Error(`Unknown iframe op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── scroll_to_load ────────────────────────────────────────────────────
    {
      name: 'scroll_to_load',
      description: 'Infinite scroll / lazy-load handler',
      schema: scrollToLoadSchema,
      handler: async (args, cfg) => {
        const { maxScrolls, scrollDelayMs, direction, scrollPixels, timeoutMs, scrollContainer } =
          args as {
            maxScrolls?: number;
            scrollDelayMs?: number;
            direction?: 'down' | 'up';
            scrollPixels?: number;
            timeoutMs?: number;
            scrollContainer?: string;
          };
        return withSession(cfg, async (page) => {
          const { scrollToLoad } = await import('../../browser/scrollToLoad.js');
          // exactOptionalPropertyTypes: filter out undefined values
          const scrollOpts: Record<string, unknown> = {};
          if (maxScrolls !== undefined) scrollOpts.maxScrolls = maxScrolls;
          if (scrollDelayMs !== undefined) scrollOpts.scrollDelayMs = scrollDelayMs;
          if (direction !== undefined) scrollOpts.direction = direction;
          if (scrollPixels !== undefined) scrollOpts.scrollPixels = scrollPixels;
          if (timeoutMs !== undefined) scrollOpts.timeoutMs = timeoutMs;
          if (scrollContainer !== undefined) scrollOpts.scrollContainer = scrollContainer;
          return scrollToLoad(page, scrollOpts);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── paginate ──────────────────────────────────────────────────────────
    {
      name: 'paginate',
      description: 'Auto-walk paginated content',
      schema: paginateSchema,
      handler: async (args, cfg) => {
        const { nextSelector, maxPages, waitBetweenMs, contentSelector, extractMode } = args as {
          nextSelector?: string;
          maxPages?: number;
          waitBetweenMs?: number;
          contentSelector?: string;
          extractMode?: 'full' | 'content-only';
        };
        return withSession(cfg, async (page) => {
          const { paginate } = await import('../../browser/paginate.js');
          const pagOpts: Record<string, unknown> = {};
          if (nextSelector !== undefined) pagOpts.nextSelector = nextSelector;
          if (maxPages !== undefined) pagOpts.maxPages = maxPages;
          if (waitBetweenMs !== undefined) pagOpts.waitBetweenMs = waitBetweenMs;
          if (contentSelector !== undefined) pagOpts.contentSelector = contentSelector;
          if (extractMode !== undefined) pagOpts.extractMode = extractMode;
          return paginate(page, pagOpts);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── download ──────────────────────────────────────────────────────────
    {
      name: 'download',
      description: 'Intercept file downloads and return content',
      schema: downloadSchema,
      handler: async (args, cfg) => {
        const { op, savePath, maxSize, trigger } = args as {
          op: string;
          savePath?: string;
          maxSize?: number;
          trigger?: { action: string; target?: string; url?: string };
        };
        return withSession(cfg, async (page) => {
          const { interceptDownload, startDownloadCollection } =
            await import('../../browser/download.js');

          switch (op) {
            case 'intercept': {
              if (!trigger) throw new Error('trigger is required for download.intercept');
              const dlCfg: Record<string, unknown> = {};
              if (savePath !== undefined) dlCfg.savePath = savePath;
              if (maxSize !== undefined) dlCfg.maxSize = maxSize;
              const result = await interceptDownload(
                page,
                async () => {
                  if (trigger.action === 'click' && trigger.target) {
                    await page.locator(trigger.target).click();
                  } else if (trigger.action === 'navigate' && trigger.url) {
                    assertSafeUrl(trigger.url);
                    await page.goto(trigger.url);
                  }
                },
                dlCfg,
              );
              return { downloaded: result !== null, result };
            }
            case 'start-collection': {
              // Start collecting downloads; return a handle
              const collector = startDownloadCollection(page, savePath, maxSize);
              // Store the collector reference for 'get-collected' to use
              downloadCollectors.set(page, collector);
              return { started: true, savePath };
            }
            case 'get-collected': {
              const collector = downloadCollectors.get(page);
              if (!collector) {
                return { downloads: [] };
              }
              const downloads = await collector.waitForDownloads();
              return { downloads };
            }
            default:
              throw new Error(`Unknown download op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── table_extract ─────────────────────────────────────────────────────
    {
      name: 'table_extract',
      description: 'Extract structured HTML tables',
      schema: tableExtractSchema,
      handler: async (args, cfg) => {
        const { selector, maxTables, includeCaptions, flattenSpans } = args as {
          selector?: string;
          maxTables?: number;
          includeCaptions?: boolean;
          flattenSpans?: boolean;
        };
        return withSession(cfg, async (page) => {
          const { extractTables } = await import('../../browser/tableExtract.js');
          const tblOpts: Record<string, unknown> = {};
          if (selector !== undefined) tblOpts.selector = selector;
          if (maxTables !== undefined) tblOpts.maxTables = maxTables;
          if (includeCaptions !== undefined) tblOpts.includeCaptions = includeCaptions;
          if (flattenSpans !== undefined) tblOpts.flattenSpans = flattenSpans;
          return extractTables(page, tblOpts);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── network_intercept ─────────────────────────────────────────────────
    {
      name: 'network_intercept',
      description:
        'Enhanced network interception: block resources, inject headers, modify responses',
      schema: networkInterceptSchema,
      handler: async (args, cfg) => {
        const {
          op,
          blockTypes,
          blockPatterns,
          allowPatterns,
          injectPatterns,
          injectHeaders: injectHeadersConfig,
          modifyPatterns,
          modifyStatus,
          modifyBody,
          modifyHeaders,
        } = args as {
          op: string;
          blockTypes?: (
            | 'image'
            | 'font'
            | 'stylesheet'
            | 'media'
            | 'script'
            | 'fetch'
            | 'websocket'
            | 'other'
          )[];
          blockPatterns?: string[];
          allowPatterns?: string[];
          injectPatterns?: string[];
          injectHeaders?: Record<string, string>;
          modifyPatterns?: string[];
          modifyStatus?: number;
          modifyBody?: string;
          modifyHeaders?: Record<string, string>;
        };
        return withSession(cfg, async (page) => {
          const {
            blockResources,
            injectHeaders: doInjectHeaders,
            modifyResponse,
            removeAllIntercepts,
            listIntercepts,
          } = await import('../../browser/networkInterceptEnhanced.js');

          switch (op) {
            case 'block': {
              const blockCfg: Record<string, unknown> = {};
              if (blockTypes !== undefined) blockCfg.blockTypes = blockTypes;
              if (blockPatterns !== undefined) blockCfg.blockPatterns = blockPatterns;
              if (allowPatterns !== undefined) blockCfg.allowPatterns = allowPatterns;
              return blockResources(page, blockCfg);
            }
            case 'inject': {
              if (!injectHeadersConfig)
                throw new Error('injectHeaders is required for network_intercept.inject');
              type InjCfg = Parameters<typeof doInjectHeaders>[1];
              const injCfg: InjCfg = {
                headers: injectHeadersConfig,
                ...(injectPatterns !== undefined ? { patterns: injectPatterns } : {}),
              };
              return doInjectHeaders(page, injCfg);
            }
            case 'modify': {
              if (!modifyPatterns || modifyPatterns.length === 0)
                throw new Error('modifyPatterns is required for network_intercept.modify');
              type ModCfg = Parameters<typeof modifyResponse>[1];
              const modCfg: ModCfg = {
                patterns: modifyPatterns,
                ...(modifyStatus !== undefined ? { status: modifyStatus } : {}),
                ...(modifyBody !== undefined ? { body: modifyBody } : {}),
                ...(modifyHeaders !== undefined ? { headers: modifyHeaders } : {}),
              };
              return modifyResponse(page, modCfg);
            }
            case 'unblock':
              return removeAllIntercepts(page);
            case 'list':
              return listIntercepts(page);
            default:
              throw new Error(`Unknown network_intercept op: ${op}`);
          }
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── resource_timing ───────────────────────────────────────────────────
    {
      name: 'resource_timing',
      description: 'Return Navigation Timing and Resource Timing API data',
      schema: resourceTimingSchema,
      handler: async (_args, cfg) => {
        return withSession(cfg, async (page) => {
          const { getResourceTiming } = await import('../../browser/resourceTiming.js');
          return getResourceTiming(page);
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── diff ──────────────────────────────────────────────────────────────
    {
      name: 'diff',
      description: 'Take a DOM snapshot, perform actions, return structural diff',
      schema: diffSchema,
      handler: async (args, cfg) => {
        const { actions, selector, maxChanges } = args as {
          actions: { action: string; target?: string; value?: string; time?: number }[];
          selector?: string;
          maxChanges?: number;
        };
        return withSession(cfg, async (page) => {
          const { diffAfterAction } = await import('../../browser/diffDom.js');
          const diffOpts: Record<string, unknown> = {};
          if (selector !== undefined) diffOpts.selector = selector;
          if (maxChanges !== undefined) diffOpts.maxChanges = maxChanges;
          return diffAfterAction(
            page,
            async () => {
              for (const step of actions) {
                switch (step.action) {
                  case 'click':
                    if (step.target) await page.locator(step.target).click();
                    break;
                  case 'type':
                    if (step.target != null && step.value != null)
                      await page.locator(step.target).fill(step.value);
                    break;
                  case 'select':
                    if (step.target && step.value)
                      await page.locator(step.target).selectOption(step.value);
                    break;
                  case 'wait':
                    await page.waitForTimeout((step.time ?? 1) * 1000);
                    break;
                  case 'navigate':
                    if (step.value) {
                      assertSafeUrl(step.value);
                      await page.goto(step.value, { waitUntil: 'domcontentloaded' });
                    }
                    break;
                  case 'scroll':
                    await page.mouse.wheel(0, parseInt(step.value ?? '300', 10));
                    break;
                  default:
                    break;
                }
              }
            },
            diffOpts,
          );
        });
      },
      configIssue: browserDisabledIssue,
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerBrowserTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, browserFamily, cfg);
}

/**
 * Action-level capability report for health checks.
 * Returns per-action availability with remediation hints.
 */
export function browserCapabilities(cfg: SearchConfig) {
  return browserFamily.actions.map((a) => ({
    name: `browser.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
