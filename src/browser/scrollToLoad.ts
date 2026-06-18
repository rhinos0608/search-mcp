import type { Page } from 'playwright-core';
import type { ScrollToLoadResult } from './types.js';

/**
 * Scroll until no new content appears (infinite scroll / lazy-load handler).
 * Keeps scrolling and checking for new content until one of these conditions is met:
 * - No new content for consecutive scrolls (noChangeThreshold)
 * - Max scrolls reached
 * - Timeout exceeded
 */
export async function scrollToLoad(
  page: Page,
  options?: {
    /** Maximum scroll operations (default 50). */
    maxScrolls?: number;
    /** Milliseconds between scrolls (default 1000). */
    scrollDelayMs?: number;
    /** Scroll direction: 'down' (default) or 'up'. */
    direction?: 'down' | 'up';
    /** Pixels per scroll (default 500). */
    scrollPixels?: number;
    /** Max total time in ms (default 60000). */
    timeoutMs?: number;
    /** Number of consecutive no-change scrolls before stopping (default 3). */
    noChangeThreshold?: number;
    /** CSS selector to scroll within (omit for window scrolling). */
    scrollContainer?: string;
  },
): Promise<ScrollToLoadResult> {
  const maxScrolls = options?.maxScrolls ?? 50;
  const scrollDelayMs = options?.scrollDelayMs ?? 1000;
  const direction = options?.direction ?? 'down';
  const timeoutMs = options?.timeoutMs ?? 60000;
  const noChangeThreshold = options?.noChangeThreshold ?? 3;
  const scrollContainer = options?.scrollContainer ?? null;
  const startTime = Date.now();

  let initialHeight: number;
  let scrolls = 0;
  let noChangeCount = 0;
  let lastHeight = 0;
  let newContentFound = false;

  // Get initial height
  if (scrollContainer) {
    initialHeight = await page
      .locator(scrollContainer)
      .evaluate((el) => (el as HTMLElement).scrollHeight);
  } else {
    initialHeight = await page.evaluate(() => document.body.scrollHeight);
  }
  lastHeight = initialHeight;

  const scrollPixels = options?.scrollPixels ?? 500;
  const scrollDelta = direction === 'down' ? scrollPixels : -scrollPixels;

  while (scrolls < maxScrolls) {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      return {
        scrolls,
        newContentFound,
        finalHeight: lastHeight,
        initialHeight,
        stoppedReason: 'timeout',
        elapsedMs: Date.now() - startTime,
      };
    }

    // Scroll
    if (scrollContainer) {
      await page.locator(scrollContainer).evaluate((el, delta) => {
        (el as HTMLElement).scrollBy(0, delta);
      }, scrollDelta);
    } else {
      await page.mouse.wheel(0, scrollDelta);
    }

    scrolls++;

    // Wait for content to load
    await page.waitForTimeout(scrollDelayMs);

    // Check if height changed
    let currentHeight: number;
    if (scrollContainer) {
      currentHeight = await page
        .locator(scrollContainer)
        .evaluate((el) => (el as HTMLElement).scrollHeight);
    } else {
      currentHeight = await page.evaluate(() => document.body.scrollHeight);
    }

    if (currentHeight > lastHeight) {
      newContentFound = true;
      noChangeCount = 0;
      lastHeight = currentHeight;
    } else {
      noChangeCount++;
    }

    if (noChangeCount >= noChangeThreshold) {
      return {
        scrolls,
        newContentFound,
        finalHeight: currentHeight,
        initialHeight,
        stoppedReason: 'no-new-content',
        elapsedMs: Date.now() - startTime,
      };
    }

    // Check if at the very bottom
    if (scrollContainer) {
      const atBottom = await page.locator(scrollContainer).evaluate((el) => {
        const elem = el as HTMLElement;
        return elem.scrollTop + elem.clientHeight >= elem.scrollHeight - 2;
      });
      if (atBottom && noChangeCount > 0) {
        return {
          scrolls,
          newContentFound,
          finalHeight: currentHeight,
          initialHeight,
          stoppedReason: 'bottom-reached',
          elapsedMs: Date.now() - startTime,
        };
      }
    }
  }

  return {
    scrolls,
    newContentFound,
    finalHeight: lastHeight,
    initialHeight,
    stoppedReason: 'max-scrolls',
    elapsedMs: Date.now() - startTime,
  };
}
