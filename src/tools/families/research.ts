/**
 * Consolidated research/developer forum tools family.
 *
 * Replaces academic_search, arxiv_search, hackernews_search, and
 * stackoverflow_search with a single `research` tool.
 *
 * Actions:
 *   academic      — Search academic papers via ArXiv + Semantic Scholar (with cross-fallback)
 *   arxiv         — Fast, direct search of ArXiv papers with full date/category filters
 *   hackernews    — Search Hacker News via Algolia
 *   stackoverflow — Search Stack Overflow questions
 *   pubmed       — Search biomedical literature on PubMed
 *   wikipedia    — Search Wikipedia for background knowledge
 *
 * All actions are free and work without API keys (Stack Overflow benefits
 * from STACKEXCHANGE_API_KEY for higher rate limits).
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { academicSearch } from '../academicSearch.js';
import { arxivSearch } from '../arxivSearch.js';
import { hackernewsSearch } from '../hackernewsSearch.js';
import { stackoverflowSearch } from '../stackoverflowSearch.js';
import { searchPubMed } from '../pubmedSearch.js';
import { searchWikipedia } from '../wikipediaSearch.js';
import { wrapResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Action schemas ──────────────────────────────────────────────────────────

const academicAction = z.object({
  action: z.literal('academic').describe('Search academic papers via ArXiv and Semantic Scholar'),
  query: z.string().describe('The search query string'),
  source: z
    .enum(['all', 'arxiv', 'semantic_scholar'])
    .optional()
    .default('all')
    .describe(
      'Backend: all (both, merged), arxiv, or semantic_scholar (default all). Falls back to the other backend if one fails.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum papers to return (1–50, default 20)'),
  yearFrom: z
    .number()
    .int()
    .min(1900)
    .max(2099)
    .optional()
    .describe('Earliest publication year filter'),
});

const arxivAction = z.object({
  action: z.literal('arxiv').describe('Fast, direct search of ArXiv papers'),
  query: z.string().describe('Search query string'),
  category: z
    .string()
    .optional()
    .describe(
      'ArXiv category filter (e.g. "cs.AI", "cs.LG", "math.CO"). Leave empty for all categories.',
    ),
  sortBy: z
    .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
    .optional()
    .default('relevance')
    .describe('Sort order'),
  dateFrom: z.string().optional().describe('Start date (YYYY-MM-DD). Filters by submission date.'),
  dateTo: z.string().optional().describe('End date (YYYY-MM-DD). Filters by submission date.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum papers to return (1–50, default 20)'),
});

const hackernewsAction = z.object({
  action: z.literal('hackernews').describe('Search Hacker News via Algolia'),
  query: z.string().describe('Search query string'),
  type: z
    .enum(['story', 'comment', 'all'])
    .optional()
    .default('story')
    .describe('Result type: story | comment | all'),
  sort: z
    .enum(['relevance', 'date'])
    .optional()
    .default('relevance')
    .describe('Sort order: relevance or date'),
  dateFrom: z
    .string()
    .optional()
    .describe('Start date (ISO 8601, e.g. "2025-01-01"). Filters by creation date.'),
  dateTo: z
    .string()
    .optional()
    .describe('End date (ISO 8601, e.g. "2025-12-31"). Filters by creation date.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum results to return (1–100, default 20)'),
});

const stackoverflowAction = z.object({
  action: z.literal('stackoverflow').describe('Search Stack Overflow questions'),
  query: z.string().describe('Search query string'),
  sort: z
    .enum(['relevance', 'votes', 'creation', 'activity'])
    .optional()
    .default('relevance')
    .describe('Sort order'),
  tagged: z
    .string()
    .optional()
    .default('')
    .describe('Semicolon-separated tags (e.g. "javascript;react")'),
  accepted: z
    .boolean()
    .optional()
    .default(false)
    .describe('Only return questions with accepted answers'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum questions to return (1–100, default 20)'),
});

const pubmedAction = z.object({
  action: z.literal('pubmed').describe('Search biomedical literature on PubMed'),
  query: z.string().describe('The search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .default(10)
    .describe('Maximum papers to return (1–30, default 10)'),
});

const wikipediaAction = z.object({
  action: z.literal('wikipedia').describe('Search Wikipedia for background knowledge'),
  query: z.string().describe('The search query string'),
  language: z
    .string()
    .optional()
    .default('en')
    .describe('Language code (e.g. "en", "es", "fr")'),
});

// ── Family definition ───────────────────────────────────────────────────────

const researchFamily: FamilyDefinition = {
  name: 'research',
  description:
    'Search academic/research sources: ArXiv, Semantic Scholar, PubMed, Wikipedia, Hacker News, and Stack Overflow. ' +
    'Choose the `action` field to select the source.',
  actions: [
    {
      name: 'academic',
      description: 'Search academic papers via ArXiv and Semantic Scholar with automatic fallback',
      schema: academicAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, source, limit, yearFrom } = args as {
          query: string;
          source: 'all' | 'arxiv' | 'semantic_scholar';
          limit: number;
          yearFrom?: number;
        };
        const result = await academicSearch(query, source, limit, yearFrom ?? null);
        return wrapResponse(result.papers, result.warnings);
      },
    },
    {
      name: 'arxiv',
      description: 'Fast, direct search of ArXiv papers with category and date filtering',
      schema: arxivAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, category, sortBy, dateFrom, dateTo, limit } = args as {
          query: string;
          category?: string;
          sortBy: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
          dateFrom?: string;
          dateTo?: string;
          limit: number;
        };
        return arxivSearch(
          query,
          category ?? null,
          sortBy,
          dateFrom ?? null,
          dateTo ?? null,
          limit,
        );
      },
    },
    {
      name: 'hackernews',
      description: 'Search Hacker News stories and comments via Algolia',
      schema: hackernewsAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, type, sort, dateFrom, dateTo, limit } = args as {
          query: string;
          type: 'story' | 'comment' | 'all';
          sort: 'relevance' | 'date';
          dateFrom?: string;
          dateTo?: string;
          limit: number;
        };
        const dateRange =
          dateFrom !== undefined || dateTo !== undefined
            ? {
                ...(dateFrom !== undefined ? { from: dateFrom } : {}),
                ...(dateTo !== undefined ? { to: dateTo } : {}),
              }
            : null;
        return hackernewsSearch(query, type, sort, dateRange, limit);
      },
    },
    {
      name: 'stackoverflow',
      description: 'Search Stack Overflow questions with tag and accepted-answer filtering',
      schema: stackoverflowAction,
      handler: async (args, cfg) => {
        const { query, sort, tagged, accepted, limit } = args as {
          query: string;
          sort: 'relevance' | 'votes' | 'creation' | 'activity';
          tagged: string;
          accepted: boolean;
          limit: number;
        };
        return stackoverflowSearch(
          query,
          cfg.stackexchange.apiKey ?? '',
          sort,
          tagged,
          accepted,
          limit,
        );
      },
      configIssue: (cfg) => {
        if (!cfg.stackexchange.apiKey) {
          return 'Without STACKEXCHANGE_API_KEY, limited to 300 requests/day (shared IP quota). Set STACKEXCHANGE_API_KEY for 10,000 requests/day.';
        }
        return null;
      },
    },
    {
      name: 'pubmed',
      description: 'Search biomedical literature on PubMed',
      schema: pubmedAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchPubMed(query, limit);
      },
    },
    {
      name: 'wikipedia',
      description: 'Search Wikipedia for encyclopedia articles',
      schema: wikipediaAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, language } = args as { query: string; language: string };
        return searchWikipedia(query, language);
      },
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerResearchTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, researchFamily, cfg);
}

export function researchCapabilities(cfg: SearchConfig) {
  return researchFamily.actions.map((a) => ({
    name: `research_${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}