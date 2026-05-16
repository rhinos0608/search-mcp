/**
 * Shared test helper: install a mock globalThis.fetch for tests that
 * call search backends (GDELT, ROR, OpenAlex, Wikidata, Crossref, DataCite, etc.).
 *
 * Usage:
 *   import { installFetchMock, restoreFetchMock } from './helpers/fetchMock.js';
 *   const mock = installFetchMock();
 *   // ... tests ...
 *   mock.restore();
 */

const realFetch = globalThis.fetch;

interface FetchMockResult {
  calls: { url: string; init?: RequestInit }[];
  restore: () => void;
}

export function installFetchMock(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchMockResult {
  const calls: { url: string; init?: RequestInit }[] = [];
  const defaultHandler = () => new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init !== undefined) {
      calls.push({ url, init });
    } else {
      calls.push({ url });
    }
    return (handler ?? defaultHandler)(url, init);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

export function restoreFetchMock(): void {
  globalThis.fetch = realFetch;
}
