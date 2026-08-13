#!/usr/bin/env node
/**
 * Check that the committed domain-facts registry is in sync with the pinned
 * source inputs. Re-derives the registry from cached (or downloaded) sources
 * and diffs the rendered output against the committed generated files.
 *
 * Usage:
 *   npx tsx scripts/check-domain-facts.ts
 *   npx tsx scripts/check-domain-facts.ts --skip-download   # use cache only
 *
 * Exits nonzero on: SHA-256 mismatch, build/validation failure, or any diff
 * against the committed generated files.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRegistry,
  validateRegistry,
  renderRegistry,
  verifySha256,
  REGISTRY_FILE_NAME,
  findObsoleteGeneratedFiles,
} from '../src/domainFacts/build.js';
import { readJsonFromRorZip } from '../src/domainFacts/zip.js';
import { SOURCE_PINS, defaultCacheDir } from '../src/domainFacts/sources.js';
import type { SourcePin } from '../src/domainFacts/types.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(REPO_ROOT, 'src', 'domainFacts');

/**
 * Non-generated support modules that legitimately live alongside
 * `registry.generated.ts` in `src/domainFacts/`. Any other `*.generated.ts`
 * file found there is a stale artifact from a prior renderer shape (e.g. the
 * old `institutional.generated.ts` split file) and should be deleted.
 */
const KNOWN_NON_GENERATED_FILES = new Set([
  'build.ts',
  'cisa.ts',
  'csv.ts',
  'lookup.ts',
  'normalize.ts',
  'ror.ts',
  'sources.ts',
  'types.ts',
  'zip.ts',
]);

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function cachedOrThrow(pin: SourcePin, cacheDir: string): Buffer {
  const filePath = join(cacheDir, pin.id);
  if (!existsSync(filePath)) {
    throw new Error(
      `source ${pin.id} not cached at ${filePath}; run generate-domain-facts.ts first`,
    );
  }
  const buf = readFileSync(filePath);
  verifySha256(buf, pin.sha256);
  return buf;
}

function main(): number {
  const cacheDir = argValue('--cache-dir') ?? defaultCacheDir();
  const skipDownload = hasFlag('--skip-download');
  if (!skipDownload) {
    process.stderr.write(
      '[domain-facts] check uses cached inputs; pass --skip-download not needed (no auto-download)\n',
    );
  }

  const cisaBuf = cachedOrThrow(SOURCE_PINS[0] as SourcePin, cacheDir);
  const rorZipBuf = cachedOrThrow(SOURCE_PINS[1] as SourcePin, cacheDir);

  const registry = buildRegistry(
    { cisaCsv: cisaBuf.toString('utf8'), rorJson: readJsonFromRorZip(rorZipBuf).toString('utf8') },
    SOURCE_PINS,
  );
  validateRegistry(registry);
  const rendered = renderRegistry(registry);

  let ok = true;
  const committed = readFileSync(join(OUT_DIR, REGISTRY_FILE_NAME), 'utf8');
  if (committed !== rendered) {
    process.stderr.write(
      `[domain-facts] MISMATCH: ${REGISTRY_FILE_NAME} differs from source-derived output\n`,
    );
    ok = false;
  }

  const extras = findObsoleteGeneratedFiles(
    readdirSync(OUT_DIR),
    REGISTRY_FILE_NAME,
    KNOWN_NON_GENERATED_FILES,
  );
  if (extras.length > 0) {
    process.stderr.write(
      `[domain-facts] OBSOLETE ARTIFACT: unexpected file(s) in ${OUT_DIR}: ${extras.join(', ')} — remove, they are not part of the single generated module\n`,
    );
    ok = false;
  }

  if (!ok) {
    process.stderr.write(
      '[domain-facts] registry is OUT OF SYNC — regenerate with generate-domain-facts.ts\n',
    );
    return 1;
  }
  process.stderr.write('[domain-facts] registry is in sync with pinned sources\n');
  return 0;
}

let code: number;
try {
  code = main();
} catch (err: unknown) {
  process.stderr.write(
    `[domain-facts] check failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  code = 1;
}
process.exitCode = code;
