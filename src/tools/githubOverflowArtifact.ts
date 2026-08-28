/**
 * Thin wrapper over `writeWebSearchArtifact` that writes GitHub overflow
 * content to a separate directory (`~/.cache/search-mcp/github-artifacts/`).
 * Reuses the hardened writer: UUID filenames, 0700 dir, 0600 files, atomic
 * writes, symlink rejection, 24h TTL, 1 MiB/file, 200 files, 64 MiB total.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { OverflowArtifact } from '../types.js';
import {
  writeWebSearchArtifact,
  startArtifactSweeper,
  ARTIFACT_TTL_MS,
  ARTIFACT_MAX_FILES,
  ARTIFACT_MAX_TOTAL_BYTES,
  ARTIFACT_MAX_BYTES,
  type ArtifactOptions,
  type SweepOptions,
} from './webSearchArtifact.js';

/** GitHub artifact directory: ~/.cache/search-mcp/github-artifacts. */
export function githubArtifactDir(): string {
  return path.join(os.homedir(), '.cache', 'search-mcp', 'github-artifacts');
}

/**
 * Write overflow content for a GitHub tool to a private artifact file.
 * Returns the structured `OverflowArtifact` union — never throws.
 */
export function writeGitHubArtifact(
  content: string,
  sourceBytes: number,
  complete: boolean,
  options: ArtifactOptions = {},
): OverflowArtifact {
  const opts: ArtifactOptions = { ...options, baseDir: options.baseDir ?? githubArtifactDir() };
  try {
    const result = writeWebSearchArtifact(content, opts);
    if (result.path !== null) {
      const expiresAt = new Date(
        (opts.now ?? Date.now()) + (opts.ttlMs ?? ARTIFACT_TTL_MS),
      ).toISOString();
      // Finding 2: storedBytes must reflect actual bounded bytes, not original content
      const actualBytes = Buffer.byteLength(content, 'utf8');
      const boundedBytes = result.complete ? actualBytes : ARTIFACT_MAX_BYTES;
      return {
        available: true,
        path: result.path,
        complete: complete && result.complete,
        sourceBytes,
        storedBytes: boundedBytes,
        expiresAt,
      };
    }
  } catch {
    // best-effort: artifact failure never fails successful GitHub request
  }
  return {
    available: false,
    path: null,
    complete: false,
    sourceBytes,
    storedBytes: 0,
    expiresAt: null,
  };
}

/**
 * Write tree or ref entries as Markdown with fenced JSON for human readability.
 */
export function writeGitHubListArtifact(
  title: string,
  entries: unknown[],
  sourceBytes: number,
  complete: boolean,
  options: ArtifactOptions = {},
): OverflowArtifact {
  const json = JSON.stringify(entries, null, 2);
  const content = `# ${title}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
  return writeGitHubArtifact(content, sourceBytes, complete, options);
}

/** Sweep options for the GitHub artifact directory. */
export function githubSweepOptions(): SweepOptions {
  return {
    baseDir: githubArtifactDir(),
    ttlMs: ARTIFACT_TTL_MS,
    maxFiles: ARTIFACT_MAX_FILES,
    maxTotalBytes: ARTIFACT_MAX_TOTAL_BYTES,
  };
}

/** Start the GitHub artifact sweeper (hourly, unref'd). */
export function startGitHubArtifactSweeper(): NodeJS.Timeout {
  return startArtifactSweeper(githubSweepOptions());
}
