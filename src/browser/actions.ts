/**
 * CDP Browser — User Interaction Primitives
 *
 * High-level action functions operating on a Playwright Page.
 * Every function returns ActionResult (never throws).
 * Supports three targeting strategies: snapshot ref, CSS selector, and visible text.
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-deprecated */
import type { Page, Locator } from 'playwright-core';
import type { ActionResult, ActionTarget, SnapshotNode } from './types.js';
import { BrowserError } from './types.js';
import { findElementByRef, refToLocator } from './snapshot.js';

// ─────────────────────────────────────────────────────────────────────────────
// Target Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an ActionTarget to a Playwright Locator.
 *
 * Ref-based targeting requires a prior snapshot. When using 'ref' without
 * a snapshotRoot in the caller, this produces an actionable error message.
 */
function resolveTarget(page: Page, target: ActionTarget): Locator {
   switch (target.type) {
      case 'ref': {
         throw new BrowserError(
            'Ref-based targeting requires a prior snapshot. Use snapshot() first, then pass the ref.',
            'ACTION_FAILED',
         );
      }
      case 'selector':
         return page.locator(target.selector);
      case 'text':
         return page.getByText(target.text, { exact: false });
   }
}

/**
 * Resolve a snapshot ref to a Playwright Locator by walking the snapshot tree.
 * Requires a snapshot root obtained from a prior captureSnapshot() call.
 */
export function resolveRefTarget(page: Page, snapshotRoot: SnapshotNode, ref: string): Locator {
   const node = findElementByRef(snapshotRoot, ref);
   if (!node) {
      throw new BrowserError(`Element with ref="${ref}" not found in snapshot`, 'ACTION_FAILED');
   }
   return refToLocator(page, node);
}

// ─────────────────────────────────────────────────────────────────────────────
// User Actions
// ─────────────────────────────────────────────────────────────────────────────

/** Click an element. Supports double-click, right/middle button, and modifier keys. */
export async function click(
   page: Page,
   target: ActionTarget,
   options?: {
      button?: 'left' | 'right' | 'middle';
      doubleClick?: boolean;
      modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
      snapshotRoot?: SnapshotNode;
   },
): Promise<ActionResult> {
   try {
      const locator =
         options?.snapshotRoot && target.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, target.ref)
            : resolveTarget(page, target);
      if (options?.doubleClick) {
         await locator.dblclick({
            ...(options.button ? { button: options.button } : {}),
            ...(options.modifiers ? { modifiers: options.modifiers } : {}),
         });
      } else {
         const clickOpts: Parameters<typeof locator.click>[0] = {};
         if (options?.button) clickOpts.button = options.button;
         if (options?.modifiers) clickOpts.modifiers = options.modifiers;
         await locator.click(clickOpts);
      }
      return { success: true, message: 'Click succeeded' };
   } catch (err) {
      return { success: false, message: `Click failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Type text into an editable element. Supports fill (fast) or pressSequentially (triggers key handlers). */
export async function typeText(
   page: Page,
   target: ActionTarget,
   text: string,
   options?: {
      submit?: boolean;
      slowly?: boolean;
      snapshotRoot?: SnapshotNode;
   },
): Promise<ActionResult> {
   try {
      const locator =
         options?.snapshotRoot && target.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, target.ref)
            : resolveTarget(page, target);
      if (options?.slowly) {
         await locator.pressSequentially(text);
      } else {
         await locator.fill(text);
      }
      if (options?.submit) {
         await page.keyboard.press('Enter');
      }
      return { success: true, message: 'Type succeeded' };
   } catch (err) {
      return { success: false, message: `Type failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Select options in a <select> element by option values. */
export async function selectOption(
   page: Page,
   target: ActionTarget,
   values: string[],
   options?: { snapshotRoot?: SnapshotNode },
): Promise<ActionResult> {
   try {
      const locator =
         options?.snapshotRoot && target.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, target.ref)
            : resolveTarget(page, target);
      await locator.selectOption(values);
      return { success: true, message: 'Select succeeded' };
   } catch (err) {
      return { success: false, message: `Select failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Hover over an element. */
export async function hover(
   page: Page,
   target: ActionTarget,
   options?: { snapshotRoot?: SnapshotNode },
): Promise<ActionResult> {
   try {
      const locator =
         options?.snapshotRoot && target.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, target.ref)
            : resolveTarget(page, target);
      await locator.hover();
      return { success: true, message: 'Hover succeeded' };
   } catch (err) {
      return { success: false, message: `Hover failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Drag from one element to another. */
export async function dragDrop(
   page: Page,
   from: ActionTarget,
   to: ActionTarget,
   options?: { snapshotRoot?: SnapshotNode },
): Promise<ActionResult> {
   try {
      const fromLoc =
         options?.snapshotRoot && from.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, from.ref)
            : resolveTarget(page, from);
      const toLoc =
         options?.snapshotRoot && to.type === 'ref'
            ? resolveRefTarget(page, options.snapshotRoot, to.ref)
            : resolveTarget(page, to);
      await fromLoc.dragTo(toLoc);
      return { success: true, message: 'Drag succeeded' };
   } catch (err) {
      return { success: false, message: `Drag failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Press a keyboard key by name (e.g. 'Enter', 'Escape', 'Tab'). */
export async function pressKey(page: Page, key: string): Promise<ActionResult> {
   try {
      await page.keyboard.press(key);
      return { success: true, message: `Pressed key: ${key}` };
   } catch (err) {
      return { success: false, message: `Key press failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

/** Scroll the page by delta pixels using the mouse wheel. */
export async function scroll(page: Page, deltaX: number, deltaY: number): Promise<ActionResult> {
   try {
      await page.mouse.wheel(deltaX, deltaY);
      return { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
   } catch (err) {
      return { success: false, message: `Scroll failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/** Execute JavaScript in the page context and return the serialized result. */
export async function evaluateJs(
   page: Page,
   expression: string,
   timeout = 30000,
): Promise<ActionResult> {
   try {
      // Use a race with a timeout promise instead of mutating page state via setDefaultTimeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
         page.evaluate(expression),
         new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error('Evaluation timed out')); }, timeout);
         }),
      ]).finally(() => {
         if (timer !== undefined) clearTimeout(timer);
      });
      return { success: true, message: 'Evaluation succeeded', data: result };
   } catch (err) {
      return { success: false, message: `Evaluation failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot
// ─────────────────────────────────────────────────────────────────────────────

/** Take a screenshot of the page. Returns the image data as base64. */
export async function takeScreenshot(
   page: Page,
   options?: { fullPage?: boolean; type?: 'png' | 'jpeg'; quality?: number },
): Promise<ActionResult> {
   try {
      const screenshotOpts: Parameters<typeof page.screenshot>[0] = {
         fullPage: options?.fullPage ?? false,
         type: options?.type ?? 'png',
      };
      if (options?.type === 'jpeg' && options?.quality !== undefined) {
         screenshotOpts.quality = options.quality;
      }
      const buffer = await page.screenshot(screenshotOpts);
      const base64 = buffer.toString('base64');
      return { success: true, message: 'Screenshot captured', data: base64 };
   } catch (err) {
      return { success: false, message: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wait Strategies
// ─────────────────────────────────────────────────────────────────────────────

/** Wait for a condition: time, text to appear/disappear, selector, navigation, or load state. */
export async function waitFor(
   page: Page,
   options: {
      time?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      navigation?: boolean;
      loadState?: 'load' | 'domcontentloaded' | 'networkidle';
   },
): Promise<ActionResult> {
   try {
      if (options.time !== undefined) {
         await page.waitForTimeout(options.time * 1000);
      }
      if (options.text) {
         await page.getByText(options.text).waitFor({ state: 'visible' });
      }
      if (options.textGone) {
         await page.getByText(options.textGone).waitFor({ state: 'hidden' });
      }
      if (options.selector) {
         await page.locator(options.selector).waitFor({ state: 'visible' });
      }
      if (options.navigation) {
         await page.waitForNavigation();
      }
      if (options.loadState) {
         await page.waitForLoadState(options.loadState);
      }
      return { success: true, message: 'Wait completed' };
   } catch (err) {
      return { success: false, message: `Wait failed: ${err instanceof Error ? err.message : String(err)}` };
   }
}
