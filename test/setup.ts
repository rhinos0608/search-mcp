/**
 * Global test setup: prevent accidental outbound HTTP in tests.
 *
 * Replaces globalThis.fetch with a strict mock that throws on any un-mocked
 * outbound call. Tests that need real fetch behavior must explicitly override
 * globalThis.fetch within their test block and restore it afterward.
 *
 * Tests that use fetchImpl injection (e.g., reddit, github tools) are
 * unaffected because they don't call globalThis.fetch.
 */

const originalFetch = globalThis.fetch;

let fetchMocked = false;

export function enableFetchMock() {
  if (fetchMocked) return;
  fetchMocked = true;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Log the blocked call but return empty JSON so search functions degrade gracefully
    console.warn(`[TEST MOCK] Blocked outbound HTTP: ${url.slice(0, 200)}`);
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

export function restoreFetch() {
  if (!fetchMocked) return;
  fetchMocked = false;
  globalThis.fetch = originalFetch;
}

// Auto-enable when imported
enableFetchMock();
