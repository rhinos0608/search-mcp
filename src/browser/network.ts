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

interface TrackedPageState {
  requests: TrackedRequest[];
  handler: (request: import('playwright-core').Request) => void;
}

const MAX_TRACKED_REQUESTS = 100;
const MAX_BODY_CHARS = 4000;
const REDACTED = '•••';

// Header names that must be redacted (lower-cased)
const SENSITIVE_HEADER_EXACT = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);
const SENSITIVE_HEADER_SUBSTR =
  /token|secret|api[_-]?key|password|session|signature|credential|authorization/i;
const SENSITIVE_QUERY_PARAM =
  /(token|secret|api[_-]?key|apikey|password|passwd|pwd|auth|session|signature|credential|amz|x-amz)/i;
const SENSITIVE_BODY_KEY =
  /password|passwd|pwd|secret|token|credential|authorization|api[_-]?key|session|signature/i;

export function sanitizeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    if (u.username || u.password) {
      u.username = REDACTED;
      u.password = REDACTED;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) u.searchParams.set(key, REDACTED);
    }
    return u.toString();
  } catch {
    // malformed URL fail closed
    return REDACTED;
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_HEADER_EXACT.has(lk) || SENSITIVE_HEADER_SUBSTR.test(k)) out[k] = REDACTED;
    else out[k] = v;
  }
  return out;
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEY.test(k)) out[k] = REDACTED;
      else out[k] = redactJsonValue(v);
    }
    return out;
  }
  return value;
}

function isMultipartBody(body: string): boolean {
  return /multipart\/form-data|Content-Disposition:\s*form-data|boundary=|------WebKitFormBoundary/i.test(
    body,
  );
}

export function redactBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const trimmed = body.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return JSON.stringify(redactJsonValue(parsed));
    } catch {
      return REDACTED;
    }
  }
  // Multipart -> fail closed whole body
  if (isMultipartBody(body)) {
    return REDACTED;
  }
  let redacted = body;
  // Plain Bearer values - must run before form to capture Authorization: Bearer token as whole
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, `Bearer ${REDACTED}`);
  // JWT-shaped tokens - before form so token=JWT is fully hidden even if form partially redacts
  redacted = redacted.replace(
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}[A-Za-z0-9._-]*/g,
    REDACTED,
  );
  redacted = redacted.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
  // Broad sensitive key forms: camelCase/prefix/suffix (accessToken, refreshToken, clientSecret, passwordHash, userPassword) via substring match
  // Form/urlencoded + plain colon/equal: key[:=] value
  const formKeyPattern =
    /([^\s=&:]*?(?:password|passwd|pwd|secret|token|credential|authorization|api[_-]?key|session|signature)[^\s=&:]*)\s*[:=]\s*[^&\s\n,;"']+/gi;
  redacted = redacted.replace(formKeyPattern, (_m: string, k: string) => `${k}=${REDACTED}`);
  // JSON quoted keys containing sensitive substring (covers camelCase, quoted JSON fragments)
  const jsonQuotedPattern =
    /"([^"]*?(?:password|passwd|pwd|secret|token|credential|authorization|api[_-]?key|session|signature)[^"]*)"\s*:\s*"[^"]*"/gi;
  redacted = redacted.replace(jsonQuotedPattern, (_m: string, k: string) => `"${k}":"${REDACTED}"`);
  // Single-quoted variant
  const jsonSinglePattern =
    /'([^']*?(?:password|passwd|pwd|secret|token|credential|authorization|api[_-]?key|session|signature)[^']*)'\s*:\s*'[^']*'/gi;
  redacted = redacted.replace(jsonSinglePattern, (_m: string, k: string) => `'${k}':'${REDACTED}'`);
  return redacted;
}

/** Map of Page → tracked requests + handler reference (GC-friendly). */
const trackedPages = new WeakMap<Page, TrackedPageState>();

// ─────────────────────────────────────────────────────────────────────────────
// § Request tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start tracking network requests on a page.
 * Must be called before navigation.
 */
export function startRequestTracking(page: Page): void {
  // Idempotent: remove existing handler before adding new one (prevents duplicate listeners)
  if (trackedPages.has(page)) stopRequestTracking(page);
  const requests: TrackedRequest[] = [];
  const handler = (request: import('playwright-core').Request): void => {
    const startTime = Date.now();

    request
      .response()
      .then(async (response) => {
        if (!response) return;

        const entry: TrackedRequest = {
          index: requests.length + 1,
          method: request.method(),
          url: sanitizeUrl(request.url()),
          status: response.status(),
          timing: Date.now() - startTime,
          requestHeaders: redactHeaders(request.headers()),
          requestBody: redactBody(request.postData() ?? undefined),
          responseHeaders: redactHeaders(response.headers()),
          responseBody: undefined,
        };

        // Await body before pushing so getRequestDetails sees complete data — redact before truncating to avoid breaking JSON redaction
        try {
          const body = await response.body();
          const raw = body.toString('utf8');
          const redacted = redactBody(raw);
          entry.responseBody =
            redacted !== undefined ? redacted.slice(0, MAX_BODY_CHARS) : undefined;
        } catch {
          // Response body may not be available (redirects, errors)
        }

        if (requests.length >= MAX_TRACKED_REQUESTS) requests.shift();
        requests.push(entry);
      })
      .catch(() => {
        // Request may never get a response (aborted, failed)
      });
  };

  trackedPages.set(page, { requests, handler });
  page.on('request', handler);
}

/**
 * Stop tracking network requests on a page.
 * Clears all tracked request data.
 */
export function stopRequestTracking(page: Page): void {
  const state = trackedPages.get(page);
  if (state) {
    try {
      page.off('request', state.handler);
    } catch {
      /* idempotent: page may be closed */
    }
  }
  trackedPages.delete(page);
}

export function isTracking(page: Page): boolean {
  return trackedPages.has(page);
}

/**
 * List tracked requests, optionally filtered by URL regex.
 */
export function listRequests(page: Page, filter?: RegExp): NetworkRequest[] {
  const requests = trackedPages.get(page)?.requests ?? [];
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
  const requests = trackedPages.get(page)?.requests ?? [];
  const req = requests.find((r) => r.index === index);
  if (!req) return null;

  // Build result with exactOptionalPropertyTypes compatibility
  // Defensive: re-apply redaction even though capture already redacted
  const detail: NetworkRequestDetail = {
    requestHeaders: redactHeaders(req.requestHeaders),
    responseHeaders: redactHeaders(req.responseHeaders),
  };
  if (req.requestBody !== undefined) {
    const rb = redactBody(req.requestBody);
    if (rb !== undefined) detail.requestBody = rb;
  }
  if (req.responseBody !== undefined) {
    const rb2 = redactBody(req.responseBody);
    if (rb2 !== undefined) detail.responseBody = rb2;
  }
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
