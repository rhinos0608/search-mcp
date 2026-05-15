/**
 * Consolidated package registry search tool.
 *
 * Replaces npm_search and pypi_search with a single `packages` tool.
 *
 * Actions:
 *   npm  — Search the npm registry for JavaScript packages
 *   pypi — Search the Python Package Index
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { npmSearch } from '../npmSearch.js';
import { pypiSearch } from '../pypiSearch.js';
import { logger } from '../../logger.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

const npmAction = z.object({
  action: z.literal('npm').describe('Search the npm registry for JavaScript packages'),
  query: z.string().describe('Search query string (e.g. "react state management")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .default(20)
    .describe('Maximum packages to return (1–250, default 20)'),
});

const pypiAction = z.object({
  action: z.literal('pypi').describe('Search the Python Package Index'),
  query: z.string().describe('Search query string (e.g. "machine learning framework")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum packages to return (1–50, default 20)'),
});

const packagesFamily: FamilyDefinition = {
  name: 'packages',
  description:
    'Search package registries for npm (JavaScript) or PyPI (Python) packages. ' +
    'Choose the `action` field: `npm` for the npm registry, `pypi` for Python Package Index.',
  actions: [
    {
      name: 'npm',
      description: 'Search the npm registry for JavaScript packages',
      schema: npmAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as z.infer<typeof npmAction>;
        try {
          return await npmSearch(query, limit);
        } catch (err) {
          logger.error({ err, tool: 'packages.npm' }, 'npm search failed');
          throw err;
        }
      },
    },
    {
      name: 'pypi',
      description: 'Search the Python Package Index',
      schema: pypiAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as z.infer<typeof pypiAction>;
        try {
          return await pypiSearch(query, limit);
        } catch (err) {
          logger.error({ err, tool: 'packages.pypi' }, 'pypi search failed');
          throw err;
        }
      },
    },
  ],
};

export function registerPackagesTool(server: McpServer, cfg: SearchConfig, kgHook?: KnowledgeGraphHook): void {
  registerFamily(server, packagesFamily, cfg, kgHook);
}

export function packagesCapabilities(_cfg: SearchConfig) {
  void _cfg;
  return packagesFamily.actions.map((a) => ({
    name: `packages.${a.name}`,
    available: true,
    issue: null,
  }));
}
