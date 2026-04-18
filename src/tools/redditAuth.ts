import { logger } from '../logger.js';
import { validationError, unavailableError } from '../errors.js';
import { safeResponseText } from '../httpGuards.js';

/** 60-second proactive refresh margin before the token actually expires. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';

export interface RedditAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface RedditClock {
  now: () => number;
}

export const systemRedditClock: RedditClock = { now: () => Date.now() };

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  credentialsKey: string;
}

/**
 * Module-level in-memory token cache keyed by the credential pair.
 *
 * Scoped per-credential so tests (and hypothetical multi-tenant use) can swap
 * credentials without leaking a stale token into a different client.
 */
let cachedToken: CachedToken | null = null;

/**
 * Singleflight slot for in-flight token fetches.
 *
 * When multiple concurrent callers see no fresh cached token, the first one
 * initiates a fetch and stashes its promise here; subsequent callers await the
 * same promise rather than issuing duplicate token requests.
 */
let inFlightToken: Promise<CachedToken> | null = null;

export function resetRedditAuthCache(): void {
  cachedToken = null;
  inFlightToken = null;
}

export function credentialsKey(creds: RedditAuthCredentials): string {
  return `${creds.clientId}:${creds.clientSecret}`;
}

export function assertFullCredentials(
  creds: RedditAuthCredentials | undefined,
): RedditAuthCredentials | undefined {
  if (creds === undefined) return undefined;
  // Trim so whitespace-only values (e.g. misquoted .env lines) are treated as empty.
  const clientId = creds.clientId.trim();
  const clientSecret = creds.clientSecret.trim();
  const hasId = clientId !== '';
  const hasSecret = clientSecret !== '';
  if (hasId !== hasSecret) {
    throw validationError(
      'Reddit OAuth is partially configured: both clientId and clientSecret are required together.',
      { backend: 'reddit' },
    );
  }
  if (!hasId) return undefined;
  return { clientId, clientSecret };
}

interface TokenFetchOptions {
  credentials: RedditAuthCredentials;
  userAgent: string;
  fetchImpl: typeof fetch;
  clock: RedditClock;
  signal?: AbortSignal;
}

async function fetchAccessToken(options: TokenFetchOptions): Promise<CachedToken> {
  const { credentials, userAgent, fetchImpl, clock, signal } = options;
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    'base64',
  );
  const issuedAt = clock.now();

  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  };
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, init);
  } catch (err) {
    throw unavailableError('Reddit OAuth token request failed', {
      backend: 'reddit',
      cause: err,
    });
  }

  let bodyText: string;
  try {
    bodyText = await safeResponseText(response, TOKEN_ENDPOINT);
  } catch (err) {
    throw unavailableError('Reddit OAuth token response could not be read', {
      backend: 'reddit',
      cause: err,
    });
  }

  if (response.status === 401) {
    throw validationError(
      'Reddit OAuth credentials were rejected by Reddit (401). Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.',
      { backend: 'reddit', statusCode: 401 },
    );
  }

  if (!response.ok) {
    throw unavailableError(`Reddit OAuth token endpoint returned ${String(response.status)}`, {
      backend: 'reddit',
      statusCode: response.status,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw unavailableError('Reddit OAuth token response was not valid JSON', {
      backend: 'reddit',
      cause: err,
    });
  }

  const body = parsed as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };

  if (typeof body.error === 'string') {
    throw validationError(
      `Reddit OAuth token endpoint returned error "${body.error}". Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`,
      { backend: 'reddit' },
    );
  }

  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw unavailableError('Reddit OAuth token response was missing access_token', {
      backend: 'reddit',
    });
  }

  const expiresInSec =
    typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const expiresAt = issuedAt + expiresInSec * 1000 - TOKEN_SAFETY_MARGIN_MS;

  return {
    accessToken: body.access_token,
    expiresAt,
    credentialsKey: credentialsKey(credentials),
  };
}

export interface GetAccessTokenOptions {
  credentials: RedditAuthCredentials;
  userAgent: string;
  fetchImpl: typeof fetch;
  clock: RedditClock;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

/**
 * Return a valid OAuth access token, refreshing when missing, expired, or
 * explicitly forced (reactive refresh after a 401).
 */
export async function getAccessToken(options: GetAccessTokenOptions): Promise<string> {
  const key = credentialsKey(options.credentials);
  const existing = cachedToken;
  const tokenFresh =
    options.forceRefresh !== true &&
    existing !== null &&
    existing.credentialsKey === key &&
    options.clock.now() <= existing.expiresAt;

  if (tokenFresh) {
    return existing.accessToken;
  }

  // If another caller is already fetching a token for the same credentials,
  // await their result instead of issuing a duplicate token request.
  if (inFlightToken !== null) {
    const shared = await inFlightToken;
    if (shared.credentialsKey === key) {
      return shared.accessToken;
    }
    // The in-flight fetch was for a different credential set; fall through and
    // issue our own request.
  }

  const tokenOptions: TokenFetchOptions = {
    credentials: options.credentials,
    userAgent: options.userAgent,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
  };
  if (options.signal !== undefined) tokenOptions.signal = options.signal;

  const pending = fetchAccessToken(tokenOptions);
  inFlightToken = pending;
  try {
    const fresh = await pending;
    cachedToken = fresh;
    logger.debug(
      { backend: 'reddit', expiresAt: new Date(fresh.expiresAt).toISOString() },
      'Reddit OAuth token refreshed',
    );
    return fresh.accessToken;
  } finally {
    // Only clear the slot if it still points at *our* pending promise. If
    // another credential set started its own fetch while we were awaiting, we
    // must not stomp on its slot.
    if (inFlightToken === pending) {
      inFlightToken = null;
    }
  }
}

export function clearCachedTokenForCredentials(creds: RedditAuthCredentials): void {
  if (cachedToken !== null && cachedToken.credentialsKey === credentialsKey(creds)) {
    cachedToken = null;
  }
}
