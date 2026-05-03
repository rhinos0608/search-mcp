/**
 * Social media search tool.
 *
 * Replaces twitter_search with a single `social` tool.
 *
 * Actions:
 *   twitter — Search Twitter/X via Nitter
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { twitterSearch } from '../twitterSearch.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Twitter action ────────────────────────────────────────────────────────────

const twitterAction = z.object({
  action: z.literal('twitter').describe('Search Twitter/X via Nitter'),
  query: z.string().describe('Search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum tweets to return (1–50, default 20)'),
});

// ── Family definition ────────────────────────────────────────────────────

const socialFamily: FamilyDefinition = {
  name: 'social',
  description: 'Search social media: Twitter/X via Nitter.',
  actions: [
    {
      name: 'twitter',
      description: 'Search Twitter/X posts via a Nitter instance',
      schema: twitterAction,
      handler: async (args, cfg) => {
        const { query, limit } = args as { query: string; limit: number };
        return twitterSearch(query, cfg.nitter.baseUrl, limit);
      },
      configIssue: (cfg: SearchConfig) =>
        cfg.nitter.baseUrl
          ? null
          : 'Set NITTER_BASE_URL env var (e.g. https://nitter.net)',
    },
  ],
};

// ── Registration ────────────────────────────────────────────────────────────────

export function registerSocialTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, socialFamily, cfg);
}

export function socialCapabilities(cfg: SearchConfig) {
  return socialFamily.actions.map((a) => {
    const issue = a.configIssue?.(cfg) ?? null;
    return {
      name: `social.${a.name}`,
      available: issue == null,
      issue,
    };
  });
}