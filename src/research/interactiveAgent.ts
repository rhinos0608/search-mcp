/**
 * InteractiveBrowserAgent — gives the deep research orchestrator browser control
 * for navigating login walls, bot-protected content, and JavaScript-heavy pages.
 *
 * V6.0.0 — Phase 4 (Deep Research Integration) of the CDP Browser Control feature.
 */

import type { Page } from 'playwright-core';
import type { BrowserSession, BrowserSessionConfig, InteractiveResult, BlockerHandlingResult, ActionTarget } from '../browser/types.js';
import type { InteractiveExtractionPlan } from './types.js';
import { browserManager } from '../browser/browserManager.js';
import { click, typeText, waitFor, evaluateJs, takeScreenshot, scroll } from '../browser/actions.js';
import { extractByInstruction } from '../browser/extraction.js';
import { resolveCredentials, performLogin } from '../browser/credentials.js';
import { isBotChallenge, isLoginWall } from './contentQuality.js';
import { logger } from '../logger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface InteractiveAgentConfig {
   /** Browser session config. */
   browser: BrowserSessionConfig;
   /** Optional LLM config for NL extraction. */
   llmConfig?: { provider: string; apiToken: string; baseUrl?: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Guess whether `target` is a CSS selector or visible text.
 * Selectors: starts with `#`, `.`, `[`, `:`, or looks like an HTML tag name
 * followed by a combinator/attribute.
 */
function isCssSelector(target: string): boolean {
   return (
      target.startsWith('#') ||
      target.startsWith('.') ||
      target.startsWith('[') ||
      target.startsWith(':') ||
      /^[a-zA-Z][\w-]*(?:[.#\s[>:])/.test(target)
   );
}

/** Build an ActionTarget from a string (either selector or text match). */
function toActionTarget(target: string): ActionTarget {
   return isCssSelector(target)
      ? { type: 'selector', selector: target }
      : { type: 'text', text: target };
}

// ── Agent class ───────────────────────────────────────────────────────────────

/**
 * Interactive browser agent for deep research.
 * Handles login walls, bot challenges, and JavaScript-heavy content.
 */
export class InteractiveBrowserAgent {
   private session: BrowserSession | null = null;

   constructor(private readonly config: InteractiveAgentConfig) { }

   /**
    * Execute an interactive extraction plan against a URL.
    * Opens browser, executes actions, extracts content.
    *
    * If `session` is provided, uses it directly (caller manages lifecycle).
    * Otherwise launches a new session and closes it in `finally`.
    */
   async executePlan(
      url: string,
      plan: InteractiveExtractionPlan,
      session?: BrowserSession,
   ): Promise<InteractiveResult> {
      const warnings: string[] = [];
      const screenshots: string[] = [];
      const findings: { text: string; confidence: number }[] = [];

      let ownSession = false;

      try {
         // 1. Open browser session (use existing if provided)
         if (session) {
            this.session = session;
         } else {
            this.session = await browserManager.launch(this.config.browser);
            ownSession = true;
         }
         const { page } = this.session;

         // 2. Navigate to URL
         await page.goto(url, { waitUntil: 'domcontentloaded', timeout: plan.maxTimeMs ?? 30_000 });

         // 3. Check for blockers
         const pageContent = await page.evaluate(() => document.body.innerText).catch(() => '');
         const blocker = await this.detectAndHandleBlockers(page);
         if (!blocker.handled && isBotChallenge(pageContent)) {
            warnings.push('Bot challenge detected and could not be bypassed');
         }

         // 4. Execute action sequence
         for (const action of plan.actions) {
            try {
               switch (action.type) {
                  case 'navigate': {
                     if (action.target) {
                        await page.goto(action.target, {
                           waitUntil: 'domcontentloaded',
                           timeout: action.timeout ?? 30_000,
                        });
                     }
                     break;
                  }

                  case 'click': {
                     if (action.target) {
                        await click(page, toActionTarget(action.target));
                     }
                     break;
                  }

                  case 'type': {
                     if (action.target && action.value !== undefined) {
                        await typeText(page, toActionTarget(action.target), action.value, {
                           submit: true,
                        });
                     }
                     break;
                  }

                  case 'wait': {
                     if (action.value !== undefined) {
                        const ms = parseInt(action.value, 10);
                        if (Number.isFinite(ms) && ms >= 0) {
                           await waitFor(page, { time: ms / 1000 });
                        } else {
                           logger.warn({ value: action.value }, 'InteractiveAgent: invalid wait value, skipping');
                        }
                     } else if (action.target) {
                        await waitFor(page, { text: action.target });
                     }
                     break;
                  }

                  case 'scroll': {
                     if (action.value !== undefined) {
                        const pixels = parseInt(action.value, 10);
                        if (Number.isFinite(pixels)) {
                           await scroll(page, 0, pixels);
                        } else {
                           logger.warn({ value: action.value }, 'InteractiveAgent: invalid scroll value, skipping');
                        }
                     }
                     break;
                  }

                  case 'evaluate': {
                     if (action.value) {
                        await evaluateJs(page, action.value, action.timeout);
                     }
                     break;
                  }

                  case 'screenshot': {
                     const result = await takeScreenshot(page, { fullPage: true });
                     if (result.success && typeof result.data === 'string') {
                        screenshots.push(result.data);
                     }
                     break;
                  }

                  case 'select': {
                     if (action.target && action.value !== undefined) {
                        // Select option(s) — value is comma-separated option values
                        const values = action.value.split(',').map((v) => v.trim()).filter(Boolean);
                        if (values.length > 0) {
                           // Use playwright directly for select
                           await page.locator(action.target).selectOption(values);
                        }
                     }
                     break;
                  }
               }
            } catch (actionErr) {
               warnings.push(
                  `Action "${action.type}" failed: ${actionErr instanceof Error ? actionErr.message : String(actionErr)}`,
               );
            }
         }

         // 5. Wait for content to settle
         try {
            await page.waitForLoadState('networkidle', { timeout: 10_000 });
         } catch {
            // Timeout is acceptable — page may still have loaded
         }

         // 6. Extract content
         const title = await page.title();
         const currentUrl = page.url();
         let content: string;

         if (plan.extraction.selector) {
            const el = page.locator(plan.extraction.selector);
            content = (await el.textContent()) ?? '';
         } else if (plan.extraction.instruction && this.config.llmConfig) {
            const result = await extractByInstruction(
               page,
               plan.extraction.instruction,
               this.config.llmConfig,
            );
            content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
            if (!result.success && result.warnings) {
               warnings.push(...result.warnings);
            }
         } else {
            content = await page.evaluate(() => document.body.innerText);
         }

         // 7. Collect findings
         if (content) {
            findings.push({ text: content.slice(0, 5_000), confidence: 0.7 });
         }

         return { content, title, url: currentUrl, screenshots, findings, warnings };
      } catch (err) {
         warnings.push(`Interactive extraction failed: ${err instanceof Error ? err.message : String(err)}`);
         return {
            content: '',
            title: '',
            url,
            screenshots,
            findings,
            warnings,
         };
      } finally {
         // Only close sessions we launched ourselves
         if (ownSession && this.session) {
            await browserManager.close(this.session).catch(() => { /* ignore close errors */ });
            this.session = null;
         }
      }
   }

   /**
    * Detect and attempt to handle blockers (bot challenges, login walls).
    *
    * Returns `{ handled: true }` when no blocker was detected or the blocker
    * was successfully bypassed.
    */
   async detectAndHandleBlockers(page: BrowserSession['page']): Promise<BlockerHandlingResult> {
      const content = await page.evaluate(() => document.body.innerText).catch(() => '');

      // Check for login wall first
      if (isLoginWall(content)) {
         const credentials = resolveCredentials(page.url(), this.config.browser.credentials);
         if (credentials) {
            try {
               const hostname = new URL(page.url()).hostname;
               const loggedIn = await performLogin(page, credentials, hostname);
               if (loggedIn) {
                  logger.info({ hostname }, 'InteractiveAgent: login performed successfully');
                  return { handled: true, loginPerformed: true };
               }
            } catch (loginErr) {
               logger.warn({ err: loginErr }, 'InteractiveAgent: login attempt failed');
            }
         }
         return {
            handled: false,
            reason: 'Login wall detected but no matching credentials configured or login failed',
            loginPerformed: false,
         };
      }

      // Check for bot challenge — try common dismiss patterns
      if (isBotChallenge(content)) {
         const dismissed = await this.tryDismissBotChallenge(page);
         if (dismissed) {
            return { handled: true, loginPerformed: false };
         }
         return {
            handled: false,
            reason: 'Bot challenge detected — requires manual intervention or advanced stealth',
            loginPerformed: false,
         };
      }

      // No blocker detected
      return { handled: true, loginPerformed: false };
   }

   /**
    * Attempt to dismiss a bot challenge page.
    * Tries common "I am human" / "Verify" buttons and challenge iframes.
    */
   private async tryDismissBotChallenge(page: Page): Promise<boolean> {
      const selectors = [
         // Common verify/continue buttons
         'text=I am human',
         'text=Verify',
         'text=Continue',
         'text=I am not a robot',
         'text=Verify you are human',
         // Cloudflare Turnstile
         'iframe[src*="challenges"]',
         'iframe[src*="turnstile"]',
         // Generic challenge frames
         '[aria-label*="challenge"]',
         '[aria-label*="verify"]',
      ];

      for (const selector of selectors) {
         try {
            const locator = page.locator(selector);
            if ((await locator.count()) > 0) {
               await locator.first().click({ timeout: 3_000 });
               await page.waitForTimeout(2_000);
               // Check if challenge was bypassed by re-reading content
               const newContent = await page.evaluate(() => document.body.innerText).catch(() => '');
               if (!isBotChallenge(newContent)) {
                  return true;
               }
            }
         } catch {
            continue;
         }
      }

      return false;
   }

   /** Close the session if still open. */
   async close(): Promise<void> {
      if (this.session) {
         await browserManager.close(this.session).catch(() => { /* ignore close errors */ });
         this.session = null;
      }
   }
}
