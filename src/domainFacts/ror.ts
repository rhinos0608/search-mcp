/**
 * Parse ROR data-dump JSON (schema v2.1) into ROR facts.
 *
 * Only `active` records are emitted. Semantics: a fact means "this organization
 * is registered in ROR with these identity types", never reputation or truth.
 *
 * Type gating (which types qualify for the institutional 0.70 prior) is applied
 * via `isInstitutionalRorTypes` in `types.ts`; non-qualifying organizations
 * still appear as facts but are excluded from `institutionalDomains`.
 */

import { normalizeDomain } from './normalize.js';
import { isInstitutionalRorTypes } from './types.js';
import type { RorFact } from './types.js';

interface RorName {
  value?: string;
  types?: string[];
  lang?: string | null;
}

interface RorRecord {
  id?: string;
  status?: string;
  domains?: string[];
  types?: string[];
  names?: RorName[];
}

/**
 * Pick the organization's display name per ROR schema v2.1: the name whose
 * `types` includes `ror_display` (exactly one is required by the schema),
 * falling back to `label`, then the first nonempty value.
 */
function pickName(names: RorName[] | undefined): string {
  const list = (names ?? []).filter(
    (n) => typeof n.value === 'string' && n.value.trim().length > 0,
  );
  const display = list.find((n) => (n.types ?? []).includes('ror_display'));
  if (display) return (display.value ?? '').trim();
  const label = list.find((n) => (n.types ?? []).includes('label'));
  if (label) return (label.value ?? '').trim();
  return (list[0]?.value ?? '').trim();
}

export interface RorParseResult {
  facts: RorFact[];
  institutionalDomains: string[];
}

/**
 * Parse ROR data-dump JSON text (array of records) into ROR facts.
 *
 * Structural invariants required of every `active` record — nonempty `id`,
 * nonempty `types`, a resolvable name, and a `domains` array — are enforced
 * strictly and throw on violation, since a malformed active record indicates
 * a source/schema problem rather than an ordinary per-domain data issue. An
 * individual invalid domain string within an otherwise well-formed record is
 * skipped rather than fatal.
 */
export function parseRorFacts(jsonText: string): RorParseResult {
  const records = JSON.parse(jsonText) as RorRecord[];
  if (!Array.isArray(records)) {
    throw new Error('ROR data dump must be a JSON array of records');
  }

  const facts: RorFact[] = [];
  const institutional = new Set<string>();

  for (const rec of records) {
    if (rec.status !== 'active') continue;

    const id = (rec.id ?? '').trim();
    if (id.length === 0) {
      throw new Error('active ROR record missing id');
    }
    const types = (rec.types ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (types.length === 0) {
      throw new Error(`active ROR record ${id} has no types`);
    }
    const name = pickName(rec.names);
    if (name.length === 0) {
      throw new Error(`active ROR record ${id} has no resolvable name`);
    }
    if (!Array.isArray(rec.domains)) {
      throw new Error(`active ROR record ${id} missing domains array`);
    }

    for (const raw of rec.domains) {
      const domain = normalizeDomain(raw);
      if (domain === null) continue;
      facts.push({ domain, rorId: id, name, types });
      if (isInstitutionalRorTypes(types)) institutional.add(domain);
    }
  }

  return { facts, institutionalDomains: [...institutional] };
}
