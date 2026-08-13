/**
 * Codex/ChatGPT web search provider.
 *
 * Uses the ChatGPT backend endpoint that the OpenAI Codex CLI uses for web
 * search. The endpoint is undocumented and reverse-engineered from Codex CLI
 * behavior — it may change or stop working at any time, access may be limited
 * by account eligibility and usage limits, and usage may be subject to
 * OpenAI/ChatGPT terms. This is a best-effort integration and is NOT an
 * official OpenAI integration. Limited support.
 *
 * Credentials are discovered without exposing the token:
 *  - `CODEX_ACCESS_TOKEN` env var (non-empty) wins, with optional
 *    `CODEX_ACCOUNT_ID`;
 *  - otherwise `${CODEX_HOME || ~/.codex}/auth.json` is read, extracting only
 *    `tokens.access_token` (and optional `tokens.account_id`).
 * Malformed, missing, or unusable sources mean "unconfigured". The token,
 * auth file contents, paths, and raw credential errors are never returned or
 * logged.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError } from '../errors.js';
import { getUserAgent } from '../version.js';
import { ToolCache, cacheKey } from '../cache.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import type { SearchResult } from '../types.js';

/**
 * Fixed endpoint only — no override. An overridable endpoint would let an
 * attacker redirect requests (and the bearer token) to an arbitrary host.
 */
export const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';
const CODEX_MODEL = 'gpt-4o';
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * HTTP header values must not contain CR/LF (header injection); reject any
 * character outside printable ASCII (0x20-0x7e) defensively so a malformed
 * credential can never be echoed back by fetch in an error or header. This
 * preserves the existing rejection of C0 controls and DEL while also treating
 * higher Unicode / non-ASCII credential characters as invalid.
 */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code > 0x7e)) {
      return true;
    }
  }
  return false;
}

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
}

export interface CodexSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Credential discovery. Env vars win; otherwise the Codex auth file
 * (`${CODEX_HOME || ~/.codex}/auth.json`) is consulted. Returns undefined when
 * unconfigured. Never exposes the token to callers beyond the returned value.
 */
export function readCodexCredentials(
  env: Record<string, string | undefined>,
): CodexCredentials | undefined {
  const envToken = env.CODEX_ACCESS_TOKEN;
  if (typeof envToken === 'string' && envToken.trim()) {
    const accessToken = envToken.trim();
    // Control characters (e.g. CR/LF header injection) make the token unusable;
    // treat credentials as unavailable rather than building a bad header.
    if (hasControlCharacters(accessToken)) return undefined;
    const credentials: CodexCredentials = { accessToken };
    const envAccountId = env.CODEX_ACCOUNT_ID;
    if (typeof envAccountId === 'string' && envAccountId.trim()) {
      const accountId = envAccountId.trim();
      // The account id is optional — ignore an invalid one safely.
      if (!hasControlCharacters(accountId)) {
        credentials.accountId = accountId;
      }
    }
    return credentials;
  }

  const codexHome =
    typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
      ? env.CODEX_HOME
      : join(homedir(), '.codex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
  } catch {
    // Missing or malformed file means unconfigured. Credential errors are never surfaced.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const tokens = (parsed as Record<string, unknown>).tokens;
  if (typeof tokens !== 'object' || tokens === null) return undefined;
  const accessToken = (tokens as Record<string, unknown>).access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) return undefined;
  const trimmedAccess = accessToken.trim();
  if (hasControlCharacters(trimmedAccess)) return undefined;

  const credentials: CodexCredentials = { accessToken: trimmedAccess };
  const accountId = (tokens as Record<string, unknown>).account_id;
  if (typeof accountId === 'string' && accountId.trim()) {
    const trimmedAccount = accountId.trim();
    if (!hasControlCharacters(trimmedAccount)) {
      credentials.accountId = trimmedAccount;
    }
  }
  return credentials;
}

/** Whether Codex credentials are available (env var or Codex auth file). */
export function codexConfigured(env: Record<string, string | undefined>): boolean {
  return readCodexCredentials(env) !== undefined;
}

/**
 * Validate the external response boundary: only array result objects with a
 * non-empty http/https URL are accepted; title/snippet are trimmed strings.
 */
export function mapCodexResults(data: unknown, limit: number): CodexSearchResult[] {
  if (typeof data !== 'object' || data === null) return [];
  const rawResults = (data as Record<string, unknown>).results;
  if (!Array.isArray(rawResults)) return [];

  const results: CodexSearchResult[] = [];
  for (const item of rawResults) {
    if (results.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    const url = record.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const snippet = typeof record.snippet === 'string' ? record.snippet.trim() : undefined;
    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return results;
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Run a Codex web search. Returns the results mapped to the shared
 * `SearchResult` shape with `source: 'codex'`.
 *
 * Fixed endpoint only. Errors carry the HTTP status (so 5xx are retried per
 * current retry conventions and 401/403/429 are not) and never include the
 * response body. Returns [] when credentials are unavailable — callers gate
 * on `codexConfigured()`.
 */
const codexCache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

export async function codexSearch(query: string, limit: number): Promise<SearchResult[]> {
  const credentials = readCodexCredentials(process.env);
  if (!credentials) return [];

  // Scope the cache key to the active credentials so changed credentials
  // cannot reuse prior results. The credentialId is a non-secret hash.
  const credentialId = createHash('sha256')
    .update(credentials.accessToken)
    .update(credentials.accountId ?? '')
    .digest('hex')
    .slice(0, 8);
  const cacheKeyStr = cacheKey('codex', credentialId, query, String(limit));
  const cached = codexCache.get(cacheKeyStr);
  if (cached !== null) {
    logger.debug({ count: cached.length }, 'Codex search cache hit');
    return cached;
  }

  assertSafeUrl(CODEX_SEARCH_URL);

  // Gate on the shared rate-limit tracker before issuing a request.
  await assertRateLimitOk('codex');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (credentials.accountId) headers['ChatGPT-Account-ID'] = credentials.accountId;

  const body = {
    id: randomUUID(),
    model: CODEX_MODEL,
    commands: {
      search_query: [{ q: query }],
    },
  };

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(CODEX_SEARCH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401) {
        throw new ToolError('Codex search authentication failed (401)', {
          code: 'UNAVAILABLE',
          retryable: false,
          statusCode: 401,
          backend: 'codex',
        });
      }
      if (res.status === 403) {
        throw new ToolError('Codex search access denied (403)', {
          code: 'UNAVAILABLE',
          retryable: false,
          statusCode: 403,
          backend: 'codex',
        });
      }
      if (res.status === 429) {
        getTracker('codex').recordLimitHit();
        throw new ToolError('Codex search rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'codex',
        });
      }
      if (!res.ok) {
        // 5xx and other server errors — retryable per current conventions.
        throw unavailableError(`Codex search returned HTTP ${String(res.status)}`, {
          statusCode: res.status,
          backend: 'codex',
        });
      }
      return res;
    },
    { label: 'codex-search', maxAttempts: 3 },
  );

  const data = await safeResponseJson(response, CODEX_SEARCH_URL, DEFAULT_MAX_RESPONSE_BYTES);
  const mapped = mapCodexResults(data, limit);
  const results = mapped.map((r, i) => ({
    title: r.title,
    url: r.url,
    description: r.snippet ?? '',
    position: i + 1,
    domain: safeDomain(r.url),
    source: 'codex' as const,
    age: null,
    ageKind: 'unknown' as const,
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet' as const,
    generatedSummary: null,
  }));

  codexCache.set(cacheKeyStr, results);
  logger.info({ count: results.length }, 'Codex search complete');
  return results;
}
