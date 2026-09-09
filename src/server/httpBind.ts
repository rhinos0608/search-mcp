/**
 * Resolve the HTTP listen address for the MCP server.
 *
 * Secure default: bind to loopback only. External exposure requires an
 * explicit `HTTP_HOST` opt-in (`0.0.0.0`, `::`, or a specific interface IP).
 * Hostnames are rejected — only literal IP addresses are accepted, so the
 * operator's intent (loopback vs network) is unambiguous.
 */

import net from 'node:net';

export type HttpExposure = 'loopback' | 'network';

export interface HttpListenTarget {
  host: string;
  exposure: HttpExposure;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/** Parse `HTTP_HOST` (or any bind input) into a listen target. Throws on invalid input. */
export function resolveHttpListenHost(raw: string | undefined): HttpListenTarget {
  const value = (raw ?? '').trim();

  if (value === '') {
    return { host: '127.0.0.1', exposure: 'loopback' };
  }

  const normalized = value.toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) {
    // `[::1]` must be unbracketed for node:server.listen
    const host = normalized === '[::1]' ? '::1' : normalized;
    return { host, exposure: 'loopback' };
  }

  if (WILDCARD_HOSTS.has(normalized)) {
    const host = normalized === '[::]' ? '::' : normalized;
    return { host, exposure: 'network' };
  }

  if (net.isIP(value) === 4 || net.isIP(value) === 6) {
    return { host: value, exposure: 'network' };
  }

  throw new Error(
    `Invalid HTTP_HOST "${value}" — must be an IP address: ` +
      'loopback (127.0.0.1, ::1, localhost), wildcard (0.0.0.0, ::), or a specific interface IP',
  );
}
