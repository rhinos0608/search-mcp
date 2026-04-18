import { safeResponseJson } from '../httpGuards.js';
import { loadConfig } from '../config.js';
import { validationError } from '../errors.js';
import {
  assertFullCredentials,
  clearCachedTokenForCredentials,
  getAccessToken,
  resetRedditAuthCache as resetAuthCacheImpl,
  systemRedditClock,
  type RedditAuthCredentials,
  type RedditClock,
} from './redditAuth.js';

export const DEFAULT_REDDIT_USER_AGENT = 'search-mcp/1.0 (MCP server for local use)';
const REDDIT_PUBLIC_BASE_URL = 'https://www.reddit.com';
const REDDIT_OAUTH_BASE_URL = 'https://oauth.reddit.com';

type RedditQueryValue = string | number | boolean | undefined;

export interface RedditClientOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  baseUrl?: string;
  auth?: RedditAuthCredentials;
  clock?: RedditClock;
}

export interface RedditRequestOptions {
  signal?: AbortSignal;
}

export interface RedditJsonResponse {
  json: unknown;
  url: string;
  status: number;
  headers: Record<string, string>;
}

export function resetRedditAuthCache(): void {
  resetAuthCacheImpl();
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function normalizePublicPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error('Reddit request path must not be empty');
  }
  if (trimmed.startsWith('//')) {
    throw new Error(`Invalid Reddit request path: "${path}"`);
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash =
    withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, '') : withLeadingSlash;
  return withoutTrailingSlash.endsWith('.json')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}.json`;
}

function normalizeOAuthPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error('Reddit request path must not be empty');
  }
  if (trimmed.startsWith('//')) {
    throw new Error(`Invalid Reddit request path: "${path}"`);
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutJson = withLeadingSlash.replace(/\.json$/u, '');
  return withoutJson.length > 1 ? withoutJson.replace(/\/+$/u, '') : withoutJson;
}

export function buildRedditJsonUrl(
  path: string,
  query: Record<string, RedditQueryValue> = {},
  baseUrl = REDDIT_PUBLIC_BASE_URL,
): string {
  const normalized =
    baseUrl === REDDIT_OAUTH_BASE_URL ? normalizeOAuthPath(path) : normalizePublicPath(path);
  const url = new URL(normalized, baseUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

export function createRedditClient(options: RedditClientOptions = {}) {
  const credentials = assertFullCredentials(options.auth);
  const userAgent = options.userAgent ?? DEFAULT_REDDIT_USER_AGENT;
  const clock = options.clock ?? systemRedditClock;
  const baseUrl =
    options.baseUrl ?? (credentials !== undefined ? REDDIT_OAUTH_BASE_URL : REDDIT_PUBLIC_BASE_URL);

  async function authHeader(
    forceRefresh: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (credentials === undefined) return undefined;
    const tokenArgs: Parameters<typeof getAccessToken>[0] = {
      credentials,
      userAgent,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      clock,
      forceRefresh,
    };
    if (signal !== undefined) tokenArgs.signal = signal;
    const token = await getAccessToken(tokenArgs);
    return `bearer ${token}`;
  }

  async function request(
    path: string,
    query: Record<string, RedditQueryValue> = {},
    requestOptions: RedditRequestOptions = {},
  ): Promise<{ response: Response; url: string }> {
    const url = buildRedditJsonUrl(path, query, baseUrl);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = { 'User-Agent': userAgent };
    const auth = await authHeader(false, requestOptions.signal);
    if (auth !== undefined) headers.Authorization = auth;

    const init: RequestInit = { headers };
    if (requestOptions.signal !== undefined) init.signal = requestOptions.signal;

    let response = await fetchImpl(url, init);

    if (credentials !== undefined && response.status === 401) {
      clearCachedTokenForCredentials(credentials);
      const retryAuth = await authHeader(true, requestOptions.signal);
      if (retryAuth !== undefined) {
        const retryHeaders: Record<string, string> = {
          'User-Agent': userAgent,
          Authorization: retryAuth,
        };
        const retryInit: RequestInit = { headers: retryHeaders };
        if (requestOptions.signal !== undefined) retryInit.signal = requestOptions.signal;
        response = await fetchImpl(url, retryInit);
      }
    }

    return { response, url };
  }

  return {
    usesOAuth(): boolean {
      return credentials !== undefined;
    },

    buildUrl(path: string, query: Record<string, RedditQueryValue> = {}): string {
      return buildRedditJsonUrl(path, query, baseUrl);
    },

    async fetch(
      path: string,
      query: Record<string, RedditQueryValue> = {},
      requestOptions: RedditRequestOptions = {},
    ): Promise<{ response: Response; url: string }> {
      return request(path, query, requestOptions);
    },

    async getJson(
      path: string,
      query: Record<string, RedditQueryValue> = {},
      requestOptions: RedditRequestOptions = {},
    ): Promise<unknown> {
      const { response, url } = await request(path, query, requestOptions);
      return safeResponseJson(response, url);
    },

    async fetchJson(
      path: string,
      query: Record<string, RedditQueryValue> = {},
      requestOptions: RedditRequestOptions = {},
    ): Promise<RedditJsonResponse> {
      const { response, url } = await request(path, query, requestOptions);
      return {
        json: await safeResponseJson(response, url),
        url,
        status: response.status,
        headers: responseHeadersToObject(response.headers),
      };
    },
  };
}

/**
 * Merge caller-provided client options with values from the loaded config.
 *
 * - Trusts any `overrides.auth` the caller passes (even if config is partial).
 * - Throws `VALIDATION_ERROR` when config is partial (`oauthConfigValid === false`)
 *   and the caller did not supply their own `auth`.
 * - When the caller omits `auth` and config has valid OAuth, fills it in.
 * - When the caller omits `userAgent` and config has a non-empty one, fills it in.
 */
export function mergeRedditClientOptions(overrides: RedditClientOptions): RedditClientOptions {
  const cfg = loadConfig();
  if (!cfg.reddit.oauthConfigValid && overrides.auth === undefined) {
    throw validationError(
      'Reddit OAuth is partially configured: set both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET, or unset both.',
      { backend: 'reddit' },
    );
  }
  const merged: RedditClientOptions = { ...overrides };
  if (overrides.auth === undefined && cfg.reddit.oauthEnabled) {
    merged.auth = { clientId: cfg.reddit.clientId, clientSecret: cfg.reddit.clientSecret };
  }
  if (overrides.userAgent === undefined && cfg.reddit.userAgent !== '') {
    merged.userAgent = cfg.reddit.userAgent;
  }
  return merged;
}
