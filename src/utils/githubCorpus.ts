import { logger } from '../logger.js';
import { getGitHubRepoTree } from '../tools/githubRepoTree.js';
import { getGitHubRepoFile } from '../tools/githubRepoFile.js';
import { getGitHubRepoSearch } from '../tools/githubRepoSearch.js';
import type { GitHubTreeEntry } from '../types.js';

export interface GitHubCorpusOptions {
  owner: string;
  repo: string;
  branch?: string;
  extensions?: string[];
  query?: string;
  maxFiles?: number;
}

export interface GitHubCorpusDocument {
  path: string;
  content: string;
  url: string;
}

const DEFAULT_EXTENSIONS = [
  '.md',
  '.mdx',
  '.rst',
  '.txt',
  '.py',
  '.ts',
  '.js',
  '.go',
  '.rs',
  '.java',
];
const CODE_MAX_SIZE = 100_000; // 100KB for code files
const DOC_MAX_SIZE = 500_000; // 500KB for documentation files
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.git',
  'vendor',
  'target',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'bin',
  'obj',
  '__snapshots__',
  '.venv',
  'venv',
]);

const CORE_DIR_HINTS = new Set([
  'src',
  'lib',
  'app',
  'core',
  'internal',
  'pkg',
  'cmd',
  'server',
  'client',
  'cli',
  'packages',
]);

const SURFACE_DIR_HINTS = new Set([
  'examples',
  'example',
  'demo',
  'demos',
  'sample',
  'samples',
  'test',
  'tests',
  'spec',
  'specs',
  'fixture',
  'fixtures',
  'doc',
  'docs',
  'playground',
  'benchmark',
  'benchmarks',
]);

function scoreBroadCorpusFile(entry: GitHubTreeEntry): number {
  const pathParts = entry.path.toLowerCase().split('/');
  let score = 0;
  for (const part of pathParts) {
    if (CORE_DIR_HINTS.has(part)) score += 25;
    if (SURFACE_DIR_HINTS.has(part)) score -= 25;
  }
  score -= pathParts.length * 2;
  score -= entry.path.length / 1000;
  return score;
}

export function prioritizeBroadGitHubCorpus(entries: GitHubTreeEntry[]): GitHubTreeEntry[] {
  return [...entries].sort((a, b) => {
    const delta = scoreBroadCorpusFile(b) - scoreBroadCorpusFile(a);
    if (delta !== 0) return delta;
    return a.path.localeCompare(b.path);
  });
}

export function shouldIncludeFile(entry: GitHubTreeEntry, extensions: string[]): boolean {
  if (entry.type !== 'file') return false;

  const pathParts = entry.path.split('/');
  for (const part of pathParts) {
    if (EXCLUDED_DIRS.has(part)) return false;
  }

  const lowerName = entry.name.toLowerCase();
  const matchedExt = extensions.find((e) => lowerName.endsWith(e.toLowerCase()));
  if (!matchedExt) return false;

  if (entry.size !== undefined) {
    const maxSize = ['.md', '.mdx', '.rst', '.txt'].some((e) => lowerName.endsWith(e))
      ? DOC_MAX_SIZE
      : CODE_MAX_SIZE;
    if (entry.size > maxSize) return false;
  }

  return true;
}

export async function fetchGitHubCorpus(
  opts: GitHubCorpusOptions,
): Promise<GitHubCorpusDocument[]> {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const maxFiles = opts.maxFiles ?? 100;

  let candidateFiles: GitHubTreeEntry[];

  if (opts.query) {
    const searchResult = await getGitHubRepoSearch(
      opts.query,
      opts.owner,
      opts.repo,
      undefined,
      undefined,
      Math.min(maxFiles * 2, 100),
    );
    candidateFiles = searchResult.results
      .map((r) => ({
        name: r.name,
        path: r.path,
        type: 'file' as const,
        htmlUrl: r.htmlUrl,
        apiUrl: r.url,
      }))
      .filter((e) => shouldIncludeFile(e, extensions));
  } else {
    const treeResult = await getGitHubRepoTree(opts.owner, opts.repo, '', opts.branch, true, 500);
    candidateFiles = prioritizeBroadGitHubCorpus(
      treeResult.entries.filter((e) => shouldIncludeFile(e, extensions)),
    );
  }

  const selectedFiles = candidateFiles.slice(0, maxFiles);
  const docs: GitHubCorpusDocument[] = [];

  for (const file of selectedFiles) {
    try {
      const result = await getGitHubRepoFile(
        opts.owner,
        opts.repo,
        file.path,
        opts.branch,
        true,
        undefined,
        undefined,
        undefined,
        50_000,
      );
      if (result.isBinary) continue;
      docs.push({
        path: file.path,
        content: result.content,
        url: result.htmlUrl,
      });
    } catch (err) {
      logger.warn({ err, path: file.path }, 'Failed to fetch GitHub file for corpus');
    }
  }

  return docs;
}
