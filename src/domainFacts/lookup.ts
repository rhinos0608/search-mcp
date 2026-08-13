/**
 * Fast institutional-domain lookup used by the source-credibility tier.
 *
 * A domain matches when it equals a registered institutional domain or is a
 * controlled child host of one (`host === dom || host.endsWith('.' + dom)`).
 * The boundary dot guarantees no parent / sibling / suffix false positives
 * (`anl.gov.evil.com` never matches `anl.gov`).
 */

import { INSTITUTIONAL_DOMAINS } from './registry.generated.js';
import { normalizeDomain } from './normalize.js';

let cached: Set<string> | null = null;

function institutionalSet(): Set<string> {
  cached ??= new Set(INSTITUTIONAL_DOMAINS);
  return cached;
}

/**
 * Replace the institutional domain set. Test-only seam so focused tests can
 * prove manual-rule precedence without touching real source data.
 */
export function _setInstitutionalDomainsForTest(domains: readonly string[]): void {
  cached = new Set(domains);
}

/** True when `input` is a registered institutional domain or a child host of one. */
export function isInstitutionalHost(input: string): boolean {
  const host = normalizeDomain(input);
  if (host === null) return false;
  const set = institutionalSet();
  const labels = host.split('.');
  // Walk suffixes down to the two-label registrable form.
  for (let i = 0; i <= labels.length - 2; i += 1) {
    if (set.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
