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
 *   list_dir    — List immediate contents of a directory (non-recursive)
 *   tree        — List directory contents (supports recursive / monorepo)
 *   search      — Code search via GitHub Search API
 *   commits     — Commit history for a repository/ref/path
 *   refs        — Branch/tag refs and target SHAs
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
import { getGitHubRepoSearch, getGitHubMultiSearch } from '../githubRepoSearch.js';
import { getGitHubTrending } from '../githubTrending.js';
import { getGitHubCommitHistory } from '../githubCommits.js';
import { getGitHubRefs } from '../githubRefs.js';
import { semanticGitHubCode } from '../semanticGitHubCode.js';
import { DEFAULT_GITHUB_MAX_FILE_BYTES } from '../../utils/githubCorpus.js';
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
    ref: z.string().optional().describe('Git ref, branch, tag, or commit SHA. Overrides branch.'),
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
    lineOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Alias for offset: 0-based line offset. Requires raw=true.'),
    lineLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Alias for limit: maximum lines to return. Requires raw=true.'),
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
      params.lineOffset !== undefined ||
      params.lineLimit !== undefined ||
      params.byteOffset !== undefined ||
      params.byteLimit !== undefined;
    if (hasOffsetRelated && !params.raw) {
      ctx.addIssue({
        code: 'custom',
        message: 'offset/limit/lineOffset/lineLimit/byteOffset/byteLimit require raw=true',
        path: ['raw'],
      });
    }
    if (
      params.offset !== undefined &&
      params.lineOffset !== undefined &&
      params.offset !== params.lineOffset
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'offset and lineOffset must match when both are provided',
        path: ['lineOffset'],
      });
    }
    if (
      params.limit !== undefined &&
      params.lineLimit !== undefined &&
      params.limit !== params.lineLimit
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'limit and lineLimit must match when both are provided',
        path: ['lineLimit'],
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
  ref: z.string().optional().describe('Git ref, branch, tag, or commit SHA. Overrides branch.'),
  recursive: z.boolean().optional().default(false).describe('Return full recursive tree'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe('Max items (1–10000, omit for unlimited)'),
  includeMonorepo: z
    .boolean()
    .optional()
    .describe('Auto-detect monorepo structure. Defaults true when path is empty (root).'),
});

const listDirAction = z.object({
  action: z.literal('list_dir').describe('List immediate contents of a directory (non-recursive)'),
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
  ref: z.string().optional().describe('Git ref, branch, tag, or commit SHA. Overrides branch.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe('Max items (1–10000, omit for unlimited)'),
});

// Regex detecting qualifiers that only work on /search/repositories
const REPO_ONLY_QUALIFIERS = /\bin:(readme|name|description|topics)\b/i;

const searchAction = z.object({
  action: z
    .literal('search')
    .describe('Search GitHub: code, repositories, issues, commits, or users'),
  query: z
    .string()
    .describe(
      'Search term (GitHub search syntax). ' +
        'Use qualifiers like in:readme, in:name, in:description, in:topics (repo search only), ' +
        'org:, repo:, language:, is:issue, is:pr, type:pr, etc.',
    ),
  type: z
    .enum(['code', 'repositories', 'issues', 'commits', 'users'])
    .optional()
    .default('code')
    .describe(
      'What to search. Defaults to code, but auto-switches to repositories ' +
        'when query contains in:readme, in:name, in:description, or in:topics.',
    ),
  owner: z.string().optional().describe('Narrow to a specific user or org'),
  repo: z.string().optional().describe('Narrow to a specific repo (requires owner)'),
  language: z.string().optional().describe('Filter by language (e.g. "typescript")'),
  path: z.string().optional().describe('Filter to files under this path (code type only)'),
  sort: z
    .string()
    .optional()
    .describe(
      'Sort order. Varies by type: repos → stars, forks, updated; ' +
        'issues → comments, reactions, created, updated; ' +
        'commits → author-date, committer-date; users → followers, repositories, joined',
    ),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction: asc or desc'),
  limit: z.number().int().min(1).max(1000).optional().default(30).describe('Max results (1–1000)'),
});

const commitsAction = z.object({
  action: z.literal('commits').describe('List repository commit history'),
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
  sha: z.string().optional().describe('Branch, tag, or commit SHA to start listing from'),
  ref: z.string().optional().describe('Alias for sha: branch, tag, or commit SHA'),
  path: z.string().optional().describe('Only commits affecting this path'),
  author: z.string().optional().describe('GitHub username or email author filter'),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Only commits after this ISO timestamp'),
  until: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Only commits before this ISO timestamp'),
  page: z.number().int().min(1).optional().default(1).describe('Result page to fetch'),
  limit: z.number().int().min(1).max(100).optional().default(30).describe('Commits per page'),
});

const refsAction = z.object({
  action: z.literal('refs').describe('List branch/tag refs and target commit SHAs'),
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
  type: z
    .enum(['branches', 'tags', 'all'])
    .optional()
    .default('branches')
    .describe('Which refs to pull: branches, tags, or all refs'),
  filter: z.string().optional().describe('Optional ref prefix/name filter, e.g. main or v1'),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max refs to return'),
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

const codeSearchAction = z
  .object({
    action: z.literal('code_search').describe('Semantic code search across a repository'),
    query: z.string().describe('Code search query, e.g. an identifier or behaviour'),
    repository: z
      .string()
      .optional()
      .describe('Repository as "owner/repo" or GitHub URL (alternative to repo)'),
    repo: z
      .preprocess(
        (val) => {
          if (typeof val === 'string' && val) {
            const loc = resolveGitHubRepoLocator(val);
            if (loc) return `${loc.owner}/${loc.repo}`;
            return val;
          }
          return undefined;
        },
        z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u),
      )
      .optional()
      .describe('Repository in owner/repo form or GitHub URL'),
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
    fileFilter: z
      .array(z.string())
      .optional()
      .describe('Path prefixes, substrings, or * globs to keep'),
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
    includeContext: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include source code text in results'),
  })
  .superRefine((data, ctx) => {
    if (!data.repo && !data.repository) {
      ctx.addIssue({
        code: 'custom',
        path: ['repo'],
        message: 'Missing repository: provide `repo` or `repository` (owner/repo or GitHub URL)',
      });
    }
  });

// ── Family definition ───────────────────────────────────────────────────────

const githubFamily: FamilyDefinition = {
  name: 'github',
  description:
    'Work with GitHub repositories, files, directory trees, code search, trending repos, ' +
    'and semantic code search. Choose the `action` field to select what to do: ' +
    '`repo` for metadata + README, `file` for reading a known file, `list_dir` for listing a ' +
    'directory, `tree` for full tree listing, ' +
    '`search` for GitHub code search (default), repos, issues, commits, or users, ' +
    '`commits` for commit history, `refs` for branch/tag SHA tracking, ' +
    '`trending` for trending repos (no auth needed), and `code_search` for AST-aware semantic code retrieval.',
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
      outputSchema: z.object({
        name: z.string(),
        fullName: z.string(),
        description: z.string().nullable(),
        stars: z.number(),
        forks: z.number(),
        language: z.string().nullable(),
        license: z.string().nullable(),
        topics: z.array(z.string()),
        url: z.string(),
        homepage: z.string().nullable(),
        readme: z.string().optional(),
        readmeError: z.string().optional(),
      }),
    },
    {
      name: 'file',
      description: 'Read the raw content of a specific file in a repository',
      schema: fileAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const {
          owner,
          repo,
          repository,
          path,
          branch,
          ref,
          raw,
          offset,
          limit,
          lineOffset,
          lineLimit,
          byteOffset,
          byteLimit,
        } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          path: string;
          branch?: string;
          ref?: string;
          raw: boolean;
          offset?: number;
          limit?: number;
          lineOffset?: number;
          lineLimit?: number;
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
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        const data = await getGitHubRepoFile(
          resolvedOwner,
          resolvedRepo,
          path,
          ref ?? branch,
          raw,
          offset ?? lineOffset,
          limit ?? lineLimit,
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
        const { owner, repo, repository, path, branch, ref, recursive, limit, includeMonorepo } =
          args as {
            owner?: string;
            repo?: string;
            repository?: string;
            path: string;
            branch?: string;
            ref?: string;
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
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        const data = await getGitHubRepoTree(
          resolvedOwner,
          resolvedRepo,
          path,
          ref ?? branch,
          recursive,
          limit,
          includeMonorepo,
        );
        return data;
      },
    },
    {
      name: 'list_dir',
      description: 'List the immediate files and directories inside a given folder in a repository',
      schema: listDirAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, path, branch, ref, limit } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          path: string;
          branch?: string;
          ref?: string;
          limit?: number;
        };

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
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        const data = await getGitHubRepoTree(
          resolvedOwner,
          resolvedRepo,
          path,
          ref ?? branch,
          false,
          limit,
        );
        return data;
      },
    },
    {
      name: 'search',
      description:
        'Search across GitHub: code, repositories, issues, commits, or users via the GitHub Search API',
      schema: searchAction,
      handler: async (args, cfg) => {
        void cfg;
        const {
          query,
          type: rawType,
          owner,
          repo,
          language,
          path,
          limit,
          sort,
          order,
        } = args as {
          query: string;
          type: 'code' | 'repositories' | 'issues' | 'commits' | 'users';
          owner?: string;
          repo?: string;
          language?: string;
          path?: string;
          limit: number;
          sort?: string;
          order?: 'asc' | 'desc';
        };

        // Auto-detect repository-only qualifiers: if query contains in:readme,
        // in:name, in:description, or in:topics and type is the default 'code',
        // switch to repositories automatically.
        const detectedType: 'code' | 'repositories' | 'issues' | 'commits' | 'users' =
          rawType === 'code' && REPO_ONLY_QUALIFIERS.test(query) ? 'repositories' : rawType;

        // Code search with repo: route to AST-aware semantic search, fall back to basic
        if (detectedType === 'code') {
          const repoSpec = owner && repo ? `${owner}/${repo}` : undefined;
          if (repoSpec) {
            const data = await semanticGitHubCode({
              query,
              repo: repoSpec,
              ...(language !== undefined ? { language } : {}),
              ...(path !== undefined ? { fileFilter: [path] } : {}),
              maxFiles: limit,
              topK: Math.min(limit, 50),
              preFilterByContent: true,
            });

            if (data.topKDelivered === 0) {
              const basicResults = await getGitHubRepoSearch(
                query,
                owner,
                repo,
                language,
                path,
                limit,
              );
              return wrapResponse(basicResults, [
                'code_search returned no results, fell back to basic GitHub search',
              ]);
            }

            return wrapResponse(data, data.warnings);
          }

          const data = await getGitHubRepoSearch(query, owner, repo, language, path, limit);
          return data;
        }

        // Non-code search types: use multi-type search endpoint
        // Build options with exactOptionalPropertyTypes compliance
        const multiOpts: Parameters<typeof getGitHubMultiSearch>[0] = {
          query,
          type: detectedType,
          limit,
        };
        if (owner !== undefined) multiOpts.owner = owner;
        if (repo !== undefined) multiOpts.repo = repo;
        if (language !== undefined) multiOpts.language = language;
        if (sort !== undefined) multiOpts.sort = sort;
        if (order !== undefined) multiOpts.order = order;
        return getGitHubMultiSearch(multiOpts);
      },
      configIssue: (cfg) => {
        if (!cfg.github.token) {
          return 'Without GITHUB_TOKEN, search is limited to 10 results/minute. Set GITHUB_TOKEN for full access.';
        }
        return null;
      },
    },

    {
      name: 'commits',
      description: 'List repository commits with optional ref, path, author, and time filters',
      schema: commitsAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, sha, ref, path, author, since, until, page, limit } =
          args as {
            owner?: string;
            repo?: string;
            repository?: string;
            sha?: string;
            ref?: string;
            path?: string;
            author?: string;
            since?: string;
            until?: string;
            page: number;
            limit: number;
          };

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
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        return getGitHubCommitHistory(resolvedOwner, resolvedRepo, {
          ...(sha !== undefined || ref !== undefined ? { sha: sha ?? ref } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(author !== undefined ? { author } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          page,
          limit,
        });
      },
    },

    {
      name: 'refs',
      description: 'Pull current branch/tag refs and target SHAs for commit tracking',
      schema: refsAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { owner, repo, repository, type, filter, limit } = args as {
          owner?: string;
          repo?: string;
          repository?: string;
          type: 'branches' | 'tags' | 'all';
          filter?: string;
          limit: number;
        };

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
          throw new Error(
            'Missing repository: provide `owner` + `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

        return getGitHubRefs(resolvedOwner, resolvedRepo, {
          type,
          ...(filter !== undefined ? { filter } : {}),
          limit,
        });
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
          repo: rawRepo,
          repository,
          ref,
          language,
          maxFiles,
          fileFilter,
          topK,
          profile,
          includeContext,
        } = args as {
          query: string;
          repo?: string;
          repository?: string;
          ref?: string;
          language?: string;
          maxFiles: number;
          fileFilter?: string[];
          topK: number;
          profile: string;
          includeContext: boolean;
        };
        // Server-level default — 200KB covers most source and doc files
        const maxFileBytes = DEFAULT_GITHUB_MAX_FILE_BYTES;
        const preFilterByContent = true;
        const minScore = undefined as number | undefined;
        const debug = false;

        let repo = rawRepo;
        if (!repo && repository) {
          const loc = resolveGitHubRepoLocator(repository);
          if (loc) repo = `${loc.owner}/${loc.repo}`;
        }
        if (!repo) {
          throw new Error(
            'Missing repository: provide `repo` or `repository` (owner/repo or GitHub URL)',
          );
        }

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

export function registerGitHubTool(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  registerFamily(server, githubFamily, cfg, kgHook);
}

export function gitHubCapabilities(cfg: SearchConfig) {
  return githubFamily.actions.map((a) => ({
    name: `github.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
