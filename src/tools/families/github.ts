/**
 * Consolidated GitHub tool family.
 *
 * Replaces six separate MCP tools (github_repo, github_repo_file,
 * github_repo_tree, github_repo_search, github_trending,
 * semantic_github_code) with a single `github` tool using a
 * discriminated union on `action`.
 *
 * Actions:
 *   repo        — Repository metadata + README
 *   file        — Read a file from a repository
 *   tree        — List directory contents
 *   search      — Code search via GitHub Search API
 *   trending    — Trending repositories on GitHub
 *   code_search — AST-aware semantic code search (RAG)
 *
 * Each action has its own sharply scoped Zod schema (Pattern B).
 * The `trending` action works without any authentication.
 * All GitHub API-backed actions benefit from GITHUB_TOKEN when set.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { getGitHubRepo } from '../githubRepo.js';
import { getGitHubRepoFile } from '../githubRepoFile.js';
import { getGitHubRepoTree } from '../githubRepoTree.js';
import { getGitHubRepoSearch } from '../githubRepoSearch.js';
import { getGitHubTrending } from '../githubTrending.js';
import { semanticGitHubCode } from '../semanticGitHubCode.js';
import { wrapResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { resolveGitHubRepoLocator } from '../normalize.js';

// ── Action schemas (each is a complete z.object with action discriminator) ──

const repoAction = z.object({
  action: z.literal('repo').describe('Fetch repository metadata and README'),
  // Accept either owner+repo separate, or 'repository' as "owner/repo" string or GitHub URL
  owner: z
    .string()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
    .optional()
    .describe('GitHub username or organisation'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,100}$/)
    .optional()
    .describe('Repository name'),
  repository: z
    .string()
    .optional()
    .describe('Repository as "owner/repo" or GitHub URL (alternative to owner+repo fields)'),
  includeReadme: z
    .boolean()
    .optional()
    .default(true)
    .describe('Fetch and include the raw README content (default true)'),
});

const fileAction = z
  .object({
    action: z.literal('file').describe('Read a file from a repository'),
    owner: z
      .string()
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
      .optional()
      .describe('GitHub username or organisation'),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .optional()
      .describe('Repository name'),
    repository: z
      .string()
      .optional()
      .describe('Repository as "owner/repo" or GitHub URL (alternative to owner+repo fields)'),
    path: z.string().describe('File path within the repo'),
    branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
    raw: z.boolean().optional().default(true).describe('true = decoded UTF-8 text; false = base64'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Line offset (0-based). Requires raw=true.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum lines to return. Requires raw=true.'),
    byteOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Byte offset (0-based) via Range header. Requires raw=true.'),
    byteLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum bytes via Range header. Requires raw=true.'),
  })
  .superRefine((params, ctx) => {
    const hasOffsetRelated =
      params.offset !== undefined ||
      params.limit !== undefined ||
      params.byteOffset !== undefined ||
      params.byteLimit !== undefined;
    if (hasOffsetRelated && !params.raw) {
      ctx.addIssue({
        code: 'custom',
        message: 'offset/limit/byteOffset/byteLimit require raw=true',
        path: ['raw'],
      });
    }
  });

const treeAction = z.object({
  action: z.literal('tree').describe('List directory contents'),
  owner: z
    .string()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
    .optional()
    .describe('GitHub username or organisation'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,100}$/)
    .optional()
    .describe('Repository name'),
  repository: z
    .string()
    .optional()
    .describe('Repository as "owner/repo" or GitHub URL (alternative to owner+repo fields)'),
  path: z.string().optional().default('').describe('Directory path within the repo'),
  branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
  recursive: z.boolean().optional().default(false).describe('Return full recursive tree'),
  limit: z.number().int().min(1).max(500).optional().default(100).describe('Max items (1–500)'),
  includeMonorepo: z
    .boolean()
    .optional()
    .describe('Auto-detect monorepo structure. Defaults true when path is empty (root).'),
});

const searchAction = z.object({
  action: z.literal('search').describe('Search code across GitHub repositories'),
  query: z.string().describe('Search term (GitHub code-search syntax)'),
  owner: z.string().optional().describe('Narrow to a specific user or org'),
  repo: z.string().optional().describe('Narrow to a specific repo (requires owner)'),
  language: z.string().optional().describe('Filter by language (e.g. "typescript")'),
  path: z.string().optional().describe('Filter to files under this path'),
  limit: z.number().int().min(1).max(1000).optional().default(30).describe('Max results (1–1000)'),
});

const trendingAction = z.object({
  action: z.literal('trending').describe('Get trending repositories'),
  language: z
    .string()
    .optional()
    .default('')
    .describe('Language slug (e.g. "typescript", "python"). Empty for all languages.'),
  since: z
    .enum(['daily', 'weekly', 'monthly'])
    .optional()
    .default('daily')
    .describe('Time window: daily | weekly | monthly'),
  limit: z.number().int().min(1).max(50).optional().default(25).describe('Max repos (1–50)'),
});

const codeSearchAction = z.object({
  action: z.literal('code_search').describe('Semantic code search across a repository'),
  query: z.string().describe('Code search query, e.g. an identifier or behaviour'),
  repo: z.preprocess(
    (val) => {
      if (typeof val === 'string') {
        const loc = resolveGitHubRepoLocator(val);
        if (loc) return `${loc.owner}/${loc.repo}`;
      }
      return val;
    },
    z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u),
  ).describe('Repository in owner/repo form or GitHub URL'),
  ref: z.string().optional().describe('Git ref, branch, tag, or commit SHA'),
  language: z
    .enum(['typescript', 'javascript', 'python', 'go', 'rust', 'markdown', 'shell'])
    .optional()
    .describe('Language filter'),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe('Max files to collect (1–500)'),
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(500_000)
    .optional()
    .default(50_000)
    .describe('Max bytes per file before truncation'),
  fileFilter: z
    .array(z.string())
    .optional()
    .describe('Path prefixes, substrings, or * globs to keep'),
  preFilterByContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Run a lightweight content-based prefilter before downloading full files'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Number of code results (1–50)'),
  profile: z
    .enum([
      'balanced',
      'lexical-heavy',
      'semantic-heavy',
      'high-precision',
      'fast',
      'precision',
      'recall',
    ])
    .optional()
    .default('lexical-heavy')
    .describe('Retrieval profile (defaults to lexical-heavy for code)'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum bi-encoder score required for returned chunks (0–1)'),
  includeContext: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include source code text in results'),
  debug: z.boolean().optional().default(false).describe('Include debug corpus counts'),
});

// ── Family definition ───────────────────────────────────────────────────────

const githubFamily: FamilyDefinition = {
  name: 'github',
  description:
    'Work with GitHub repositories, files, directory trees, code search, trending repos, ' +
    'and semantic code search. Choose the `action` field to select what to do: ' +
    '`repo` for metadata, `file` for reading a known file, `tree` for listing contents, ' +
    '`search` for GitHub code search, `trending` for trending repos (no auth needed), ' +
    'and `code_search` for AST-aware semantic code retrieval.',
  actions: [
    {
      name: 'repo',
      description: 'Fetch repository metadata, stars, forks, license, topics, and README',
      schema: repoAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, includeReadme } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          includeReadme: boolean;
        };

        // Support 'repository' as alternative to 'owner'/'repo' (accepts owner/repo, GitHub URL)
        let resolvedOwner = owner;
        let resolvedRepo = repo;
        if (!resolvedOwner && !resolvedRepo && repository) {
          const loc = resolveGitHubRepoLocator(repository);
          if (loc) {
            resolvedOwner = loc.owner;
            resolvedRepo = loc.repo;
          }
        }
        if (!resolvedOwner || !resolvedRepo) {
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        const data = await getGitHubRepo(resolvedOwner, resolvedRepo, includeReadme);
        return data;
      },
    },
    {
      name: 'file',
      description: 'Read the raw content of a specific file in a repository',
      schema: fileAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, path, branch, raw, offset, limit, byteOffset, byteLimit } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          path: string;
          branch?: string;
          raw: boolean;
          offset?: number;
          limit?: number;
          byteOffset?: number;
          byteLimit?: number;
        };

        // Resolve owner+repo from repository if needed
        let resolvedOwner = owner;
        let resolvedRepo = repo;
        if ((!resolvedOwner || !resolvedRepo) && repository) {
          const loc = resolveGitHubRepoLocator(repository);
          if (loc) {
            resolvedOwner = loc.owner;
            resolvedRepo = loc.repo;
          }
        }
        if (!resolvedOwner || !resolvedRepo) {
          throw new Error('Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)');
        }

        const data = await getGitHubRepoFile(
          resolvedOwner,
          resolvedRepo,
          path,
          branch,
          raw,
          offset,
          limit,
          byteOffset,
          byteLimit,
        );
        return data;
      },
    },
    {
      name: 'tree',
      description: 'List the directory structure of a repository',
      schema: treeAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, path, branch, recursive, limit, includeMonorepo } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          path: string;
          branch?: string;
          recursive: boolean;
          limit: number;
          includeMonorepo?: boolean;
        };

        // Resolve owner+repo from repository if needed
        let resolvedOwner = owner;
        let resolvedRepo = repo;
        if ((!resolvedOwner || !resolvedRepo) && repository) {
          const loc = resolveGitHubRepoLocator(repository);
          if (loc) {
            resolvedOwner = loc.owner;
            resolvedRepo = loc.repo;
          }
        }
        if (!resolvedOwner || !resolvedRepo) {
          throw new Error('Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)');
        }

        const data = await getGitHubRepoTree(
          resolvedOwner,
          resolvedRepo,
          path,
          branch,
          recursive,
          limit,
          includeMonorepo,
        );
        return data;
      },
    },
    {
      name: 'search',
      description: 'Search code across GitHub using the GitHub Search API',
      schema: searchAction,
      handler: async (args, cfg) => {
        void cfg;
        const { query, owner, repo, language, path, limit } = args as {
          query: string;
          owner?: string;
          repo?: string;
          language?: string;
          path?: string;
          limit: number;
        };
        const data = await getGitHubRepoSearch(query, owner, repo, language, path, limit);
        return data;
      },
      configIssue: (cfg) => {
        if (!cfg.github.token) {
          return 'Without GITHUB_TOKEN, search is limited to 10 results/minute. Set GITHUB_TOKEN for full access.';
        }
        return null;
      },
    },
    {
      name: 'trending',
      description: 'Scrape GitHub Trending page for currently trending repositories',
      schema: trendingAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { language, since, limit } = args as {
          language: string;
          since: 'daily' | 'weekly' | 'monthly';
          limit: number;
        };
        const { repos, warnings } = await getGitHubTrending(language, since, limit);
        // Surface warnings as structured return
        if (warnings.length > 0) {
          return wrapResponse(repos, warnings);
        }
        return repos;
      },
      // No configIssue — cheerio scrape works without any auth
    },
    {
      name: 'code_search',
      description:
        'AST-aware semantic code search across a repository using embeddings and tree-sitter',
      schema: codeSearchAction,
      handler: async (args, cfg) => {
        void cfg;
        const {
          query,
          repo,
          ref,
          language,
          maxFiles,
          maxFileBytes,
          fileFilter,
          preFilterByContent,
          topK,
          profile,
          minScore,
          includeContext,
          debug,
        } = args as {
          query: string;
          repo: string;
          ref?: string;
          language?: string;
          maxFiles: number;
          maxFileBytes: number;
          fileFilter?: string[];
          preFilterByContent: boolean;
          topK: number;
          profile: string;
          minScore?: number;
          includeContext: boolean;
          debug: boolean;
        };

        const data = await semanticGitHubCode({
          query,
          repo,
          ...(ref !== undefined ? { ref } : {}),
          ...(language !== undefined ? { language } : {}),
          maxFiles,
          maxFileBytes,
          ...(fileFilter !== undefined ? { fileFilter } : {}),
          preFilterByContent,
          topK,
          ...(minScore !== undefined ? { minScore } : {}),
          profile: profile as
            | 'balanced'
            | 'lexical-heavy'
            | 'semantic-heavy'
            | 'high-precision'
            | 'fast'
            | 'precision'
            | 'recall',
          includeContext,
          debug,
        });

        const warnings = data.warnings;
        return wrapResponse(data, warnings);
      },
      configIssue: (cfg) => {
        if (!cfg.github.token) {
          return 'Set GITHUB_TOKEN to use github.code_search (GitHub API required for repository file access).';
        }
        if (!cfg.embeddingSidecar.baseUrl) {
          return 'Set EMBEDDING_SIDECAR_BASE_URL to use github.code_search (embedding sidecar required for semantic ranking).';
        }
        return null;
      },
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerGitHubTool(server: McpServer, cfg: SearchConfig, kgHook?: KnowledgeGraphHook): void {
  registerFamily(server, githubFamily, cfg, kgHook);
}

export function gitHubCapabilities(cfg: SearchConfig) {
  return githubFamily.actions.map((a) => ({
    name: `github.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
