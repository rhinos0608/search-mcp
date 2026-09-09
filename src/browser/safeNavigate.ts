/**
 * Session-level SSRF guard for browser navigation.
 *
 * Playwright follows redirects and frame navigations without re-running any
 * per-call URL check, so a `goto`-time `assertSafeUrl` does not protect
 * redirect hops. This module installs a BrowserContext-level route handler
 * that re-validates every navigation request (top-level, page, and iframe)
 * before the network stack touches it, and wraps shared `route.continue()`
 * call sites (`network.ts`, `networkInterceptEnhanced.ts`) so later-registered
 * page-level intercepts do not shadow the guard.
 *
 * Scope note: the guard checks the URL and the DNS answers it resolves to at
 * navigation time. Chromium performs its own connection-time resolution, so
 * this control does NOT pin DNS and must not be described as preventing DNS
 * rebinding — only that resolved answers were public at check time.
 * Non-navigation subresource requests (images, fetch/XHR from page JS) are
 * outside this control.
 */

import type { BrowserContext, Page, Request, Route } from 'playwright-core';
import { assertSafeUrl, assertSafeResolvedHost } from '../httpGuards.js';

type DnsResolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export interface NavigationGuardOptions {
  /** Injectable DNS resolver for deterministic tests; defaults to node:dns lookup-all. */
  resolver?: DnsResolver;
}

/**
 * Validate a navigation target as a public http(s) URL.
 * Throws with a sanitized message when blocked. Used for initial `goto`
 * targets; redirect hops go through {@link continueIfNavigationSafe}.
 */
export function assertPublicNavigationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid navigation URL: cannot parse "${url}"`);
  }

  if (parsed.protocol === 'about:') {
    // Playwright starts pages on about:blank; about:srcdoc appears for
    // sandboxed frames. Other about: pages are browser-internal.
    if (parsed.pathname === 'blank' || parsed.pathname === 'srcdoc') return;
    throw new Error('Blocked navigation to non-public URL');
  }
  // data:/blob: are not SSRF vectors (no network host). This is not an XSS control.
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return;

  // assertSafeUrl enforces http/https and blocks loopback/private/metadata
  // raw-IP targets, throwing "Blocked URL scheme" for file:/javascript:/etc.
  assertSafeUrl(url);
}

/**
 * Route decision for a (possibly navigation) request.
 *
 * - Non-navigation requests pass through with overrides intact.
 * - Navigation requests must be public at URL and DNS level, else they are
 *   aborted with `blockedbyclient` before any network access.
 * - Header overrides are forwarded so intercept features keep working.
 */
export async function continueIfNavigationSafe(
  route: Route,
  request: Request,
  overrides?: Parameters<Route['continue']>[0],
  opts: NavigationGuardOptions = {},
): Promise<void> {
  if (!request.isNavigationRequest()) {
    await route.continue(overrides);
    return;
  }

  const url = request.url();
  if (
    url === 'about:blank' ||
    url === 'about:srcdoc' ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    await route.continue(overrides);
    return;
  }

  try {
    assertPublicNavigationUrl(url);
    if (url.startsWith('http:') || url.startsWith('https:')) {
      const { hostname } = new URL(url);
      await assertSafeResolvedHost(hostname, opts.resolver);
    } else {
      // Any other scheme reaching here is not an approved navigation target.
      throw new Error('Blocked navigation to non-public URL');
    }
  } catch {
    // Sanitized on purpose: never echo cookies, headers, or resolved internals.
    await route.abort('blockedbyclient').catch(() => {
      /* route already settled — nothing to clean up */
    });
    return;
  }

  await route.continue(overrides);
}

/**
 * Install the SSRF navigation guard on a browser context.
 *
 * Covers:
 * - context-level wildcard route (default interception for all pages/frames),
 * - every existing page, and pages opened later via the `page` event,
 *   each with a page-level wildcard route.
 *
 * Page-level intercepts registered AFTER this call win the route race in
 * Playwright; those call sites must go through {@link continueIfNavigationSafe}.
 * Returns an async disposer that removes only this guard's handlers
 * (per-handler unroute — never `unrouteAll`, which would wipe feature routes).
 */
export async function installNavigationSsrfGuard(
  context: BrowserContext,
  opts: NavigationGuardOptions = {},
): Promise<() => Promise<void>> {
  const handler = (route: Route, request: Request): Promise<void> =>
    continueIfNavigationSafe(route, request, undefined, opts);

  const routedPages = new Set<Page>();
  const onPage = (page: Page): void => {
    routedPages.add(page);
    void page.route('**/*', handler).catch(() => {
      /* page may be closing; context-level guard still applies */
    });
  };

  await context.route('**/*', handler);
  for (const page of context.pages()) {
    routedPages.add(page);
    await page.route('**/*', handler);
  }
  context.on('page', onPage);

  return async () => {
    context.off('page', onPage);
    try {
      await context.unroute('**/*', handler);
    } catch {
      /* context may already be closed */
    }
    for (const page of routedPages) {
      try {
        await page.unroute('**/*', handler);
      } catch {
        /* page may already be closed */
      }
    }
    routedPages.clear();
  };
}

export interface SafeGotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

/**
 * Navigate after validating the target URL. Chromium may still abort the
 * navigation itself (e.g. a redirect to a private host intercepted at the
 * network layer) — map Chromium's `ERR_BLOCKED_BY_CLIENT` to a sanitized
 * message so no private target URL or internal detail reaches callers.
 */
export async function safeGoto(
  page: Page,
  url: string,
  opts: SafeGotoOptions = {},
): Promise<import('playwright-core').Response | null> {
  assertPublicNavigationUrl(url);
  const gotoOptions: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number } = {
    waitUntil: opts.waitUntil ?? 'domcontentloaded',
    timeout: opts.timeout ?? 30_000,
  };
  try {
    return await page.goto(url, gotoOptions);
  } catch (err) {
    if (err instanceof Error && err.message.includes('ERR_BLOCKED_BY_CLIENT')) {
      throw new Error('Blocked navigation to non-public URL');
    }
    throw err;
  }
}
