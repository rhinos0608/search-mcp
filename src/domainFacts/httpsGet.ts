/**
 * Minimal HTTPS GET used by the domain-facts generator.
 *
 * Enforces an inactivity timeout and a maximum response-body size before
 * accumulating chunks, destroys the request on timeout, and settles the
 * promise exactly once (never resolves after a rejection). Redirect (3xx)
 * responses are surfaced via `location` without downloading a body.
 */
import https from 'node:https';
import dns from 'node:dns';

export interface HttpResult {
  status?: number;
  location?: string;
  data?: Buffer;
}

export interface HttpsGetOptions {
  /** Socket-inactivity timeout in ms before the request is destroyed. */
  timeoutMs?: number;
  /** Maximum accepted response body size in bytes. */
  maxBodyBytes?: number;
  /** Extra options forwarded to https.get (e.g. rejectUnauthorized for tests). */
  requestOptions?: https.RequestOptions;
}

/** Check whether a resolved IP address is loopback, unspecified, link-local,
 * or private (IPv4 and IPv6). Includes 169.254.0.0/16 (AWS metadata, etc.). */
function isPrivateOrSpecialAddress(addr: string): boolean {
  // IPv4
  if (
    addr === '0.0.0.0' ||
    addr === '127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    addr.startsWith('169.254.')
  ) {
    return true;
  }
  if (addr.startsWith('172.')) {
    const parts = addr.split('.');
    const second = parseInt(parts[1] ?? '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6
  if (addr === '::1' || addr === '::') return true;
  if (/^fe80:/i.test(addr)) return true; // link-local
  if (/^f[c-d]/i.test(addr)) return true; // unique local (fc00::/7)
  return false;
}

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

export function httpsGet(url: string, options: HttpsGetOptions = {}): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (result: HttpResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      fail(err);
      return;
    }
    if (target.protocol !== 'https:') {
      fail(new Error(`refusing non-HTTPS source URL: ${url}`));
      return;
    }

    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'search-mcp-domain-facts-generator/7.0.0' },
        ...options.requestOptions,
      },
      (res) => {
        res.setTimeout(timeoutMs, () => {
          res.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`));
        });

        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
          const rawLocation = res.headers.location;
          res.resume();
          if (rawLocation === undefined) {
            succeed({});
            return;
          }
          // Resolve relative Location values against the current request URL.
          let resolved: URL;
          try {
            resolved = new URL(rawLocation, target);
          } catch {
            fail(new Error(`invalid redirect Location: ${rawLocation}`));
            return;
          }
          // Reject unsafe targets: only HTTPS, no private/loopback/link-local
          // unless the target host matches the original request host.
          if (resolved.protocol !== 'https:') {
            fail(new Error(`refusing non-HTTPS redirect target: ${resolved.href}`));
            return;
          }
          if (resolved.hostname !== target.hostname) {
            // Resolve the redirect target's hostname to IP addresses and
            // validate every resolved address before accepting the redirect.
            // Hostname-only checks are insufficient — a DNS rebinding attack
            // can resolve a safe-looking hostname to a private IP.
            // When the hostname is already a literal IP address, validate it
            // directly without DNS resolution.
            const isIpLiteral =
              /^(\d{1,3}\.){3}\d{1,3}$/.test(resolved.hostname) ||
              /^[\da-f:]+$/i.test(resolved.hostname);
            if (isIpLiteral) {
              if (isPrivateOrSpecialAddress(resolved.hostname)) {
                fail(new Error(`refusing private-network redirect target: ${resolved.href}`));
                return;
              }
              succeed({ location: resolved.href });
              return;
            }
            dns.promises
              .resolve(resolved.hostname)
              .then((addresses) => {
                for (const addr of addresses) {
                  if (isPrivateOrSpecialAddress(addr)) {
                    fail(
                      new Error(
                        `refusing private-network redirect target: ${resolved.href} (resolved ${addr})`,
                      ),
                    );
                    return;
                  }
                }
                succeed({ location: resolved.href });
              })
              .catch(() => {
                // DNS resolution failed — fall back to hostname-pattern check
                // so the redirect is not blocked when DNS is unavailable.
                if (isPrivateOrSpecialAddress(resolved.hostname)) {
                  fail(new Error(`refusing private-network redirect target: ${resolved.href}`));
                  return;
                }
                succeed({ location: resolved.href });
              });
            return;
          }
          succeed({ location: resolved.href });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBodyBytes) {
            fail(new Error(`response body exceeds ${String(maxBodyBytes)} bytes`));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('aborted', () => {
          fail(new Error('response aborted before completion'));
        });
        res.on('error', (err) => {
          fail(err);
        });
        res.on('end', () => {
          const result: HttpResult = { data: Buffer.concat(chunks) };
          if (res.statusCode !== undefined) result.status = res.statusCode;
          succeed(result);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`));
    });
    req.on('error', (err) => {
      fail(err);
    });
  });
}
