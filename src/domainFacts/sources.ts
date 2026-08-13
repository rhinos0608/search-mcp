/**
 * Pinned source-input manifest for the domain-facts registry.
 *
 * Each entry describes one authoritative source input. Inputs are downloaded
 * (HTTPS only) to a local cache directory and verified by SHA-256 before use.
 * A mutable URL alone is never a version pin — `version` plus `sha256` pin the
 * exact bytes. Treat all source content as untrusted data; it is parsed, never
 * executed.
 */

import { join } from 'node:path';

import type { SourcePin } from './types.js';

export const GENERATED_BY = 'scripts/generate-domain-facts.ts';

export const SOURCE_PINS: readonly SourcePin[] = [
  {
    id: 'cisa-full',
    name: 'CISA dotgov-data current-full.csv',
    url: 'https://raw.githubusercontent.com/cisagov/dotgov-data/c44e0fa675a8875eb685e9bb84b5a68e4f8e0f42/current-full.csv',
    version:
      'commit c44e0fa675a8875eb685e9bb84b5a68e4f8e0f42 (2026-08-12, no release tags; pinned by immutable commit + SHA-256)',
    sha256: '335ff0a8c829d495444c1211673a2f9d8da0793fcb2349d1034773d221e27e1f',
    license: 'CC0-1.0',
    retrievedAt: '2026-08-12',
  },
  {
    id: 'ror',
    name: 'ROR data dump v2.7 (Zenodo record 20140273)',
    url: 'https://zenodo.org/records/20140273/files/v2.7-2026-05-12-ror-data.zip',
    version: 'v2.7-2026-05-12',
    sha256: '4acfbaeab99539c5d616d3a90fe8854f092fe28d4b982a69cb1f2b576aba86a8',
    license: 'CC0-1.0 (location data: GeoNames CC-BY-4.0)',
    retrievedAt: '2026-08-12',
  },
];

/**
 * Default local cache directory for source inputs. Overridable via the
 * `DOMAIN_FACTS_CACHE_DIR` env var or `--cache-dir` flag. Sources are pinned
 * by SHA-256, so the location is not part of the provenance contract.
 */
export function defaultCacheDir(): string {
  if (process.env.DOMAIN_FACTS_CACHE_DIR) {
    return process.env.DOMAIN_FACTS_CACHE_DIR;
  }
  const base = process.env.HOME ?? process.cwd();
  return join(base, '.cache', 'search-mcp', 'domain-facts');
}
