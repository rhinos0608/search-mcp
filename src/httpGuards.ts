/**
 * Shared HTTP safety guards: SSRF protection and response size limiting.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/** Default set of hostnames always blocked. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '0.0.0.0',
  'metadata.google.internal',
]);

/** Additional hostnames blocked when strict mode is enforced. */
const STRICT_BLOCKED = new Set([
  '169.254.169.254', // AWS metadata
  'metadata.google.internal',
]);

function parseLegacyIPv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length > 4 || parts.length === 0) return undefined;
  const nums = parts.map((part) => {
    if (!/^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[0-9]+)$/.test(part)) return undefined;
    const radix = /^0[xX]/.test(part) ? 16 : part.length > 1 && part.startsWith('0') ? 8 : 10;
    return Number.parseInt(part.replace(/^0[xX]/, ''), radix);
  });
  if (nums.some((part) => part === undefined || !Number.isSafeInteger(part) || part < 0))
    return undefined;
  const values = nums as number[];
  const value32 =
    values.length === 1 ? (values[0] ?? 0) : values.reduce((n, part) => n * 256 + part, 0);
  return value32 <= 0xffffffff ? value32 : undefined;
}

function isPrivateIPv4(hostname: string): boolean {
  const value = parseLegacyIPv4(hostname.toLowerCase());
  if (value === undefined) return false;
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function decodeEmbeddedIPv4(address: string): string | undefined {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const match = /^::(?:ffff:)?(.+)$/.exec(normalized);
  if (!match) return undefined;
  const tail = match[1] ?? '';
  if (tail.includes('.')) return parseLegacyIPv4(tail) === undefined ? undefined : tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const hi = Number.parseInt(hex[1] ?? '', 16);
  const lo = Number.parseInt(hex[2] ?? '', 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return undefined;
  return [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255].join('.');
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateIPv4(normalized)) return true;
  const embedded = decodeEmbeddedIPv4(normalized);
  if (embedded !== undefined && isPrivateIPv4(embedded)) return true;
  if (net.isIP(normalized) !== 6) return false;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^(fc|fd|fe[89a-f]|ff)/.test(normalized) ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('2001:2:') ||
    normalized.startsWith('2001:10:') ||
    normalized.startsWith('2001:20:')
  );
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
  redirectCount: number;
}
export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  networkPolicy?: 'public' | 'operator_internal';
  resolver?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** Internal endpoints are operator configuration, never MCP/user input. */
  internalAllowlist?: readonly string[];
  request?: (
    options: http.RequestOptions,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<{
    statusCode?: number;
    statusMessage?: string;
    headers: http.IncomingHttpHeaders;
    body: Uint8Array;
  }>;
}
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const SAFE_REDIRECT_HEADERS = new Set(['accept', 'accept-language', 'cache-control', 'user-agent']);
function isForbiddenInternalAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  if (family === 4) {
    const value = parseLegacyIPv4(normalized) ?? 0;
    const first = value >>> 24;
    return value === 0 || (first === 169 && ((value >>> 16) & 255) === 254) || first >= 224;
  }
  if (family === 6)
    return normalized === '::' || /^fe[89a-f]/.test(normalized) || normalized.startsWith('ff');
  return true;
}

function requestOnce(
  options: http.RequestOptions,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{
  statusCode?: number;
  statusMessage?: string;
  headers: http.IncomingHttpHeaders;
  body: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === 'https:' ? https : http;
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const req = transport.request(options, (res) => {
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          res.destroy();
          req.destroy(new Error(`Response exceeded size limit (>${String(maxBytes)} bytes)`));
          reject(new Error(`Response exceeded size limit (>${String(maxBytes)} bytes)`));
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({
          ...(res.statusCode === undefined ? {} : { statusCode: res.statusCode }),
          ...(res.statusMessage === undefined ? {} : { statusMessage: res.statusMessage }),
          headers: res.headers,
          body: new Uint8Array(Buffer.concat(chunks)),
        });
      });
      res.on('error', (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
    const timer = options.timeout
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener('abort', abort);
            req.destroy();
            reject(new Error('safe fetch deadline exceeded'));
          }
        }, options.timeout)
      : undefined;
    const abort = () => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        req.destroy();
        reject(new Error('safe fetch aborted'));
      }
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }
    req.on('error', (error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.end();
  });
}
async function boundedRequest<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
  remaining: number,
  cancel: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('safe fetch deadline exceeded'));
    }, remaining);
    const abort = () => {
      finish(new Error('safe fetch aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        cancel();
        reject(error);
      } else if (value === undefined) reject(new Error('safe fetch request returned no result'));
      else resolve(value);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    request.then(
      (value) => {
        finish(undefined, value);
      },
      (error: unknown) => {
        finish(error instanceof Error ? error : new Error('safe fetch request failed'));
      },
    );
  });
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD')
    throw new Error('safeFetch only supports GET and HEAD');
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  if (options.signal?.aborted) throw new Error('safe fetch aborted');
  let current = url;
  let redirectCount = 0;
  let headers = new Headers(init.headers);
  headers.delete('host');
  headers.set('accept-encoding', 'identity');
  while (redirectCount <= maxRedirects) {
    const parsed = new URL(current);
    const internal = options.networkPolicy === 'operator_internal';
    assertSafeUrl(current, internal);
    if (parsed.username || parsed.password) throw new Error('safeFetch rejects URL credentials');
    const resolve =
      options.resolver ??
      ((host: string) =>
        dns
          .lookup(host, { all: true, verbatim: true })
          .then((xs) => xs.map((x) => ({ address: x.address, family: x.family as 4 | 6 }))));
    if (internal && !(options.internalAllowlist ?? []).includes(parsed.hostname))
      throw new Error('operator_internal requires configured endpoint authorization');
    const remaining = Math.max(1, deadline - Date.now());
    const answers = await new Promise<{ address: string; family: 4 | 6 }[]>(
      (resolveAnswers, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          finish(new Error('safe fetch deadline exceeded'));
        }, remaining);
        const abort = () => {
          finish(new Error('safe fetch aborted'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        };
        const finish = (error?: Error, value?: { address: string; family: 4 | 6 }[]) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else if (value === undefined) reject(new Error('DNS resolution returned no result'));
          else resolveAnswers(value);
        };
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        resolve(parsed.hostname).then(
          (value) => {
            const valid = value.filter(
              (entry) => net.isIP(entry.address.replace(/^\[|\]$/g, '')) === entry.family,
            );
            if (valid.length !== value.length) {
              finish(new Error('DNS resolver returned invalid address or family'));
              return;
            }
            finish(undefined, valid);
          },
          (error: unknown) => {
            finish(error instanceof Error ? error : new Error('DNS resolution failed'));
          },
        );
      },
    );
    if (answers.length === 0) throw new Error(`No DNS answers for host "${parsed.hostname}"`);
    if (!internal && answers.some(({ address }) => isPrivateOrReservedAddress(address)))
      throw new Error(`Blocked mixed or private DNS answers for host "${parsed.hostname}"`);
    const selected = internal
      ? answers.find(({ address }) => !isForbiddenInternalAddress(address))
      : answers[0];
    if (!selected)
      throw new Error(
        `Blocked request to private or reserved address for host "${parsed.hostname}"`,
      );
    if (Date.now() >= deadline) throw new Error('safeFetch deadline exceeded');
    const request = options.request ?? requestOnce;
    const requestController = new AbortController();
    const relayAbort = () => {
      requestController.abort();
    };
    if (options.signal) options.signal.addEventListener('abort', relayAbort, { once: true });
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      host: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: Object.fromEntries(headers),
      lookup: (
        _h: string,
        _o: unknown,
        callback: (error: Error | null, address?: string, family?: number) => void,
      ) => {
        callback(null, selected.address, selected.family);
      },
      servername: parsed.hostname,
      timeout: Math.max(1, deadline - Date.now()),
    } as http.RequestOptions;
    let result: Awaited<ReturnType<typeof requestOnce>>;
    try {
      result = await boundedRequest(
        request(requestOptions, maxBytes, requestController.signal),
        options.signal,
        Math.max(1, deadline - Date.now()),
        () => {
          requestController.abort();
        },
      );
    } finally {
      options.signal?.removeEventListener('abort', relayAbort);
    }
    if (result.body.byteLength > maxBytes)
      throw new Error(`Response exceeded size limit (>${String(maxBytes)} bytes)`);
    const status = result.statusCode ?? 0;
    const encoding = result.headers['content-encoding'];
    if (encoding && encoding !== 'identity')
      throw new Error('Encoded responses are not supported by safeFetch');
    if (!REDIRECT_CODES.has(status))
      return {
        finalUrl: current,
        status,
        statusText: result.statusMessage ?? '',
        headers: new Headers(
          Object.entries(result.headers).flatMap(([key, value]): [string, string][] =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]],
          ),
        ),
        body: result.body,
        redirectCount,
      };
    const location = result.headers.location;
    if (typeof location !== 'string') throw new Error('Redirect missing Location header');
    if (redirectCount >= maxRedirects)
      throw new Error(`Too many redirects (max ${String(maxRedirects)})`);
    const next = new URL(location, current);
    const sameOrigin = next.origin === parsed.origin;
    current = next.toString();
    redirectCount += 1;
    if (!sameOrigin) {
      const safe = new Headers();
      for (const [key, value] of headers) if (SAFE_REDIRECT_HEADERS.has(key)) safe.set(key, value);
      headers = safe;
    }
    headers.set('accept-encoding', 'identity');
  }
  throw new Error(`Too many redirects (max ${String(maxRedirects)})`);
}

/**
 * Check if a hostname is a raw IP address (IPv4 or IPv6).
 */
function isRawIpAddress(hostname: string): boolean {
  // IPv4
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4Pattern.test(hostname)) return true;
  // IPv6 (bracketed or bare)
  if (hostname.startsWith('[')) return true;
  if (hostname.includes(':')) return true;
  return false;
}

/**
 * Validate a URL is safe to fetch (not targeting internal networks).
 * Throws if the URL is blocked.
 *
 * @param url - The URL to validate
 * @param allowInternal - If true, allows localhost/private IPs (for operator-configured sidecars).
 */
export function assertSafeUrl(url: string, allowInternal = false): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" — only http and https are allowed`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block raw IP addresses early — prevents DNS rebind style attacks
  // where a domain resolves to an internal IP after passing this check.
  // For domain names, the check is best-effort; callers should also
  // validate after resolution if possible.
  if (isRawIpAddress(hostname) && !allowInternal) {
    // Check both original and IPv6-mapped-decoded form
    if (isPrivateIPv4(hostname)) {
      throw new Error(`Blocked request to private IP address "${hostname}"`);
    }
    if (hostname.startsWith('[')) {
      const inner = hostname.slice(1, -1).toLowerCase();
      if (isPrivateOrReservedAddress(inner)) {
        throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
      }
      if (inner.startsWith('::ffff:')) {
        const ipv4 = inner.slice(7);
        if (isPrivateIPv4(ipv4)) {
          throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
        }
        // Handle compressed IPv4-mapped form: ::ffff:hhhh:hhhh
        // WHATWG URL normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1]
        const colonIdx = ipv4.indexOf(':');
        if (colonIdx !== -1) {
          const hi = parseInt(ipv4.slice(0, colonIdx), 16);
          const lo = parseInt(ipv4.slice(colonIdx + 1), 16);
          if (!isNaN(hi) && !isNaN(lo)) {
            const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
            if (isPrivateIPv4(octets.join('.'))) {
              throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
            }
          }
        }
      }
    }
    return;
  }

  // When allowInternal is true, only block cloud metadata endpoints
  if (allowInternal) {
    if (STRICT_BLOCKED.has(hostname)) {
      throw new Error(`Blocked request to cloud metadata host "${hostname}"`);
    }
    return;
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked request to internal host "${hostname}"`);
  }

  if (isPrivateIPv4(hostname)) {
    throw new Error(`Blocked request to private IP address "${hostname}"`);
  }

  // Block IPv6 private ranges (::1, fe80::, fc00::, fd00::)
  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1).toLowerCase();
    if (isPrivateOrReservedAddress(inner)) {
      throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
    }
    if (inner.startsWith('::ffff:')) {
      const ipv4 = inner.slice(7);
      if (isPrivateIPv4(ipv4)) {
        throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
      }
      // Handle compressed IPv4-mapped form: ::ffff:hhhh:hhhh
      const colonIdx = ipv4.indexOf(':');
      if (colonIdx !== -1) {
        const hi = parseInt(ipv4.slice(0, colonIdx), 16);
        const lo = parseInt(ipv4.slice(colonIdx + 1), 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
          if (isPrivateIPv4(octets.join('.'))) {
            throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
          }
        }
      }
    }
  }
}

/** Maximum response body size in bytes (50 MB). */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Validate that a hostname's DNS answers are all public before navigation.
 * Mirrors safeFetch's public-policy DNS check: lookup all answers, fail closed
 * on empty/invalid answers or any private/reserved address. Raw-IP and scheme
 * checks belong to {@link assertSafeUrl}; this covers hostname resolution only.
 *
 * Note: this validates resolution at check time — it does not pin DNS, and
 * Chromium re-resolves at connection time. Do not describe this as DNS
 * rebinding prevention.
 */
export async function assertSafeResolvedHost(
  hostname: string,
  resolver?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>,
): Promise<void> {
  const resolve =
    resolver ??
    ((host: string) =>
      dns
        .lookup(host, { all: true, verbatim: true })
        .then((xs) => xs.map((x) => ({ address: x.address, family: x.family as 4 | 6 }))));
  const answers = await resolve(hostname);
  if (answers.length === 0)
    throw new Error(`DNS resolution returned no answers for host "${hostname}"`);
  const valid = answers.filter(
    (entry) => net.isIP(entry.address.replace(/^\[|\]$/g, '')) === entry.family,
  );
  if (valid.length !== answers.length)
    throw new Error(`DNS resolver returned invalid address or family for host "${hostname}"`);
  if (answers.some(({ address }) => isPrivateOrReservedAddress(address)))
    throw new Error(`Blocked mixed or private DNS answers for host "${hostname}"`);
}

/**
 * Read the response body as text, enforcing a size limit.
 * Throws if the response exceeds the limit (default MAX_RESPONSE_BYTES).
 */
export async function safeResponseText(
  response: Response,
  url: string,
  maxBytes?: number,
): Promise<string> {
  const limit = maxBytes ?? MAX_RESPONSE_BYTES;
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > limit) {
      throw new Error(
        `Response from "${url}" is too large (${String(len)} bytes, max ${String(limit)})`,
      );
    }
  }

  // Stream-read with size enforcement for responses without Content-Length
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      reader.cancel().catch(() => {
        /* discard */
      });
      throw new Error(`Response from "${url}" exceeded size limit (>${String(limit)} bytes)`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Read the response body as JSON, enforcing a size limit.
 */
export async function safeResponseJson(
  response: Response,
  url: string,
  maxBytes?: number,
): Promise<unknown> {
  const text = await safeResponseText(response, url, maxBytes);
  return JSON.parse(text) as unknown;
}

/** Standard truncation marker used across all tools. */
export const TRUNCATED_MARKER = '... [truncated]';
