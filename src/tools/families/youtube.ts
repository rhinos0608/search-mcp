/**
 * Consolidated YouTube tool family.
 *
 * Replaces three separate MCP tools (youtube_search, youtube_transcript,
 * semantic_youtube) with a single `youtube` tool using a discriminated union.
 *
 * Actions:
 *   search     — Search YouTube for videos (needs YOUTUBE_API_KEY)
 *   transcript — Get captions for a video (free, no key required)
 *   semantic   — Search + transcript + RAG ranking (needs key + embedding sidecar)
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../../semanticLimits.js';
import { compactSemanticResponse } from '../../utils/semanticResponse.js';
import { youtubeSearch } from '../youtubeSearch.js';
import { getYouTubeTranscript } from '../youtubeTranscript.js';
import { semanticYoutube } from '../semanticYoutube.js';
import { wrapResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Action schemas (discriminated on "action") ──────────────────────────────

const searchSchema = z.object({
  action: z.literal('search').describe('Search YouTube for videos'),
  query: z.string().describe('The search query string'),
  order: z
    .enum(['relevance', 'date', 'viewCount', 'rating'])
    .optional()
    .default('relevance')
    .describe('Sort order: relevance | date | viewCount | rating'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum number of videos to return (1–50, default 10)'),
});

const transcriptSchema = z.object({
  action: z.literal('transcript').describe('Get the transcript/captions for a video'),
  // Accept either videoId (ID only) or url (full YouTube URL) - both work
  videoId: z.string().optional().describe('YouTube video ID (the part after ?v=)'),
  url: z
    .url()
    .optional()
    .describe('Full YouTube URL (https://youtube.com/watch?v=... or youtu.be/...)'),
  language: z
    .string()
    .optional()
    .default('en')
    .describe('BCP-47 language code for the caption track (default "en")'),
});

const semanticSchema = z.object({
  action: z.literal('semantic').describe('Search + rank transcript passages by semantic relevance'),
  query: z
    .string()
    .describe('The semantic search query — what are you looking for in video content?'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum videos to fetch transcripts for (1–50, default 20)'),
  channel: z
    .string()
    .optional()
    .describe('Filter to videos from channels whose name contains this string (case-insensitive)'),
  sort: z
    .enum(['relevance', 'date', 'viewCount'])
    .optional()
    .default('relevance')
    .describe('Sort order for the initial video search: relevance | date | viewCount'),
  transcriptLanguage: z
    .string()
    .optional()
    .default('en')
    .describe('BCP-47 language code for captions (default "en")'),
  profile: z
    .enum(['balanced', 'fast', 'precision', 'recall'])
    .optional()
    .default('balanced')
    .describe('Retrieval profile: balanced | fast | precision | recall'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Number of most-relevant transcript passages to return (1–50, default 10)'),
});

// ── Family definition ───────────────────────────────────────────────────────

const youtubeFamily: FamilyDefinition = {
  name: 'youtube',
  description:
    'Search YouTube videos, fetch transcripts, or perform semantic search across video content. ' +
    'Use the `action` field to choose: "search" finds videos by keyword, "transcript" fetches ' +
    'captions for a known video, and "semantic" searches + transcripts + ranks passages by ' +
    'relevance to your query. The `transcript` action works without any API key.',
  actions: [
    {
      name: 'search',
      description: 'Search YouTube for videos matching a query',
      schema: searchSchema,
      handler: async (args, cfg) => {
        const { query, order, maxResults } = args as {
          query: string;
          order: 'relevance' | 'date' | 'viewCount' | 'rating';
          maxResults: number;
        };
        return youtubeSearch(query, cfg.youtube.apiKey ?? '', order, maxResults);
      },
      configIssue: (cfg) => {
        if (!cfg.youtube.apiKey) {
          return 'Set YOUTUBE_API_KEY (Google Cloud Console) to use youtube.search.';
        }
        return null;
      },
    },
    {
      name: 'transcript',
      description: 'Get the transcript/captions for a YouTube video',
      schema: transcriptSchema,
      handler: async (args) => {
        const { videoId, url, language } = args as {
          videoId?: string;
          url?: string;
          language: string;
        };

        // Support 'url' as alternative to 'videoId'
        let resolvedVideoId = videoId;
        if (!resolvedVideoId && url) {
          // Extract video ID from URL
          try {
            const parsed = new URL(url);
            if (parsed.hostname === 'youtu.be') {
              resolvedVideoId = parsed.pathname.slice(1);
            } else {
              resolvedVideoId = parsed.searchParams.get('v') ?? undefined;
            }
          } catch {
            // Invalid URL, leave undefined
          }
        }
        if (!resolvedVideoId) {
          throw new Error(
            'Missing video identifier: provide either `videoId` (ID only) or `url` (full YouTube URL)',
          );
        }
        return getYouTubeTranscript(resolvedVideoId, language);
      },
      // No configIssue — transcript is always available (free API)
    },
    {
      name: 'semantic',
      description:
        'Search YouTube for videos, fetch transcripts, and rank passages by relevance to a query',
      schema: semanticSchema,
      handler: async (args, cfg) => {
        const { query, maxVideos, channel, sort, transcriptLanguage, profile, topK } = args as {
          query: string;
          maxVideos: number;
          channel?: string;
          sort: 'relevance' | 'date' | 'viewCount';
          transcriptLanguage: string;
          profile: 'balanced' | 'fast' | 'precision' | 'recall';
          topK: number;
        };
        // Use server default for maxBytes
        const maxBytes = DEFAULT_SEMANTIC_MAX_BYTES;

        const data = await semanticYoutube({
          query,
          apiKey: cfg.youtube.apiKey ?? '',
          embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
          embeddingApiToken: cfg.embeddingSidecar.apiToken ?? '',
          embeddingDimensions: cfg.embeddingSidecar.dimensions,
          maxVideos,
          channel: channel ?? undefined,
          sort,
          transcriptLanguage,
          profile,
          topK,
          maxBytes,
        });

        const compacted = compactSemanticResponse(data);
        const warnings = data.warnings ?? [];
        return wrapResponse(compacted, warnings);
      },
      configIssue: (cfg) => {
        if (!cfg.youtube.apiKey) {
          return 'Set YOUTUBE_API_KEY (Google Cloud Console) to use youtube.semantic.';
        }
        if (!cfg.embeddingSidecar.baseUrl) {
          return 'Set EMBEDDING_SIDECAR_BASE_URL to use youtube.semantic (embedding sidecar required for ranking).';
        }
        return null;
      },
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerYoutubeTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, youtubeFamily, cfg);
}

/**
 * Action-level capability report for health checks.
 * Returns per-action availability with remediation hints.
 */
export function youtubeCapabilities(cfg: SearchConfig) {
  return youtubeFamily.actions.map((a) => ({
    name: `youtube.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
