/**
 * Media search tool.
 *
 * Replaces podcast_search with a single `media` tool.
 *
 * Actions:
 *   podcast — Search podcast episodes via ListenNotes
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { podcastSearch } from '../podcastSearch.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Podcast action ────────────────────────────────────────────────────────────

const podcastAction = z.object({
  action: z.literal('podcast').describe('Search podcast episodes via ListenNotes'),
  query: z.string().describe('Search query string'),
  sort: z
    .enum(['relevance', 'date'])
    .optional()
    .default('relevance')
    .describe('Sort order: relevance | date'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum episodes to return (1–50, default 20)'),
});

// ── Family definition ────────────────────────────────────────────────────

const mediaFamily: FamilyDefinition = {
  name: 'media',
  description: 'Search media: podcast episodes via ListenNotes.',
  actions: [
    {
      name: 'podcast',
      description: 'Search podcast episodes via ListenNotes API',
      schema: podcastAction,
      handler: async (args, cfg) => {
        const { query, sort, limit } = args as {
          query: string;
          sort: 'relevance' | 'date';
          limit: number;
        };
        return podcastSearch(query, cfg.listennotes.apiKey ?? '', sort, limit);
      },
      configIssue: (cfg: SearchConfig) =>
        cfg.listennotes.apiKey
          ? null
          : 'Set LISTENNOTES_API_KEY env var (free tier at listennotes.com)',
    },
  ],
};

// ── Registration ────────────────────────────────────────────────────────────────

export function registerMediaTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, mediaFamily, cfg);
}

export function mediaCapabilities(cfg: SearchConfig) {
  return mediaFamily.actions.map((a) => ({
    name: `media.${a.name}`,
    available: a.configIssue?.(cfg) === null,
    issue: a.configIssue?.(cfg) ?? null,
  }));
}