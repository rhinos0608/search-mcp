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
  includePaths?: string[];
  excludePaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface GitHubCorpusDependencies {
  getGitHubRepoTree?: typeof getGitHubRepoTree;
  getGitHubRepoFile?: typeof getGitHubRepoFile;
  getGitHubRepoSearch?: typeof getGitHubRepoSearch;
}

export interface GitHubCorpusDocument {
  path: string;
  content: string;
  url: string;
}

export interface GitIgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function gitIgnorePatternToRegExp(rule: GitIgnoreRule): RegExp {
  const trimmedPattern = rule.pattern.replace(/^\/+|\/+$/gu, '');
  const segments = trimmedPattern.split('/').map((segment) => {
    if (segment === '**') return '.*';
    const escaped = escapeRegExp(segment).replace(/\\\*/gu, '[^/]*').replace(/\\\?/gu, '[^/]');
    return escaped;
  });
  const body = segments.join('/');
  const prefix = rule.anchored ? '^' : '(^|/)';
  const suffix = rule.directoryOnly ? '(/|$)' : '($|/)';
  return new RegExp(`${prefix}${body}${suffix}`, 'u');
}

export function parseGitIgnoreRules(content: string): GitIgnoreRule[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const rawPattern = negated ? line.slice(1) : line;
      return {
        pattern: rawPattern,
        negated,
        directoryOnly: rawPattern.endsWith('/'),
        anchored: rawPattern.startsWith('/'),
      } satisfies GitIgnoreRule;
    })
    .filter((rule) => rule.pattern.length > 0);
}

function isIgnoredByRules(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (gitIgnorePatternToRegExp(rule).test(path)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function scoreBroadCorpusFile(entry: GitHubTreeEntry): number {
  const pathParts = entry.path.toLowerCase().split('/');
  const name = pathParts[pathParts.length - 1] ?? '';
  let score = 0;
  for (const [index, part] of pathParts.entries()) {
    if (part === 'src') score += index === 0 ? 55 : 35;
    else if (CORE_DIR_HINTS.has(part)) score += 25;
    if (SURFACE_DIR_HINTS.has(part)) score -= 25;
  }
  // Penalize changelogs, history files, readme — they dominate results but aren't useful for code search
  if (/^(changelog|history|readme|contributing|license)/i.test(name)) score -= 50;
  // Penalize generic top-level policy/agent docs unless the query asks for them.
  if (/^(agents|security|code_of_conduct|contributing|governance)\.(md|mdx|rst|txt)$/i.test(name)) {
    score -= 15;
  }
  // Penalize .md/.txt docs vs source code for broad code search.
  if (/\.(md|mdx|txt|rst)$/i.test(name)) score -= 20;
  score -= pathParts.length * 2;
  score -= entry.path.length / 1000;
  return score;
}

const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'official',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function tokenizeQuery(query: string | undefined): string[] {
  if (query === undefined) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
}

function scoreGitHubPathForQuery(entry: GitHubTreeEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const path = entry.path.toLowerCase();
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  let score = 0;
  for (const term of terms) {
    if (path.includes(term)) score += 4;
    if (name.includes(term)) score += 7;
    for (const dir of parts.slice(0, -1)) {
      if (dir.includes(term)) score += 2;
    }
  }
  if (/\b(docs?|spec|specification|security|reference|guide|protocol)\b/u.test(path)) score += 2;
  if (/\b(examples?|demos?|fixtures?|tests?|generated|vendor)\b/u.test(path)) score -= 4;
  return score;
}

export function prioritizeBroadGitHubCorpus(entries: GitHubTreeEntry[]): GitHubTreeEntry[] {
  return [...entries].sort((a, b) => {
    const delta = scoreBroadCorpusFile(b) - scoreBroadCorpusFile(a);
    if (delta !== 0) return delta;
    return a.path.localeCompare(b.path);
  });
}

export function rankGitHubFilesByQuery(
  entries: GitHubTreeEntry[],
  query: string | undefined,
): GitHubTreeEntry[] {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return prioritizeBroadGitHubCorpus(entries);

  return [...entries].sort((a, b) => {
    const aScore = scoreGitHubPathForQuery(a, terms) * 3 + scoreBroadCorpusFile(a) * 0.25;
    const bScore = scoreGitHubPathForQuery(b, terms) * 3 + scoreBroadCorpusFile(b) * 0.25;
    const delta = bScore - aScore;
    if (delta !== 0) return delta;
    return a.path.localeCompare(b.path);
  });
}

function matchesPathFilter(path: string, filters: string[] | undefined): boolean {
  if (filters === undefined || filters.length === 0) return false;
  const normalized = path.toLowerCase();
  return filters.some((filter) => normalized.includes(filter.toLowerCase()));
}

function passesPathFilters(
  path: string,
  includePaths: string[] | undefined,
  excludePaths: string[] | undefined,
): boolean {
  if (
    includePaths !== undefined &&
    includePaths.length > 0 &&
    !matchesPathFilter(path, includePaths)
  ) {
    return false;
  }
  return !matchesPathFilter(path, excludePaths);
}

export interface GitHubCorpusWarningInput {
  repo: string;
  query?: string | undefined;
  maxFiles: number;
  candidateCount: number;
  selectedPaths: string[];
}

export function getGitHubCorpusWarnings(input: GitHubCorpusWarningInput): string[] {
  const warnings: string[] = [];

  if (input.candidateCount === 0) {
    warnings.push(
      `GitHub search for "${input.query ?? ''}" in ${input.repo} returned 0 results. The repo may be private, the query may not match, or GitHub code search limits may apply.`,
    );
    return warnings;
  }

  const underConstrained = input.query === undefined || input.query.trim().length === 0;
  if (underConstrained) {
    warnings.push(`GitHub crawl for ${input.repo} is broad; add query, language, or file filters.`);
  }

  if (input.candidateCount > input.maxFiles * 2) {
    warnings.push(
      `GitHub crawl for ${input.repo} started with ${String(input.candidateCount)} candidate files but only ${String(input.maxFiles)} were requested.`,
    );
  }

  const noisyPaths = input.selectedPaths.filter((selectedPath) =>
    /(^|\/)(examples?|demos?|samples?|test(s)?|fixtures?|dist|build|generated)(\/|$)/iu.test(
      selectedPath,
    ),
  );
  if (noisyPaths.length > 0) {
    warnings.push(`GitHub crawl for ${input.repo} still includes example or generated paths.`);
  }

  return warnings;
}

export function shouldIncludeFileWithIgnoreRules(
  entry: GitHubTreeEntry,
  extensions: string[],
  ignoreRules: GitIgnoreRule[],
): boolean {
  return shouldIncludeFile(entry, extensions) && !isIgnoredByRules(entry.path, ignoreRules);
}

export function shouldIncludeFile(entry: GitHubTreeEntry, extensions: string[]): boolean {
  if (entry.type !== 'file') return false;

  const pathParts = entry.path.split('/');
  for (const part of pathParts) {
    if (EXCLUDED_DIRS.has(part)) return false;
  }

  const lowerName = entry.name.toLowerCase();
  const matchedExt = extensions.find((e) => lowerName.endsWith(e));
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
  deps: GitHubCorpusDependencies = {},
): Promise<GitHubCorpusDocument[]> {
  // Pre-convert extensions to lowercase for efficient matching
  const extensions = (opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
  const maxFiles = opts.maxFiles ?? 100;
  const maxFileBytes = opts.maxFileBytes ?? 50_000;
  const getTree = deps.getGitHubRepoTree ?? getGitHubRepoTree;
  const getFile = deps.getGitHubRepoFile ?? getGitHubRepoFile;
  const getSearch = deps.getGitHubRepoSearch ?? getGitHubRepoSearch;

  // Phase 1: Always fetch the full repo tree first — exhaustive file listing.
  let treeFiles: GitHubTreeEntry[] = [];
  try {
    const treeResult = await getTree(opts.owner, opts.repo, '', opts.branch, true, 500);
    treeFiles = treeResult.entries.filter(
      (e) =>
        shouldIncludeFile(e, extensions) &&
        passesPathFilters(e.path, opts.includePaths, opts.excludePaths),
    );
    logger.info(
      { repo: opts.repo, treeFiles: treeFiles.length },
      'fetchGitHubCorpus: repo tree fetched',
    );
  } catch (err) {
    logger.warn(
      { err, repo: opts.repo },
      'fetchGitHubCorpus: repo tree fetch failed, trying search-only fallback',
    );
  }

  // Phase 2: If a query is provided, also search to find relevant files.
  const searchFiles: GitHubTreeEntry[] = [];
  if (opts.query && opts.query.trim().length > 0) {
    try {
      const searchResult = await getSearch(
        opts.query,
        opts.owner,
        opts.repo,
        undefined,
        undefined,
        Math.min(maxFiles, 100),
      );
      for (const r of searchResult.results) {
        const entry: GitHubTreeEntry = {
          name: r.name,
          path: r.path,
          type: 'file' as const,
          htmlUrl: r.htmlUrl,
          apiUrl: r.url,
        };
        if (
          shouldIncludeFile(entry, extensions) &&
          passesPathFilters(entry.path, opts.includePaths, opts.excludePaths)
        ) {
          searchFiles.push(entry);
        }
      }
      logger.info(
        { repo: opts.repo, searchFiles: searchFiles.length },
        'fetchGitHubCorpus: search results merged',
      );
    } catch (err) {
      logger.warn({ err, repo: opts.repo }, 'fetchGitHubCorpus: search failed');
    }
  }

  // Phase 3: Merge tree + search results, dedup by path. Search results come first so they get
  // priority in dedup (search hits are more relevant than tree listings).
  const seenPaths = new Set<string>();
  const merged: GitHubTreeEntry[] = [];
  for (const entry of [...searchFiles, ...treeFiles]) {
    if (!seenPaths.has(entry.path)) {
      seenPaths.add(entry.path);
      merged.push(entry);
    }
  }

  const candidateFiles = rankGitHubFilesByQuery(merged, opts.query);
  const selectedFiles = candidateFiles.slice(0, maxFiles);
  const docs: GitHubCorpusDocument[] = [];

  for (const file of selectedFiles) {
    try {
      const result = await getFile(
        opts.owner,
        opts.repo,
        file.path,
        opts.branch,
        true,
        undefined,
        undefined,
        undefined,
        maxFileBytes,
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
