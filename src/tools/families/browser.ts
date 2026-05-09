/**
 * Consolidated Browser tool family.
 *
 * Exposes interactive browser control via Playwright + CDP as a single MCP tool
 * with a discriminated-union `action` field.
 *
 * Actions:
 *   navigate   — Navigate to a URL
 *   snapshot   — Capture accessibility tree snapshot
 *   click      — Click an element
 *   type       — Type text into a field
 *   evaluate   — Execute JavaScript in page context
 *   screenshot — Take a screenshot
 *   extract    — Extract structured data
 *   act        — Natural language instruction (requires LLM)
 *   wait       — Wait for a condition
 *   pdf        — Save page as PDF (requires headless)
 *   storage    — Manage browser storage state
 *   network    — Network interception
 *   tabs       — Tab management
 *   session    — Browser session lifecycle
 */

import { z } from 'zod/v4';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { assertSafeUrl } from '../../httpGuards.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { logger } from '../../logger.js';

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

const clickSchema = z.object({
  action: z.literal('click').describe('Click an element'),
  target: z.string().describe('Element ref (from snapshot), CSS selector, or visible text'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  doubleClick: z.boolean().optional().default(false),
});

const typeSchema = z.object({
  action: z.literal('type').describe('Type text into an editable element'),
  target: z.string().describe('Element ref (from snapshot) or CSS selector'),
  text: z.string().describe('Text to type'),
  submit: z.boolean().optional().default(false).describe('Press Enter after typing'),
  slowly: z.boolean().optional().default(false).describe('Type character-by-character'),
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
});

// ── Config gates ─────────────────────────────────────────────────────────────

function browserDisabledIssue(cfg: SearchConfig): string | null {
  if (!cfg.browser.enabled) {
    return 'Set BROWSER_ENABLED=true to enable interactive browser control via Playwright + CDP.';
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

async function getOrCreateSession(
  cfg: SearchConfig,
  opts?: {
    headless?: boolean;
    profile?: string;
    cdpEndpoint?: string;
    mode?: string;
    browserPort?: number;
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
    'Interactive browser control via Playwright + CDP. Use the `action` field to choose: ' +
    '"navigate" to go to a URL, "snapshot" to capture the page structure as accessible elements, ' +
    '"click"/"type" to interact, "evaluate" to run JavaScript, "screenshot" to capture images, ' +
    '"extract" to pull structured data, "wait" for conditions, and "session" to manage the browser lifecycle.',
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
          return captureSnapshot(page, opts);
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
        const { target, button, doubleClick } = args as {
          target: string;
          button: 'left' | 'right' | 'middle';
          doubleClick: boolean;
        };
        return withSession(cfg, async (page) => {
          const { click } = await import('../../browser/actions.js');
          const targetObj =
            target.startsWith('#') || target.startsWith('.') || target.startsWith('[')
              ? { type: 'selector' as const, selector: target }
              : { type: 'text' as const, text: target };
          return click(page, targetObj, { button, doubleClick });
        });
      },
      configIssue: browserDisabledIssue,
    },
    // ── type ───────────────────────────────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into an editable element',
      schema: typeSchema,
      handler: async (args, cfg) => {
        const { target, text, submit, slowly } = args as {
          target: string;
          text: string;
          submit: boolean;
          slowly: boolean;
        };
        return withSession(cfg, async (page) => {
          const { typeText } = await import('../../browser/actions.js');
          const targetObj = { type: 'selector' as const, selector: target };
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
          return takeScreenshot(page, opts);
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
            const endpoint = `${(cfg.llm.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`;
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (cfg.llm.apiToken) {
              headers.Authorization = `Bearer ${cfg.llm.apiToken}`;
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
              controller.abort();
            }, 30_000);
            try {
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

              const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
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
                  temperature: 0.3,
                  max_tokens: 2048,
                }),
              });
              if (!response.ok) {
                throw new Error(`LLM API error: ${String(response.status)} ${response.statusText}`);
              }
              const json = (await response.json()) as {
                choices: { message: { content: string } }[];
              };
              const content = json.choices[0]?.message.content ?? '';
              try {
                return JSON.parse(content) as unknown[];
              } catch (parseErr) {
                logger.error(
                  { err: String(parseErr), content: content.slice(0, 200) },
                  'LLM act response is not valid JSON',
                );
                return [];
              }
            } finally {
              clearTimeout(timeoutId);
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
                  const seconds = parseFloat(value || '1');
                  await page.waitForTimeout(Math.min(seconds, 30) * 1000);
                  results.push({
                    action: 'wait',
                    success: true,
                    message: `Waited ${String(seconds)}s`,
                  });
                  break;
                }
                case 'scroll': {
                  const pixels = parseInt(value || '300', 10);
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
                  if (values.length > 0) {
                    await page.locator(target).selectOption(values);
                  }
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
                await page
                  .context()
                  .addCookies((state as { cookies: Record<string, unknown>[] }).cookies as never[]);
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
              const filter = pattern ? new RegExp(pattern) : undefined;
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
        switch (op) {
          case 'list': {
            const tabs = session.pages.map((p, i) => ({ index: i, url: p.url(), title: '' }));
            return { tabs };
          }
          case 'new': {
            const newPage = await session.context.newPage();
            session.pages.push(newPage);
            if (url) await newPage.goto(url);
            return { index: session.pages.length - 1, url: newPage.url() };
          }
          case 'close': {
            if (index === undefined) throw new Error('index is required for tabs.close');
            const page = session.pages[index];
            if (!page) throw new Error(`No tab at index ${String(index)}`);
            await page.close();
            session.pages.splice(index, 1);
            return { closed: true };
          }
          case 'select': {
            if (index === undefined) throw new Error('index is required for tabs.select');
            const page = session.pages[index];
            if (!page) throw new Error(`No tab at index ${String(index)}`);
            await page.bringToFront();
            session.page = page;
            return { selected: index, url: page.url() };
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
        const { op, headless, profile, cdpEndpoint, mode, browserPort } = args as {
          op: string;
          headless?: boolean;
          profile?: string;
          cdpEndpoint?: string;
          mode?: string;
          browserPort?: number;
        };
        const { browserManager } = await import('../../browser/browserManager.js');
        switch (op) {
          case 'start': {
            const sessionOpts: Record<string, unknown> = {};
            if (headless !== undefined) sessionOpts.headless = headless;
            if (profile !== undefined) sessionOpts.profile = profile;
            if (cdpEndpoint !== undefined) sessionOpts.cdpEndpoint = cdpEndpoint;
            if (mode !== undefined) sessionOpts.mode = mode;
            if (browserPort !== undefined) sessionOpts.browserPort = browserPort;
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
