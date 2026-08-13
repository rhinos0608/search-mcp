/**
 * Deterministic registry build, validation, rendering, checksum verification,
 * and atomic write. The generator pipeline is: verify SHA-256 of each input →
 * build → validate → render → atomic write. Validation happens strictly before
 * any output is written, so a failed build/validation never leaves partial or
 * stale generated files. The registry renders to a single generated file, so
 * publish is a single-file write-temp-then-rename — there is no multi-file
 * interleaving window to reason about.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { parseCisaFacts } from './cisa.js';
import { parseRorFacts } from './ror.js';
import { isInstitutionalRorTypes, INSTITUTIONAL_ROR_TYPES } from './types.js';
import type {
  CisaFact,
  CisaRow,
  DomainFactsRegistry,
  RegistryProvenance,
  RorFact,
  RorRow,
  SourcePin,
} from './types.js';
import { normalizeDomain } from './normalize.js';

export const REGISTRY_VERSION = '1';

/** Name of the single generated registry file published into `src/domainFacts/`. */
export const REGISTRY_FILE_NAME = 'registry.generated.ts';

export interface SourceInputs {
  cisaCsv: string;
  rorJson: string;
}

/** Locale-independent UTF-16 code-unit string ordering (deterministic across environments). */
function compareStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Build the deterministic in-memory registry from raw source text inputs. */
export function buildRegistry(
  inputs: SourceInputs,
  pins: readonly SourcePin[],
  registryVersion: string = REGISTRY_VERSION,
): DomainFactsRegistry {
  const cisa = parseCisaFacts(inputs.cisaCsv);
  const parsed = parseRorFacts(inputs.rorJson);

  // Deduplicate CISA facts by domain, keeping the first row per domain.
  const cisaByDomain = new Map<string, CisaFact>();
  for (const fact of cisa) {
    if (!cisaByDomain.has(fact.domain)) cisaByDomain.set(fact.domain, fact);
  }
  const cisaSorted = [...cisaByDomain.values()].sort((a, b) => compareStr(a.domain, b.domain));

  // A ROR domain may legitimately be claimed by more than one organization;
  // keep every distinct fact, deterministically ordered.
  const rorSorted = [...parsed.facts].sort(
    (a, b) =>
      compareStr(a.domain, b.domain) || compareStr(a.rorId, b.rorId) || compareStr(a.name, b.name),
  );
  const institutionalDomains = [...parsed.institutionalDomains].sort((a, b) => compareStr(a, b));

  return {
    registryVersion,
    provenance: {
      generatedBy: 'scripts/generate-domain-facts.ts',
      sources: [...pins],
    },
    cisa: cisaSorted,
    ror: rorSorted,
    institutionalDomains,
  };
}

/**
 * Validate structural + provenance invariants. Throws on any violation so the
 * generator exits nonzero before writing output.
 */
export function validateRegistry(reg: DomainFactsRegistry): void {
  if (reg.cisa.length === 0 && reg.ror.length === 0) {
    throw new Error('registry is empty (no CISA or ROR facts)');
  }
  for (const f of reg.cisa) {
    if (normalizeDomain(f.domain) !== f.domain) {
      throw new Error(`invalid CISA domain in registry: ${f.domain}`);
    }
  }
  for (const f of reg.ror) {
    if (normalizeDomain(f.domain) !== f.domain) {
      throw new Error(`invalid ROR domain in registry: ${f.domain}`);
    }
    if (f.rorId.length === 0) {
      throw new Error(`ROR fact missing rorId for domain: ${f.domain}`);
    }
  }

  const rorDomains = new Set(reg.ror.map((f) => f.domain));
  const inst = new Set(reg.institutionalDomains);
  for (const d of reg.institutionalDomains) {
    if (!rorDomains.has(d)) {
      throw new Error(`institutional domain ${d} missing from ROR facts`);
    }
  }
  // Every ROR fact whose types qualify must be promoted, and vice versa.
  for (const f of reg.ror) {
    if (isInstitutionalRorTypes(f.types) && !inst.has(f.domain)) {
      throw new Error(`ROR education domain ${f.domain} missing from institutionalDomains`);
    }
  }
  for (const d of inst) {
    if (!reg.ror.some((f) => f.domain === d && isInstitutionalRorTypes(f.types))) {
      throw new Error(`institutional domain ${d} has no qualifying ROR fact`);
    }
  }
}

function tsStr(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

function provenanceTs(prov: RegistryProvenance): string {
  const lines = prov.sources.map((s: SourcePin) => {
    return `    { id: ${tsStr(s.id)}, name: ${tsStr(s.name)}, url: ${tsStr(s.url)}, version: ${tsStr(s.version)}, sha256: ${tsStr(s.sha256)}, license: ${tsStr(s.license)}, retrievedAt: ${tsStr(s.retrievedAt)} },`;
  });
  return `export const PROVENANCE: RegistryProvenance = {\n  generatedBy: ${tsStr(prov.generatedBy)},\n  sources: [\n${lines.join('\n')}\n  ],\n};`;
}

const GENERATED_HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated deterministically by scripts/generate-domain-facts.ts from
 * SHA-256-pinned source inputs. Regenerate with:
 *   npx tsx scripts/generate-domain-facts.ts
 * Provenance and licensing: docs/domain-facts-registry.md
 */
`;

/**
 * Render the registry to a single deterministic generated TypeScript module
 * containing PROVENANCE, REGISTRY_VERSION, CISA_ROWS, ROR_ROWS, and
 * INSTITUTIONAL_DOMAINS. One module means one publish target — there is no
 * multi-file window where a reader could observe one dataset updated and
 * another stale.
 */
export function renderRegistry(reg: DomainFactsRegistry): string {
  const cisaRows: string[] = reg.cisa.map((f: CisaFact) => {
    return `  [${tsStr(f.domain)}, ${tsStr(f.type)}, ${tsStr(f.org)}, ${tsStr(f.suborg)}],`;
  });
  const rorRows: string[] = reg.ror.map((f: RorFact) => {
    const types = f.types.map((t) => tsStr(t)).join(', ');
    return `  [${tsStr(f.domain)}, ${tsStr(f.rorId)}, ${tsStr(f.name)}, [${types}]],`;
  });
  const institutionalDomains: string[] = reg.institutionalDomains.map((d) => `  ${tsStr(d)},`);

  return [
    GENERATED_HEADER,
    `import type { RegistryProvenance } from './types.js';\n`,
    `export const REGISTRY_VERSION = ${tsStr(reg.registryVersion)};\n`,
    `${provenanceTs(reg.provenance)}\n`,
    `export const CISA_ROWS: ReadonlyArray<readonly [string, string, string, string]> = [\n${cisaRows.join('\n')}\n];\n`,
    `export const ROR_ROWS: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [\n${rorRows.join('\n')}\n];\n`,
    `export const INSTITUTIONAL_DOMAINS: readonly string[] = [\n${institutionalDomains.join('\n')}\n];\n`,
  ].join('\n');
}

/** Verify a buffer matches the expected SHA-256 hex. Throws on mismatch. */
export function verifySha256(buffer: Buffer, expectedSha256: string): void {
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

/**
 * Filesystem primitives used by `writeGeneratedFileAtomic`, injectable so
 * tests can force a write/fsync/rename step to fail and observe that the
 * previously published file is left untouched.
 */
export interface AtomicFsOps {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  existsSync: typeof existsSync;
}

const defaultFsOps: AtomicFsOps = {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  existsSync,
};

/**
 * Best-effort directory-entry durability: fsync the containing directory so
 * the rename that publishes the new file is flushed to the directory's
 * on-disk entry, not just the file's own data. This is unsupported (throws
 * EPERM/EISDIR/ENOSYS) on some platforms — most notably Windows — and is
 * always skipped there rather than failing the publish.
 */
function fsyncDirBestEffort(dirPath: string, ops: AtomicFsOps): void {
  let fd: number | undefined;
  try {
    fd = ops.openSync(dirPath, 'r');
    ops.fsyncSync(fd);
  } catch {
    /* directory fsync unsupported on this platform/filesystem; best effort only */
  } finally {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        /* ignore close errors during best-effort fsync */
      }
    }
  }
}

/**
 * Publish the single generated registry file with same-filesystem
 * write-temp-then-rename atomicity:
 *
 *   1. Write the full content to a temp file in the same directory.
 *   2. fsync the temp file's data to disk before making it visible.
 *   3. `rename(2)` the temp file onto the final path.
 *   4. Best-effort fsync of the containing directory so the rename is
 *      durable, not just visible.
 *
 * Guarantee (exact, not aspirational): POSIX `rename(2)` on the same
 * filesystem is atomic with respect to *concurrent readers* — a reader
 * opening the final path at any point observes either the complete old
 * bytes or the complete new bytes, never a mix, and no reader ever observes
 * a from-scratch-truncated or partially-written file, because the rename
 * only ever points the directory entry at a fully-written temp file. This
 * holds whenever `outDir` and its temp file are on the same mounted
 * filesystem, which is always true here since both live under `outDir`.
 *
 * What this does NOT guarantee: durability across a hard crash or power
 * loss between the temp-file fsync and the rename, or between the rename
 * and the best-effort directory fsync — journaling filesystems typically
 * preserve the rename across a crash once it has been issued, but this is a
 * filesystem/mount-option property (e.g. `data=ordered` vs `data=writeback`
 * on ext4), not one this function can enforce from userspace, and the
 * directory fsync itself is skipped outright on platforms that reject it
 * (Windows). Treat this as: readers never see mixed/partial state; crash
 * durability is best-effort, not guaranteed on every filesystem.
 *
 * Any error before the rename (temp write or temp fsync) or during the
 * rename itself leaves the previously published final file completely
 * untouched — the function never modifies the final path except via the one
 * rename call — and always removes the temp file it created before
 * rethrowing.
 */
export function writeGeneratedFileAtomic(
  outDir: string,
  fileName: string,
  content: string,
  ops: AtomicFsOps = defaultFsOps,
): string {
  mkdirSync(outDir, { recursive: true });
  const final = join(outDir, fileName);
  const tmp = join(
    outDir,
    `${fileName}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    const fd = ops.openSync(tmp, 'w');
    try {
      const buf = Buffer.from(content, 'utf8');
      let offset = 0;
      while (offset < buf.length) {
        const n = ops.writeSync(fd, buf, offset, buf.length - offset);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `writeSync made no progress at byte ${String(offset)}/${String(buf.length)} (returned ${String(n)})`,
          );
        }
        offset += n;
      }
      ops.fsyncSync(fd);
    } finally {
      ops.closeSync(fd);
    }
    ops.renameSync(tmp, final);
  } catch (err) {
    try {
      ops.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }

  fsyncDirBestEffort(outDir, ops);
  return final;
}

/** Read a generated file's current content for checks/diffing. */
export function readGeneratedFile(outDir: string, name: string): string | null {
  try {
    return readFileSync(join(outDir, name), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Find stale `*.generated.ts` artifacts in a directory listing: files that
 * end in `.generated.ts` but are neither the current registry file nor a
 * known non-generated support module. Other directory entries (tool
 * metadata, caches, non-`.generated.ts` files) are never flagged.
 */
export function findObsoleteGeneratedFiles(
  dirEntries: readonly string[],
  registryFileName: string,
  knownNonGeneratedFiles: ReadonlySet<string>,
): string[] {
  return dirEntries.filter(
    (name) =>
      name !== registryFileName &&
      name.endsWith('.generated.ts') &&
      !knownNonGeneratedFiles.has(name),
  );
}

/** Re-export for callers that need the gated type set. */
export { INSTITUTIONAL_ROR_TYPES };

/** Reconstruct an in-memory registry from generated row arrays (for validation/checks). */
export function registryFromRows(params: {
  registryVersion: string;
  provenance: RegistryProvenance;
  cisaRows: readonly CisaRow[];
  rorRows: readonly RorRow[];
  institutionalDomains: readonly string[];
}): DomainFactsRegistry {
  return {
    registryVersion: params.registryVersion,
    provenance: params.provenance,
    cisa: params.cisaRows.map((r) => ({ domain: r[0], type: r[1], org: r[2], suborg: r[3] })),
    ror: params.rorRows.map((r) => ({
      domain: r[0],
      rorId: r[1],
      name: r[2],
      types: r[3],
    })),
    institutionalDomains: [...params.institutionalDomains],
  };
}
