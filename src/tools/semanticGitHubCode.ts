import { getCodeEmbeddingFallbackWarning, loadConfig } from '../config.js';
import { validationError } from '../errors.js';
import { chunksFromCodeFilesAsync } from '../rag/adapters/code.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import { getProfileSettings } from '../rag/profiles.js';
import type { RetrievalProfileName, RetrievalScore } from '../rag/types.js';
import {
  fetchGitHubCorpus,
  getGitHubCorpusWarnings,
  type GitHubCorpusDocument,
  type GitHubCorpusOptions,
} from '../utils/githubCorpus.js';

export interface SemanticGitHubCodeInput {
  query: string;
  repo: string;
  ref?: string | undefined;
  language?: string | undefined;
  maxFiles?: number | undefined;
  maxFileBytes?: number | undefined;
  fileFilter?: string[] | undefined;
  topK?: number | undefined;
  profile?: RetrievalProfileName | undefined;
  includeContext?: boolean | undefined;
  debug?: boolean | undefined;
}

export interface SemanticGitHubCodeResultItem {
  rank: number;
  score: RetrievalScore;
  path: string;
  url: string;
  language: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  symbolName?: string | undefined;
  symbolKind?: string | undefined;
  signature?: string | undefined;
  docstring?: string | undefined;
  section: string;
  text?: string | undefined;
}

export interface SemanticGitHubCodeResult {
  query: string;
  repo: string;
  profile: RetrievalProfileName;
  results: SemanticGitHubCodeResultItem[];
  warnings: string[];
  debug?:
    | {
        collectedFiles: number;
        chunkCount: number;
      }
    | undefined;
}

export interface SemanticGitHubCodeDependencies {
  fetchCorpus?: ((opts: GitHubCorpusOptions) => Promise<GitHubCorpusDocument[]>) | undefined;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

function languageExtensions(language: string | undefined): string[] | undefined {
  switch (language?.toLowerCase()) {
    case 'typescript':
      return ['.ts', '.tsx'];
    case 'javascript':
      return ['.js', '.jsx', '.mjs', '.cjs'];
    case 'python':
      return ['.py'];
    case 'go':
      return ['.go'];
    case 'rust':
      return ['.rs'];
    case 'markdown':
      return ['.md', '.mdx', '.markdown'];
    case 'shell':
      return ['.sh', '.bash'];
    default:
      return undefined;
  }
}

function matchesFileFilter(path: string, filters: string[] | undefined): boolean {
  if (filters === undefined || filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter.length === 0) return true;
    if (filter.includes('*')) {
      const pattern = filter.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
      return new RegExp(`^${pattern}$`, 'u').test(path);
    }
    return path.startsWith(filter) || path.includes(filter);
  });
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export async function semanticGitHubCode(
  input: SemanticGitHubCodeInput,
  deps: SemanticGitHubCodeDependencies = {},
): Promise<SemanticGitHubCodeResult> {
  if (!REPO_RE.test(input.repo)) {
    throw validationError("repo must be in 'owner/repo' form");
  }

  const [owner, repo] = input.repo.split('/');
  if (owner === undefined || repo === undefined) {
    throw validationError("repo must be in 'owner/repo' form");
  }

  const extensions = languageExtensions(input.language);
  const fetchCorpus = deps.fetchCorpus ?? fetchGitHubCorpus;
  const maxFiles = input.maxFiles ?? 100;
  const docs = await fetchCorpus({
    owner,
    repo,
    ...(input.ref !== undefined ? { branch: input.ref } : {}),
    maxFiles,
    ...(input.maxFileBytes !== undefined ? { maxFileBytes: input.maxFileBytes } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(input.query.length > 0 ? { query: input.query } : {}),
  });

  const scopedDocs = docs.filter((doc) => matchesFileFilter(doc.path, input.fileFilter));
  const corpusWarnings = getGitHubCorpusWarnings({
    repo: input.repo,
    query: input.query,
    maxFiles,
    candidateCount: docs.length,
    selectedPaths: scopedDocs.map((doc) => doc.path),
  });
  const configWarning = getCodeEmbeddingFallbackWarning(loadConfig());
  const warnings = [...corpusWarnings, ...(configWarning !== undefined ? [configWarning] : [])];

  if (scopedDocs.length === 0) {
    return {
      query: input.query,
      repo: input.repo,
      profile: input.profile ?? 'lexical-heavy',
      results: [],
      warnings: ['No GitHub files matched the requested scope.', ...warnings],
      ...(input.debug === true ? { debug: { collectedFiles: docs.length, chunkCount: 0 } } : {}),
    };
  }

  const chunks = await chunksFromCodeFilesAsync(
    scopedDocs.map((doc) => ({
      path: doc.path,
      content: doc.content,
      url: doc.url,
    })),
  );

  const profile = getProfileSettings(input.profile ?? 'lexical-heavy');
  const corpus = prepareCorpus({
    adapter: 'code',
    chunks,
    profile: profile.profile,
    metadata: { repo: input.repo },
  });

  const response = retrieveCorpus(corpus, {
    query: input.query,
    topK: input.topK,
    profile: profile.profile,
  });

  return {
    query: input.query,
    repo: input.repo,
    profile: profile.profile,
    results: response.results.map((result) => {
      const metadata = result.item.metadata ?? {};
      return {
        rank: result.rank,
        score: result.score,
        path: stringMetadata(metadata.path) ?? '',
        url: result.item.url,
        language: stringMetadata(metadata.language) ?? 'unknown',
        startLine: numberMetadata(metadata.startLine),
        endLine: numberMetadata(metadata.endLine),
        symbolName: stringMetadata(metadata.symbolName),
        symbolKind: stringMetadata(metadata.symbolKind),
        signature: stringMetadata(metadata.signature),
        docstring: stringMetadata(metadata.docstring),
        section: result.item.section,
        ...(input.includeContext === true ? { text: result.item.text } : {}),
      };
    }),
    warnings: [...warnings, ...(response.warnings ?? [])],
    ...(input.debug === true
      ? { debug: { collectedFiles: docs.length, chunkCount: chunks.length } }
      : {}),
  };
}
