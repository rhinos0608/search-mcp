#!/usr/bin/env node
/**
 * Regenerate the domain-facts registry from pinned source inputs.
 *
 * Pipeline (each step gates the next; failures exit nonzero and write nothing):
 *   1. Resolve each source input — reuse cached bytes or download (HTTPS only).
 *   2. Verify SHA-256 against the pinned value in src/domainFacts/sources.ts.
 *   3. Parse → build → validate the registry.
 *   4. Render generated TypeScript and atomically write into src/domainFacts/.
 *
 * Usage:
 *   npx tsx scripts/generate-domain-facts.ts
 *   npx tsx scripts/generate-domain-facts.ts --skip-download --cache-dir /path
 *
 * Source content is untrusted data: parsed, never executed.
 */
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRegistry,
  validateRegistry,
  renderRegistry,
  verifySha256,
  writeGeneratedFileAtomic,
  REGISTRY_FILE_NAME,
} from '../src/domainFacts/build.js';
import { readJsonFromRorZip } from '../src/domainFacts/zip.js';
import { httpsGet } from '../src/domainFacts/httpsGet.js';
import { SOURCE_PINS, defaultCacheDir } from '../src/domainFacts/sources.js';
import type { SourcePin } from '../src/domainFacts/types.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(REPO_ROOT, 'src', 'domainFacts');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function download(url: string, maxRedirects = 5): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await httpsGet(current);
    if (res.location) {
      current = res.location;
      continue;
    }
    if (res.status === 200 && res.data) return res.data;
    throw new Error(`download failed (HTTP ${res.status ?? 'unknown'}) for ${current}`);
  }
  throw new Error(`too many redirects for ${url}`);
}

/** Resolve a source input from cache (verifying SHA) or download it. */
async function resolveSource(
  pin: SourcePin,
  cacheDir: string,
  allowDownload: boolean,
): Promise<Buffer> {
  const filePath = join(cacheDir, pin.id);
  if (existsSync(filePath)) {
    const buf = readFileSync(filePath);
    verifySha256(buf, pin.sha256);
    process.stderr.write(`[domain-facts] using cached ${pin.id} (sha256 OK)\n`);
    return buf;
  }
  if (!allowDownload) {
    throw new Error(`source ${pin.id} not cached at ${filePath} (re-run without --skip-download)`);
  }
  process.stderr.write(`[domain-facts] downloading ${pin.url}\n`);
  const buf = await download(pin.url);
  verifySha256(buf, pin.sha256);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(filePath, buf);
  return buf;
}

async function main(): Promise<number> {
  const cacheDir = argValue('--cache-dir') ?? defaultCacheDir();
  const skipDownload = hasFlag('--skip-download');

  const cisaBuf = await resolveSource(SOURCE_PINS[0] as SourcePin, cacheDir, !skipDownload);
  const rorZipBuf = await resolveSource(SOURCE_PINS[1] as SourcePin, cacheDir, !skipDownload);

  const cisaCsv = cisaBuf.toString('utf8');
  const rorJson = readJsonFromRorZip(rorZipBuf).toString('utf8');

  const registry = buildRegistry({ cisaCsv, rorJson }, SOURCE_PINS);
  validateRegistry(registry); // throws before any output on failure
  const rendered = renderRegistry(registry);
  const written = writeGeneratedFileAtomic(OUT_DIR, REGISTRY_FILE_NAME, rendered);
  process.stderr.write(`[domain-facts] wrote ${written.split('/').pop() ?? written}\n`);
  process.stderr.write(
    `[domain-facts] cisa=${registry.cisa.length} ror=${registry.ror.length} institutional=${registry.institutionalDomains.length}\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `[domain-facts] generation failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
