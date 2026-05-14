import type { Page } from 'playwright-core';
import type { PaginateConfig, PaginateResult, PaginatePageContent } from './types.js';

/**
 * Auto-walk paginated content by detecting "next" links/buttons
 * and collecting content from each page up to a limit.
 */
export async function paginate(
  page: Page,
  config: PaginateConfig = {},
): Promise<PaginateResult> {
  const maxPages = config.maxPages ?? 10;
  const waitBetweenMs = config.waitBetweenMs ?? 2000;
  const contentSelector = config.contentSelector ?? null;
  const extractMode = config.extractMode ?? 'content-only';
  const nextSelector = config.nextSelector ?? null;

  const urls: string[] = [];
  const content: PaginatePageContent[] = [];
  let exhausted = false;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const currentUrl = page.url();
    urls.push(currentUrl);

    // Extract content from current page
    const pageContent = await extractPageContent(page, pageNum, contentSelector, extractMode);
    content.push(pageContent);

    // Try to find and click the next link/button
    const nextLocator = await findNextLink(page, nextSelector);
    if (!nextLocator) {
      exhausted = true;
      break;
    }

    try {
      // Click the next link and wait for navigation or content change
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { /* intentionally empty */ }),
        nextLocator.click({ timeout: 5000 }),
      ]);
      await page.waitForTimeout(waitBetweenMs);
    } catch {
      exhausted = true;
      break;
    }
  }

  return { pages: content.length, urls, content, exhausted };
}

/** Extract page content. */
async function extractPageContent(
  page: Page,
  pageNum: number,
  contentSelector: string | null,
  mode: 'full' | 'content-only',
): Promise<PaginatePageContent> {
  let text: string;
  if (contentSelector) {
    text = await page.locator(contentSelector).first().textContent() ?? '';
  } else if (mode === 'full') {
    text = await page.evaluate(() => document.body.innerText);
  } else {
    // content-only: try common content containers first
    text = await page.evaluate(() => {
      const contentSelectors = [
        'main', 'article', '.content', '#content',
        '.post-content', '.article-content', '[role="main"]',
      ];
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && (el as HTMLElement).innerText.trim().length > 50) {
          return (el as HTMLElement).innerText;
        }
      }
      return document.body.innerText;
    });
  }

  return {
    url: page.url(),
    title: await page.title(),
    text: text.slice(0, 50000),
    pageNumber: pageNum,
  };
}

/** Find and return the next page link locator. */
async function findNextLink(
  page: Page,
  customSelector: string | null,
): Promise<ReturnType<Page['locator']> | null> {
  if (customSelector) {
    const loc = page.locator(customSelector).first();
    if (await loc.count() > 0) return loc;
    return null;
  }

  // Auto-detect common "next" patterns
  const patterns = [
    'a[rel="next"]',
    'a:has-text("Next")',
    'button:has-text("Next")',
    'a:has-text("»")',
    'a:has-text(">")',
    '.pagination .next a',
    '.pagination a:last-child',
    '[aria-label="Next page"]',
    '[aria-label="next page"]',
    'a[aria-label*="Next"]',
    'nav[aria-label="Pagination"] a:has-text("Next")',
  ];

  for (const pattern of patterns) {
    try {
      const loc = page.locator(pattern).first();
      if ((await loc.count()) > 0) {
        return loc;
      }
    } catch {
      // Invalid selector, try next pattern
    }
  }

  return null;
}
