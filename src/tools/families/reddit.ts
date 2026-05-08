/**
 * Consolidated Reddit tool family.
 *
 * Replaces three separate MCP tools (reddit_search, reddit_comments,
 * semantic_reddit) with a single `reddit` tool using a discriminated union.
 *
 * Actions:
 *   search    — Search Reddit posts (free, no auth required)
 *   comments  — Fetch a post's comment tree with clean post locator
 *   semantic  — Search + comments + RAG ranking (needs embedding sidecar)
 *
 * The `comments` action accepts multiple input formats for the `post` field:
 *   - Object form: { type: "url", url }, { type: "permalink", permalink }, { type: "id", subreddit, postId }
 *   - Simple string: "/r/sub/comments/id", full URL, or "subreddit/postId" (auto-coerced)
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../../semanticLimits.js';
import { compactSemanticResponse } from '../../utils/semanticResponse.js';
import { redditSearch } from '../redditSearch.js';
import { redditComments } from '../redditComments.js';
import { semanticReddit } from '../semanticReddit.js';
import { wrapResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Shared enums ────────────────────────────────────────────────────────────

const SORT_SEARCH = z.enum(['relevance', 'hot', 'top', 'new', 'comments']);
const SORT_COMMENTS = z.enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
const SORT_SEMANTIC = z.enum(['relevance', 'hot', 'new', 'top']);
const TIMEFRAME = z.enum(['hour', 'day', 'week', 'month', 'year', 'all']);

// ── Post locator - accepts both simple string and full discriminated union ─────────────────
// The union allows LLMs to pass simple strings that get auto-coerced.

const postLocatorSchema = z.discriminatedUnion('type', [
   z.object({
      type: z.literal('url').describe('Identify by full Reddit post URL'),
      url: z.url().describe('Full Reddit post URL (https://www.reddit.com/r/...)'),
   }),
   z.object({
      type: z.literal('permalink').describe('Identify by relative permalink path'),
      permalink: z.string().describe('Relative Reddit path starting with /r/{sub}/comments/{id}'),
   }),
   z.object({
      type: z.literal('id').describe('Identify by subreddit + post ID'),
      subreddit: z
         .string()
         .regex(/^[A-Za-z0-9_]{1,21}$/)
         .describe('Subreddit name (without r/ prefix)'),
      postId: z
         .string()
         .regex(/^[A-Za-z0-9]+$/)
         .describe('Post ID (without t3_ prefix)'),
   }),
]);

// Simple string post identifier - gets coerced to postLocatorSchema
// Formats: "/r/sub/comments/id", "https://www.reddit.com/r/...", or "sub/id"
// Also handles JSON strings like '{"permalink": "/r/..."}' from LLMs
const simplePostLocator = z
   .string()
   .describe(
      'Simple Reddit post identifier (auto-coerced). ' +
      'Formats: permalink path ("/r/sub/comments/id"), full URL, or "subreddit/postId" form.',
   )
   .transform((val) => {
      let input = val.trim();

      // Handle double-encoded JSON string from LLMs: '{"permalink": "/r/..."}'
      if (input.startsWith('{') && input.endsWith('}')) {
         try {
            const parsed = JSON.parse(input);
            if (parsed.url) input = parsed.url;
            else if (parsed.permalink) input = parsed.permalink;
            else if (parsed.subreddit && parsed.postId) input = `${parsed.subreddit}/${parsed.postId}`;
         } catch {
            // Not JSON, continue with original value
         }
      }

      // Detect format and convert to discriminated union
      if (input.startsWith('http://') || input.startsWith('https://')) {
         return { type: 'url' as const, url: input };
      }
      if (input.startsWith('/r/')) {
         return { type: 'permalink' as const, permalink: input };
      }
      // Try "subreddit/postId" format
      const parts = input.split('/');
      if (parts.length === 2 && parts[0] && parts[1]) {
         const [subreddit, postId] = parts;
         // Validate subreddit name
         if (/^[A-Za-z0-9_]{1,21}$/.test(subreddit) && /^[A-Za-z0-9]+$/.test(postId)) {
            return { type: 'id' as const, subreddit, postId };
         }
      }
      // Default to permalink (most common user input)
      return { type: 'permalink' as const, permalink: input };
   });

// Combined: accepts either full object OR simple string (auto-coerced)
const unifiedPostLocator = z
   .union([postLocatorSchema, simplePostLocator])
   .describe(
      'Reddit post identifier. Accepts object form {type:"url",url:...} or simple string (permalink/URL/subreddit-postId).',
   );

// ── Action schemas ──────────────────────────────────────────────────────────

const searchSchema = z.object({
   action: z.literal('search').describe('Search Reddit for posts'),
   query: z.string().describe('The search query string'),
   subreddit: z
      .string()
      .optional()
      .default('')
      .describe(
         'Restrict to this subreddit (without r/ prefix). Strongly recommended — global Reddit search has poor relevance.',
      ),
   sort: SORT_SEARCH.optional().default('relevance').describe('Sort order'),
   timeframe: TIMEFRAME.optional().default('year').describe('Time window'),
   limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(25)
      .describe('Maximum posts to return (1–100, default 25)'),
});

const commentsSchema = z.object({
   action: z.literal('comments').describe('Fetch a Reddit post and its comment tree'),
   // Accept either 'post' (preferred) or 'url' (common LLM mistake) — normalize to post locator
   post: unifiedPostLocator.optional(),
   url: z
      .string()
      .url()
      .optional()
      .describe('Reddit post URL (alternative to post field, auto-converted to post locator)'),
   comment: z
      .string()
      .regex(/^[A-Za-z0-9]+$/)
      .optional()
      .describe('Comment ID (no t1_ prefix) to focus on a subthread'),
   context: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe(
         'Number of parent comments above the focused comment (0–8). Only valid with `comment`.',
      ),
   sort: SORT_COMMENTS.optional().default('confidence').describe('Comment sort order'),
   depth: z.number().int().min(1).max(10).optional().describe('Maximum nesting depth (1–10)'),
   limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum comment nodes to return (1–100)'),
   showMore: z
      .boolean()
      .optional()
      .default(false)
      .describe(
         'When true, inline "more" placeholders in the comment tree; when false, surface them in `more` metadata.',
      ),
});

const semanticSchema = z.object({
   action: z.literal('semantic').describe('Search + rank comment passages by semantic relevance'),
   query: z.string().describe('The semantic search query — what are you looking for in comments?'),
   subreddit: z
      .string()
      .optional()
      .default('')
      .describe('Restrict search to this subreddit (without r/ prefix)'),
   sort: SORT_SEMANTIC.optional().default('relevance').describe('Sort order for post search'),
   timeframe: TIMEFRAME.optional().default('year').describe('Time window for post search'),
   maxPosts: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .default(10)
      .describe('Maximum posts to fetch comments for (1–25, default 10)'),
   commentLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(100)
      .describe('Maximum comments to fetch per post (1–100, default 100)'),
   profile: z
      .enum(['balanced', 'fast', 'precision', 'recall'])
      .optional()
      .default('balanced')
      .describe('Retrieval profile'),
   topK: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe('Number of most-relevant comment passages to return (1–50, default 10)'),
   maxBytes: z
      .number()
      .int()
      .min(1)
      .max(DEFAULT_SEMANTIC_MAX_BYTES)
      .optional()
      .default(DEFAULT_SEMANTIC_MAX_BYTES)
      .describe('Maximum bytes of comment content to embed (1–250MB, default 250MB)'),
});

// ── Family definition ───────────────────────────────────────────────────────

const redditFamily: FamilyDefinition = {
   name: 'reddit',
   description:
      'Search Reddit, browse comment threads, or perform semantic search across comments. ' +
      'Use `search` to find posts by keyword, `comments` to read a thread (with a clean ' +
      'post locator: URL, permalink, or subreddit+ID), and `semantic` to find relevant ' +
      'comment passages across multiple posts. All actions work without authentication.',
   actions: [
      {
         name: 'search',
         description: 'Search Reddit for posts matching a query',
         schema: searchSchema,
         handler: async (args, _cfg) => {
            void _cfg;
            const { query, subreddit, sort, timeframe, limit } = args as {
               query: string;
               subreddit: string;
               sort: 'relevance' | 'hot' | 'top' | 'new' | 'comments';
               timeframe: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
               limit: number;
            };
            return redditSearch(query, subreddit, sort, timeframe, limit);
         },
         // No configIssue — works with public Reddit API, no key needed
      },
      {
         name: 'comments',
         description: 'Fetch a Reddit post and its comment tree',
         schema: commentsSchema,
         handler: async (args, _cfg) => {
            void _cfg;
            const { post, url, comment, context, sort, depth, limit, showMore } = args as {
               post?:
               | { type: 'url'; url: string }
               | { type: 'permalink'; permalink: string }
               | { type: 'id'; subreddit: string; postId: string };
               url?: string;
               comment?: string;
               context?: number;
               sort: 'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa';
               depth?: number;
               limit?: number;
               showMore: boolean;
            };

            // Support 'url' as an alternative to 'post' (common LLM mistake)
            let resolvedPost = post;
            if (!resolvedPost && url) {
               resolvedPost = { type: 'url' as const, url };
            }
            if (!resolvedPost) {
               throw new Error(
                  'Missing post identifier: provide either `post` (object with type+url/permalink/id) or `url` (full Reddit URL)',
               );
            }

            // Convert the discriminated post locator to the flat RedditThreadLocatorInput
            let locator: Record<string, string | undefined>;
            switch (resolvedPost.type) {
               case 'url':
                  locator = { url: resolvedPost.url };
                  break;
               case 'permalink':
                  locator = { permalink: resolvedPost.permalink };
                  break;
               case 'id':
                  locator = { subreddit: resolvedPost.subreddit, article: resolvedPost.postId };
                  break;
            }

            return redditComments({
               ...locator,
               ...(comment !== undefined ? { comment } : {}),
               ...(context !== undefined ? { context } : {}),
               sort,
               ...(depth !== undefined ? { depth } : {}),
               ...(limit !== undefined ? { limit } : {}),
               showMore,
            });
         },
         // No configIssue — works with public Reddit API, no key needed
      },
      {
         name: 'semantic',
         description:
            'Search Reddit for posts, fetch comments, and rank passages by relevance to a query',
         schema: semanticSchema,
         handler: async (args, cfg) => {
            const {
               query,
               subreddit,
               sort,
               timeframe,
               maxPosts,
               commentLimit,
               profile,
               topK,
               maxBytes,
            } = args as {
               query: string;
               subreddit: string;
               sort: 'relevance' | 'hot' | 'new' | 'top';
               timeframe: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
               maxPosts: number;
               commentLimit: number;
               profile: 'balanced' | 'fast' | 'precision' | 'recall';
               topK: number;
               maxBytes: number;
            };

            const data = await semanticReddit({
               query,
               subreddit: subreddit || undefined,
               sort,
               timeframe,
               maxPosts,
               commentLimit,
               embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
               embeddingApiToken: cfg.embeddingSidecar.apiToken ?? '',
               embeddingDimensions: cfg.embeddingSidecar.dimensions,
               profile,
               topK,
               maxBytes,
            });

            const compacted = compactSemanticResponse(data);
            const warnings = data.warnings ?? [];
            return wrapResponse(compacted, warnings);
         },
         configIssue: (cfg) => {
            if (!cfg.embeddingSidecar.baseUrl) {
               return 'Set EMBEDDING_SIDECAR_BASE_URL to use reddit.semantic (embedding sidecar required for ranking).';
            }
            return null;
         },
      },
   ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerRedditTool(server: McpServer, cfg: SearchConfig): void {
   registerFamily(server, redditFamily, cfg);
}

export function redditCapabilities(cfg: SearchConfig) {
   return redditFamily.actions.map((a) => ({
      name: `reddit_${a.name}`,
      available: a.configIssue ? a.configIssue(cfg) === null : true,
      issue: a.configIssue ? a.configIssue(cfg) : null,
   }));
}
