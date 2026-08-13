/**
 * Parse CISA dotgov-data `current-full.csv` into CISA facts.
 *
 * `current-full.csv` covers every registered `.gov` domain type (federal,
 * state/territory, county, city, tribal, school district, special district,
 * interstate, and their election-office variants) — not federal only.
 *
 * Semantics: a fact means "this domain is registered to a US government
 * organization" (ownership), never that content is true.
 */

import { normalizeDomain } from './normalize.js';
import { parseCsv } from './csv.js';
import type { CisaFact } from './types.js';

const HEADERS = {
  domain: 'Domain name',
  type: 'Domain type',
  org: 'Organization name',
  suborg: 'Suborganization name',
} as const;

/** Parse CISA CSV text into sorted-unique CisaFacts (invalid rows dropped). */
export function parseCisaFacts(csvText: string): CisaFact[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const header = rows[0] ?? [];
  const dIdx = header.indexOf(HEADERS.domain);
  const tIdx = header.indexOf(HEADERS.type);
  const oIdx = header.indexOf(HEADERS.org);
  const sIdx = header.indexOf(HEADERS.suborg);
  if (dIdx < 0 || tIdx < 0 || oIdx < 0 || sIdx < 0) {
    throw new Error(
      `CISA CSV header missing required column(s); expected "${HEADERS.domain}", "${HEADERS.type}", "${HEADERS.org}", "${HEADERS.suborg}"`,
    );
  }

  const facts: CisaFact[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const rawDomain = row[dIdx] ?? '';
    const domain = normalizeDomain(rawDomain);
    if (domain === null) continue;
    facts.push({
      domain,
      type: (row[tIdx] ?? '').trim(),
      org: (row[oIdx] ?? '').trim(),
      suborg: (row[sIdx] ?? '').trim(),
    });
  }
  return facts;
}
