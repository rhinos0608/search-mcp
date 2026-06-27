import type { Page } from 'playwright-core';
import type { NetworkRequest, NetworkRequestDetail, RouteHandlerAction } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// § Types
// ─────────────────────────────────────────────────────────────────────────────

/** Internal per-request tracking entry. */
interface TrackedRequest {
  index: number;
  method: string;
  url: string;
  status: number;
  timing: number;
  requestHeaders: Record<string, string>;
  requestBody: string | undefined;
  responseHeaders: Record<string, string>;
  responseBody: string | undefined;
}

/** Map of Page → tracked requests (GC-friendly). */
const trackedPages = new WeakMap<Page, TrackedRequest[]>();

// ─────────────────────────────────────────────────────────────────────────────
// § Request tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start tracking network requests on a page.
 * Must be called before navigation.
 */
export function startRequestTracking(page: Page): void {
  const requests: TrackedRequest[] = [];
  trackedPages.set(page, requests);

  page.on('request', (request) => {
    const startTime = Date.now();

    request
      .response()
      .then(async (response) => {
        if (!response) return;

        const entry: TrackedRequest = {
          index: requests.length + 1,
          method: request.method(),
          url: request.url(),
          status: response.status(),
          timing: Date.now() - startTime,
          requestHeaders: request.headers(),
          requestBody: request.postData() ?? undefined,
          responseHeaders: response.headers(),
          responseBody: undefined,
        };

        // Await body before pushing so getRequestDetails sees complete data
        try {
          const body = await response.body();
          entry.responseBody = body.toString('utf8').slice(0, 10000);
        } catch {
          // Response body may not be available (redirects, errors)
        }

        requests.push(entry);
      })
      .catch(() => {
        // Request may never get a response (aborted, failed)
      });
  });
}

/**
 * Stop tracking network requests on a page.
 * Clears all tracked request data.
 */
export function stopRequestTracking(page: Page): void {
  trackedPages.delete(page);
}

/**
 * List tracked requests, optionally filtered by URL regex.
 */
export function listRequests(page: Page, filter?: RegExp): NetworkRequest[] {
  const requests = trackedPages.get(page) ?? [];
  const filtered = filter ? requests.filter((r) => filter.test(r.url)) : requests;
  return filtered.map((r) => ({
    index: r.index,
    method: r.method,
    url: r.url,
    status: r.status,
    timing: r.timing,
  }));
}

/**
 * Get full details for a tracked request by 1-based index.
 */
export function getRequestDetails(page: Page, index: number): NetworkRequestDetail | null {
  const requests = trackedPages.get(page) ?? [];
  const req = requests.find((r) => r.index === index);
  if (!req) return null;

  // Build result with exactOptionalPropertyTypes compatibility
  const detail: NetworkRequestDetail = {
    requestHeaders: req.requestHeaders,
    responseHeaders: req.responseHeaders,
  };
  if (req.requestBody !== undefined) detail.requestBody = req.requestBody;
  if (req.responseBody !== undefined) detail.responseBody = req.responseBody;
  return detail;
}

// ─────────────────────────────────────────────────────────────────────────────
// § Route interception
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a route handler for URLs matching a glob pattern.
 * Supports abort, fulfill, continue, and headers-only mods.
 */
export async function addRoute(
  page: Page,
  pattern: string,
  handler: RouteHandlerAction,
): Promise<void> {
  await page.route(pattern, async (route) => {
    switch (handler.type) {
      case 'abort':
        await route.abort();
        break;
      case 'fulfill': {
        // Conditional spread avoids undefined values with exactOptionalPropertyTypes
        const fulfillOpts: Parameters<typeof route.fulfill>[0] = {
          status: handler.status,
        };
        if (handler.body !== undefined) fulfillOpts.body = handler.body;
        if (handler.headers !== undefined) fulfillOpts.headers = handler.headers;
        await route.fulfill(fulfillOpts);
        break;
      }
      case 'continue':
        await route.continue();
        break;
      case 'headers':
        await route.continue({ headers: handler.headers });
        break;
    }
  });
}

/**
 * Remove a route handler for the given pattern.
 * If pattern is omitted, removes all routes on the page.
 */
export async function removeRoute(page: Page, pattern?: string): Promise<void> {
  if (pattern) {
    await page.unroute(pattern);
  } else {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
}

/**
 * Set the page's network connectivity state.
 * - 'online': normal connectivity
 * - 'offline': emulated offline mode (requests fail)
 */
export async function setNetworkState(page: Page, state: 'online' | 'offline'): Promise<void> {
  await page.context().setOffline(state === 'offline');
}
