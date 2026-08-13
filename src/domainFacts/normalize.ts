/**
 * Deterministic domain normalization + validation for the domain-facts
 * registry and its lookup.
 *
 * Normalizes to a canonical registrable-domain form: lowercase, `www.` and
 * trailing-dot stripped, IDNs punycoded (`domainToASCII`), URLs reduced to
 * their hostname. Rejects invalid domains, IP addresses, ports, paths,
 * wildcards, bare TLDs and PSL-like second-level entries so generation never
 * ships a false-positive host.
 */

import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

const MAX_LABEL_LENGTH = 63;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Common public-suffix-like second-level entries. A registrable domain must
 * have at least two labels, but two labels are not enough when the pair is
 * itself a public suffix (e.g. `co.uk`). Rejecting these keeps generation and
 * matching free of PSL false positives. This is intentionally a focused list
 * (not the full PSL) — enough to block the common false-positive classes.
 */
const PSL_LIKE_ENTRIES: ReadonlySet<string> = new Set([
  // UK
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'nhs.uk',
  'mod.uk',
  'sch.uk',
  'ltd.uk',
  'plc.uk',
  // AU / NZ
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'ac.nz',
  // JP / KR
  'co.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'ac.kr',
  'go.kr',
  're.kr',
  // IN / BR / ZA / CN / MX / AR / TR
  'co.in',
  'org.in',
  'gen.in',
  'firm.in',
  'net.in',
  'edu.in',
  'res.in',
  'ac.in',
  'gov.in',
  'com.br',
  'net.br',
  'org.br',
  'edu.br',
  'gov.br',
  'co.za',
  'org.za',
  'ac.za',
  'gov.za',
  'net.za',
  'com.cn',
  'net.cn',
  'org.cn',
  'edu.cn',
  'gov.cn',
  'com.mx',
  'org.mx',
  'gob.mx',
  'edu.mx',
  'com.ar',
  'org.ar',
  'edu.ar',
  'gob.ar',
  'com.tr',
  'org.tr',
  'edu.tr',
  'gov.tr',
  // Bare TLDs (single-label entries handled separately; these guard 2-label TLDs)
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'dev',
  'info',
  'co',
  'ac',
  'eu',
  'uk',
  'us',
  'app',
  'ai',
]);

/**
 * Normalize an arbitrary host/URL/domain to a canonical registrable-domain
 * string, or return null when it is invalid.
 *
 * Accepts bare hosts, `www.`-prefixed hosts, child hosts, full URLs, and IDNs.
 * Returns a lowercase ASCII (punycoded) domain with `www.` and trailing dot
 * removed. Never returns a bare TLD or a PSL-like second-level entry.
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  let raw = trimmed;
  if (raw.includes('://')) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      return null;
    }
  } else {
    raw = raw.replace(/\/+$/u, '');
    if (/[/?#]/u.test(raw)) return null; // path, query, fragment
  }

  if (raw.includes(':') || raw.includes('*') || raw.includes('[') || raw.includes(']')) {
    return null; // port, IPv6, wildcard
  }

  raw = raw.replace(/^www\./u, '').replace(/\.+$/u, '');
  if (raw.length === 0) return null;

  let ascii: string;
  try {
    const converted = domainToASCII(raw);
    if (converted.length === 0) return null;
    ascii = converted.toLowerCase();
  } catch {
    return null;
  }

  if (isIP(ascii) !== 0) return null; // reject IPv4 / IPv6 literals
  if (PSL_LIKE_ENTRIES.has(ascii)) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null; // must be registrable
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    if (!LABEL_RE.test(label)) return null;
  }
  return ascii;
}
