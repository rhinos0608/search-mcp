/**
 * Shared HTTP safety guards: SSRF protection and response size limiting.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '0.0.0.0',
  'metadata.google.internal',
]);

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets as [number, number, number, number];

  // 10.x.x.x
  if (a === 10) return true;
  // 172.16.x.x - 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.x.x
  if (a === 192 && b === 168) return true;
  // 169.254.x.x (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.x.x.x
  if (a === 0) return true;

  return false;
}

/**
 * Validate a URL is safe to fetch (not targeting internal networks).
 * Throws if the URL is blocked.
 */
export function assertSafeUrl(url: string): void {
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

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked request to internal host "${hostname}"`);
  }

  if (isPrivateIPv4(hostname)) {
    throw new Error(`Blocked request to private IP address "${hostname}"`);
  }

  // Block IPv6 private ranges (::1, fe80::, fc00::, fd00::)
  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1);
    if (
      inner === '::1' ||
      inner.startsWith('fe80') ||
      inner.startsWith('fc00') ||
      inner.startsWith('fd00')
    ) {
      throw new Error(`Blocked request to private IPv6 address "${hostname}"`);
    }
  }
}

/** Maximum response body size in bytes (10 MB). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read the response body as text, enforcing a size limit.
 * Throws if the response exceeds MAX_RESPONSE_BYTES.
 */
export async function safeResponseText(response: Response, url: string): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response from "${url}" is too large (${String(len)} bytes, max ${String(MAX_RESPONSE_BYTES)})`,
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
    if (totalBytes > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {
        /* discard */
      });
      throw new Error(
        `Response from "${url}" exceeded size limit (>${String(MAX_RESPONSE_BYTES)} bytes)`,
      );
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
export async function safeResponseJson(response: Response, url: string): Promise<unknown> {
  const text = await safeResponseText(response, url);
  return JSON.parse(text) as unknown;
}

/** Standard truncation marker used across all tools. */
export const TRUNCATED_MARKER = '... [truncated]';
