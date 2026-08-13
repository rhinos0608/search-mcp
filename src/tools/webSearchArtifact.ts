/**
 * Overflow artifact + response assembly for `web_search`.
 *
 * The bounded inline preview (192 KiB) is never the whole story when a query
 * returns more usable candidates than the requested `limit` or when the inline
 * byte/prose caps trim content. In those cases the full, sanitized/neutralized
 * Markdown for the available headroom is written to a private per-invocation
 * artifact file that an agent can read. The returned Markdown carries only a
 * short, bounded notice line with the absolute artifact path.
 *
 * Security posture:
 *  - Filenames are random UUIDs only; query/title/URL/content never enter a
 *    filename. Hostile content therefore cannot influence the artifact path.
 *  - The artifact directory is forced to mode 0700 (even when it pre-existed
 *    permissive) and a symlinked / non-directory base is rejected (fail closed).
 *    Files are written 0600 via a same-directory temp file that is atomically
 *    renamed, and the final file is verified to be a regular non-symlink 0600.
 *  - The artifact holds only the same scrubbed + formatter-cleaned/citation-safe
 *    representation the inline preview uses (never a raw provider response).
 *  - TTL (24h) and bounded file count/bytes keep disk growth bounded; the count
 *    and bytes are rechecked after eviction so a failed unlink can never bypass
 *    the cap. On any failure the inline preview is preserved and a generic
 *    notice is emitted.
 *  - No content or artifact path/ID is ever logged.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SearchResult } from '../types.js';
import type { AiSummaryMode } from './webSearch.js';
import {
  formatWebSearchMarkdownDetailed,
  DEFAULT_TOTAL_BUDGET_BYTES,
  type MarkdownFormatOptions,
} from './webSearchResultFormatter.js';

/** Hard cap for a single overflow artifact (1 MiB). */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;
/** Default artifact lifetime before cleanup (24 hours). */
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
/** Default max number of artifact files kept. */
export const ARTIFACT_MAX_FILES = 200;
/** Default max total bytes across artifact files (64 MiB). */
export const ARTIFACT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Minimal stats shape used by the artifact filesystem seam. */
export interface ArtifactStats {
  size: number;
  mtimeMs: number;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

/** Injectable filesystem seam so tests avoid destabilizing module-level mocks. */
export interface ArtifactFs {
  mkdirSync(dir: string, opts: { recursive: boolean; mode?: number }): void;
  /** Non-following stat, used to detect symlinks on the base dir / files. */
  lstatSync(p: string): ArtifactStats;
  chmodSync(p: string, mode: number): void;
  writeFileSync(p: string, data: string | Buffer, opts?: { mode?: number; flag?: string }): void;
  renameSync(from: string, to: string): void;
  readdirSync(dir: string): string[];
  unlinkSync(p: string): void;
}

const defaultFs: ArtifactFs = {
  mkdirSync: (dir, opts) => {
    fs.mkdirSync(dir, opts);
  },
  lstatSync: (p) => fs.lstatSync(p),
  chmodSync: (p, mode) => {
    fs.chmodSync(p, mode);
  },
  writeFileSync: (p, data, opts) => {
    fs.writeFileSync(p, data, opts);
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
  readdirSync: (dir) => fs.readdirSync(dir),
  unlinkSync: (p) => {
    fs.unlinkSync(p);
  },
};

export interface ArtifactWriteResult {
  /** Absolute path of the written artifact, or null when the write failed. */
  path: string | null;
  /** False when the content hit the hard byte cap and was truncated. */
  complete: boolean;
}

export interface ArtifactOptions {
  /** Override the artifact base directory (injectable for tests). */
  baseDir?: string;
  maxArtifactBytes?: number;
  ttlMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Injectable clock (ms since epoch) for TTL tests. */
  now?: number;
  /** Injectable filesystem seam for failure-path tests. */
  fs?: ArtifactFs;
}

/** Options for the standalone TTL/capacity sweep (no artifact write). */
export interface SweepOptions {
  baseDir?: string;
  ttlMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  now?: number;
  fs?: ArtifactFs;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Truncate a string to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8Safe(text: string, budgetBytes: number): string {
  if (utf8Length(text) <= budgetBytes) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > budgetBytes) break;
    bytes += b;
    out += ch;
  }
  return out;
}

/**
 * Ensure the base directory exists and is a real, private directory. Returns
 * false (fail closed) when it cannot be created, is a symlink, or is not a
 * directory.
 */
function ensureBaseDir(fsx: ArtifactFs, baseDir: string): boolean {
  try {
    fsx.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  let baseStats: ArtifactStats;
  try {
    baseStats = fsx.lstatSync(baseDir);
  } catch {
    return false;
  }
  if (baseStats.isSymbolicLink() || !baseStats.isDirectory()) {
    return false; // fail closed on symlink / non-dir
  }
  try {
    fsx.chmodSync(baseDir, 0o700); // fix a pre-existing permissive mode
  } catch {
    return false;
  }
  return true;
}

/**
 * Drop expired artifacts first, then rescan the directory so capacity
 * reflects successful deletions. Evict live artifacts oldest-first only if
 * the refreshed state still exceeds `maxFiles` or `maxTotalBytes` (accounting
 * for `incomingBytes`). When `reserveCapacity` is true (the write path),
 * eviction stops at `count < maxFiles` to leave headroom for the incoming
 * write; when false (the standalone sweep), eviction stops at
 * `count <= maxFiles` so exactly `maxFiles` live artifacts are kept.
 * Unlink failures leave files in place; callers that must not exceed capacity
 * recheck afterwards.
 */
function evictToCapacity(
  fsx: ArtifactFs,
  baseDir: string,
  all: { name: string; size: number; mtimeMs: number }[],
  now: number,
  ttlMs: number,
  maxFiles: number,
  maxTotalBytes: number,
  incomingBytes: number,
  reserveCapacity = true,
): void {
  // 1. Unlink expired artifacts first so they don't inflate capacity.
  const expired = all.filter((e) => now - e.mtimeMs > ttlMs);
  let expiredDeleted = false;
  for (const e of expired) {
    try {
      fsx.unlinkSync(path.join(baseDir, e.name));
      expiredDeleted = true;
    } catch {
      // best-effort
    }
  }

  // 2. Rescan to get fresh live state after expired deletions (only when
  //    at least one expired file was actually unlinked).
  let live: { name: string; size: number; mtimeMs: number }[];
  if (expiredDeleted) {
    try {
      live = scanArtifacts(fsx, baseDir)
        .filter((e) => now - e.mtimeMs <= ttlMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
    } catch {
      return;
    }
  } else {
    live = all.filter((e) => now - e.mtimeMs <= ttlMs).sort((a, b) => a.mtimeMs - b.mtimeMs);
  }
  let count = live.length;
  let totalBytes = live.reduce((s, e) => s + e.size, 0);

  // 3. Evict live artifacts only if still over capacity.
  const countOk = reserveCapacity ? count < maxFiles : count <= maxFiles;
  const bytesOk = totalBytes + incomingBytes <= maxTotalBytes;
  if (countOk && bytesOk) return;

  for (const e of live) {
    if (reserveCapacity) {
      if (count < maxFiles && totalBytes + incomingBytes <= maxTotalBytes) break;
    } else {
      if (count <= maxFiles && totalBytes <= maxTotalBytes) break;
    }
    try {
      fsx.unlinkSync(path.join(baseDir, e.name));
      count -= 1;
      totalBytes -= e.size;
    } catch {
      // Unlink failed: leave in place; the final recheck refuses if over cap.
    }
  }
}

/**
 * Standalone TTL + capacity sweep: remove expired and over-capacity artifacts
 * even when no new artifact is written. Runs the same `scanArtifacts`-based
 * eviction the write path uses, so disk growth stays bounded independently of
 * `web_search` traffic.
 */
export function sweepArtifacts(options: SweepOptions = {}): void {
  const ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS;
  const maxFiles = options.maxFiles ?? ARTIFACT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? ARTIFACT_MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now();
  const fsx = options.fs ?? defaultFs;
  const baseDir = options.baseDir ?? defaultArtifactDir();
  if (!ensureBaseDir(fsx, baseDir)) return;
  let all: { name: string; size: number; mtimeMs: number }[];
  try {
    all = scanArtifacts(fsx, baseDir);
  } catch {
    return;
  }
  evictToCapacity(fsx, baseDir, all, now, ttlMs, maxFiles, maxTotalBytes, 0, false);
}

/** Interval between periodic artifact sweeps (1 hour). */
export const ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start a periodic artifact sweep (an immediate startup sweep plus a repeating
 * unref'd timer so it never keeps the process alive). Returns the timer so
 * callers can stop it on shutdown.
 */
export function startArtifactSweeper(options: SweepOptions = {}): NodeJS.Timeout {
  sweepArtifacts(options); // startup sweep
  const timer = setInterval(() => {
    sweepArtifacts(options);
  }, ARTIFACT_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

/** Default artifact directory: ~/.cache/search-mcp/web-search-artifacts. */
export function defaultArtifactDir(): string {
  return path.join(os.homedir(), '.cache', 'search-mcp', 'web-search-artifacts');
}

/**
 * Bounded headroom used to fetch beyond the requested `limit` so navigation-only
 * candidates can be dropped and replacements still reach the requested count.
 */
export function computeFetchLimit(limit: number): number {
  return Math.min(50, Math.max(1, Math.ceil(limit * 1.5)));
}

/**
 * Scan a base directory for real artifact files and clean up temp leftovers.
 *
 * Only real regular non-symlink `*.md` files count toward capacity; temp
 * `tmp-*.md` leftovers are deleted, and any unexpected / symlinked / non-file
 * entry is safely ignored (never followed, never counted).
 */
function scanArtifacts(
  fsx: ArtifactFs,
  baseDir: string,
): { name: string; size: number; mtimeMs: number }[] {
  const out: { name: string; size: number; mtimeMs: number }[] = [];
  for (const name of fsx.readdirSync(baseDir)) {
    const full = path.join(baseDir, name);
    if (name.startsWith('tmp-') && name.endsWith('.md')) {
      // Stale temp from a previously interrupted write: clean it up.
      try {
        fsx.unlinkSync(full);
      } catch {
        // best-effort
      }
      continue;
    }
    if (!name.endsWith('.md')) continue; // ignore unexpected entries safely
    let st: ArtifactStats;
    try {
      st = fsx.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue; // never count symlinks/dirs
    out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * Write the sanitized full-rendering Markdown to a private artifact file.
 *
 * Filename is a random UUID (hostile content cannot influence it). The base
 * directory is created 0700, and when it already existed it is re-`chmod`ed to
 * 0700 and must be a real (non-symlink) directory. The file is written 0600 via
 * a same-directory temp file that is atomically renamed, then verified to be a
 * regular non-symlink 0600 file. Capacity is rechecked after eviction so a
 * failed unlink cannot bypass the cap. Returns null path on any failure.
 */
export function writeWebSearchArtifact(
  content: string,
  options: ArtifactOptions = {},
): ArtifactWriteResult {
  const maxArtifactBytes = options.maxArtifactBytes ?? ARTIFACT_MAX_BYTES;
  const ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS;
  const maxFiles = options.maxFiles ?? ARTIFACT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? ARTIFACT_MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now();
  const fsx = options.fs ?? defaultFs;
  const baseDir = options.baseDir ?? defaultArtifactDir();

  // 1. Ensure the base directory exists and is a real, private directory.
  if (!ensureBaseDir(fsx, baseDir)) {
    return { path: null, complete: false };
  }

  const complete = utf8Length(content) <= maxArtifactBytes;
  const bounded = truncateUtf8Safe(content, maxArtifactBytes);
  const incoming = utf8Length(bounded);

  // 2. TTL + capacity: drop expired, then oldest-first until within bounds.
  let all: { name: string; size: number; mtimeMs: number }[];
  try {
    all = scanArtifacts(fsx, baseDir);
  } catch {
    return { path: null, complete: false };
  }
  evictToCapacity(fsx, baseDir, all, now, ttlMs, maxFiles, maxTotalBytes, incoming);

  // 3. FINAL RECHECK after any unlink failures: refuse if still over capacity.
  try {
    const remaining = scanArtifacts(fsx, baseDir);
    const stillCount = remaining.length;
    const stillBytes = remaining.reduce((s, e) => s + e.size, 0);
    if (stillCount >= maxFiles || stillBytes + incoming > maxTotalBytes) {
      return { path: null, complete: false };
    }
  } catch {
    return { path: null, complete: false };
  }

  // 4. Write via same-dir temp + atomic rename. The temp is created with the
  // exclusive flag `wx` (O_EXCL), so writeFileSync never follows an existing
  // entry — a leftover or hostile symlink fails with EEXIST rather than being
  // written through. No pre-delete/check is needed because exclusivity is
  // enforced atomically by the write itself. Stale `tmp-*.md` leftovers are
  // cleaned by `scanArtifacts`.
  const id = randomUUID();
  const finalPath = path.join(baseDir, `${id}.md`);
  const tmpPath = path.join(baseDir, `tmp-${id}.md`);
  try {
    fsx.writeFileSync(tmpPath, bounded, { mode: 0o600, flag: 'wx' });
    fsx.renameSync(tmpPath, finalPath);
    const finalStats = fsx.lstatSync(finalPath);
    if (finalStats.isSymbolicLink() || !finalStats.isFile()) {
      try {
        fsx.unlinkSync(finalPath);
      } catch {
        // ignore
      }
      return { path: null, complete: false };
    }
    if ((finalStats.mode & 0o777) !== 0o600) fsx.chmodSync(finalPath, 0o600);
  } catch {
    try {
      fsx.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return { path: null, complete: false };
  }
  return { path: finalPath, complete };
}

/** Escape a filesystem path so it renders as plain Markdown text. */
export function safePathText(p: string): string {
  return p.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

/** Short, bounded, additive notice line describing the overflow artifact. */
export function buildArtifactNotice(
  result: ArtifactWriteResult,
  shownCount: number,
  totalCount: number,
): string {
  if (result.path === null) {
    return '\n> Full results unavailable (overflow artifact write failed).';
  }
  const countPart =
    totalCount > shownCount
      ? ` Showing ${String(shownCount)} of ${String(totalCount)} results.`
      : ' Content truncated.';
  const status = result.complete ? '' : ' (truncated at the hard cap)';
  return `\n> ⚠${countPart} Full results: ${safePathText(result.path)}${status}`;
}

/** Short notice when the artifact write was suppressed (no path).
 * When truncation is true but shownCount equals totalCount, the preview
 * was truncated within the shown results — emit "Content truncated."
 * instead of the misleading "Showing N of N results.". */
function suppressedNotice(shownCount: number, totalCount: number, truncated: boolean): string {
  if (truncated && shownCount === totalCount) {
    return '\n> ⚠ Content truncated.';
  }
  return `\n> ⚠ Showing ${String(shownCount)} of ${String(totalCount)} results.`;
}

export interface AssembleWebSearchOptions {
  /** Requested result count shown in the inline preview. */
  limit: number;
  aiSummary?: AiSummaryMode;
  /** Total budget for the returned preview + notice (default 192 KiB). */
  totalBudgetBytes?: number;
  /**
   * Artifact handling, default true (write via the default writer).
   * - `false`: skip the artifact write entirely; emit only the
   *   `Showing N of M results` note with no path (for clients that cannot read
   *   local files).
   * - a function: use it as the artifact writer (injectable seam, e.g. tests).
   */
  writeArtifact?: boolean | ((content: string) => ArtifactWriteResult);
}

export interface AssembledWebSearch {
  /** Bounded Markdown including the artifact notice (when overflow occurred). */
  text: string;
  /** True when an overflow artifact was actually written (path non-null). */
  artifactWritten: boolean;
}

/** Build formatter options that only carry `aiSummary` when defined. */
function previewOptions(
  aiSummary: AiSummaryMode | undefined,
  extra: MarkdownFormatOptions,
): MarkdownFormatOptions {
  return {
    ...extra,
    ...(aiSummary !== undefined ? { aiSummary } : {}),
  };
}

/** Short generic notice used when the full path-bearing notice cannot fit. */
const GENERIC_ARTIFACT_NOTICE = '\n> Additional results saved to a private overflow artifact.';

/**
 * Assemble the final web_search Markdown.
 *
 * The first `limit` usable results form the bounded inline preview. When either
 * additional usable candidates exist beyond `limit` OR the inline byte/prose
 * caps truncated the preview, a complete artifact is written for the full
 * headroom and a short notice line is appended (reserving notice bytes so the
 * returned block stays within `totalBudgetBytes`).
 *
 * The artifact is considered `complete` only when both the writer did not
 * truncate AND the formatter's full render did not hit its own hard cap. When
 * the notice alone would exceed the total budget it falls back to a short
 * generic note (or is UTF-8-truncated) so the returned block never exceeds the
 * budget.
 */
export function assembleWebSearchResponse(
  usableResults: SearchResult[],
  options: AssembleWebSearchOptions,
): AssembledWebSearch {
  const totalBudget = options.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES;
  const limit = Math.max(1, options.limit);
  const previewResults = usableResults.slice(0, limit);

  const preview = formatWebSearchMarkdownDetailed(
    previewResults,
    previewOptions(options.aiSummary, {
      totalBudgetBytes: totalBudget,
      suppressTruncationNote: true,
    }),
  );
  const countOverflow = usableResults.length > limit;
  const hasOverflow = countOverflow || preview.truncated;
  if (!hasOverflow) {
    return { text: preview.text, artifactWritten: false };
  }

  const writeArtifact = options.writeArtifact ?? true;
  const suppress = typeof writeArtifact === 'boolean' ? !writeArtifact : false;

  // Suppressed: no artifact at all — only the bounded `Showing N of M` note.
  let artifact: ArtifactWriteResult | null = null;
  if (!suppress) {
    // Complete artifact: sanitized/neutralized Markdown for the full headroom,
    // without the inline byte/prose caps (bounded by the artifact hard cap).
    const fullResult = formatWebSearchMarkdownDetailed(
      usableResults,
      previewOptions(options.aiSummary, { full: true, suppressTruncationNote: true }),
    );
    const writer =
      typeof writeArtifact === 'function'
        ? writeArtifact
        : (content: string) => writeWebSearchArtifact(content);
    const res = writer(fullResult.text);
    // Combine writer + formatter truncation into the completeness the notice shows.
    const complete = res.complete && !fullResult.truncated;
    artifact = { path: res.path, complete };
  }

  // Build a notice that can never push the returned block past the total budget:
  // if the full path-bearing notice is too large, fall back to a short generic
  // note (UTF-8 safe), reserving its bytes for the preview.
  const shownCount = previewResults.length;
  const totalCount = usableResults.length;
  const fullNotice = suppress
    ? suppressedNotice(shownCount, totalCount, preview.truncated)
    : artifact !== null
      ? buildArtifactNotice(artifact, shownCount, totalCount)
      : '\n> Full results unavailable (overflow artifact write failed).';
  let notice = fullNotice;
  if (utf8Length(fullNotice) > totalBudget) {
    notice = truncateUtf8Safe(GENERIC_ARTIFACT_NOTICE, totalBudget);
  }
  const noticeBytes = utf8Length(notice);
  const previewBudget = Math.max(0, totalBudget - noticeBytes);
  const boundedPreview = formatWebSearchMarkdownDetailed(
    previewResults,
    previewOptions(options.aiSummary, {
      totalBudgetBytes: previewBudget,
      suppressTruncationNote: true,
    }),
  );
  let text = boundedPreview.text + notice;
  if (utf8Length(text) > totalBudget) {
    text = truncateUtf8Safe(text, totalBudget);
  }
  const artifactWritten = artifact !== null && artifact.path !== null;
  return { text, artifactWritten };
}
