/**
 * Consolidated research/developer forum tools family.
 *
 * Replaces academic_search, arxiv_search, hackernews_search, and
 * stackoverflow_search with a single `research` tool.
 *
 * Actions:
 *   academic       — Search across ALL available research backends with parallel fan-out
 *   arxiv          — Fast, direct search of ArXiv papers with full date/category filters
 *   hackernews     — Search Hacker News via Algolia
 *   stackoverflow  — Search Stack Overflow questions
 *   pubmed         — Search biomedical literature on PubMed
 *   wikipedia      — Search Wikipedia for background knowledge
 *   openalex       — Search OpenAlex scholarly works (free, no key)
 *   crossref       — Search Crossref DOI metadata (free, no key)
 *   datacite       — Search DataCite research data DOIs (free, no key)
 *   ror            — Look up research organizations via ROR (free, no key)
 *   semantic_scholar — Direct Semantic Scholar paper search (free, no key)
 *   gdelt          — Search GDELT global news/events (free, no key)
 *   wikidata       — Search Wikidata structured entities (free, no key)
 *
 * Most actions are free and work without API keys (Stack Overflow benefits
 * from STACKEXCHANGE_API_KEY for higher rate limits).
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { academicSearch } from '../academicSearch.js';
import { arxivSearch } from '../arxivSearch.js';
import { hackernewsSearch } from '../hackernewsSearch.js';
import { stackoverflowSearch } from '../stackoverflowSearch.js';
import { searchPubMed } from '../pubmedSearch.js';
import { searchWikipedia } from '../wikipediaSearch.js';
import { searchOpenAlex } from '../openalexSearch.js';
import { searchCrossref } from '../crossrefSearch.js';
import { searchDataCite } from '../dataciteSearch.js';
import { searchRor } from '../rorSearch.js';
import { searchSemanticScholar } from '../semanticScholarSearch.js';
import { searchGdelt } from '../gdeltSearch.js';
import { searchWikidata } from '../wikidataSearch.js';
import { wrapResponse } from '../response.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── Action schemas ──────────────────────────────────────────────────────────

const academicAction = z.object({
  action: z
    .literal('academic')
    .describe(
      'Search across all available research backends (ArXiv, Semantic Scholar, OpenAlex, Crossref, PubMed, Wikipedia, Hacker News, Stack Overflow, DataCite, ROR, GDELT, Wikidata)',
    ),
  query: z.string().describe('The search query string'),
  source: z
    .enum([
      'all',
      'arxiv',
      'semantic_scholar',
      'openalex',
      'crossref',
      'pubmed',
      'wikipedia',
      'hackernews',
      'stackoverflow',
      'datacite',
      'ror',
      'gdelt',
      'wikidata',
    ])
    .optional()
    .default('all')
    .describe(
      'Backend to query. "all" fans out to every available backend in parallel and merges results. Individual backends can be selected for faster targeted searches.',
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
  language: z.string().optional().default('en').describe('Language code (e.g. "en", "es", "fr")'),
});

const openalexAction = z.object({
  action: z.literal('openalex').describe('Search OpenAlex scholarly works'),
  query: z.string().describe('The search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (1–50, default 20)'),
});

const crossrefAction = z.object({
  action: z.literal('crossref').describe('Search Crossref DOI metadata'),
  query: z.string().describe('The search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (1–50, default 20)'),
});

const dataciteAction = z.object({
  action: z.literal('datacite').describe('Search DataCite research data DOIs'),
  query: z.string().describe('The search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (1–50, default 20)'),
});

const rorAction = z.object({
  action: z.literal('ror').describe('Look up research organizations via ROR'),
  query: z.string().describe('Organization name to look up'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(10)
    .describe('Maximum results (1–20, default 10)'),
});

const semanticScholarAction = z.object({
  action: z.literal('semantic_scholar').describe('Direct Semantic Scholar paper search'),
  query: z.string().describe('The search query string'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum papers (1–50, default 20)'),
});

const gdeltAction = z.object({
  action: z.literal('gdelt').describe('Search GDELT global news/events'),
  query: z.string().describe('The search query string'),
  timespan: z
    .enum(['1d', '7d', '30d', '6m', '1y'])
    .optional()
    .default('30d')
    .describe('Timespan: 1d | 7d | 30d | 6m | 1y'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (1–50, default 20)'),
});

const wikidataAction = z.object({
  action: z.literal('wikidata').describe('Search Wikidata structured entities'),
  query: z.string().describe('The search query string'),
  language: z.string().optional().default('en').describe('Language code (e.g. en, es, fr)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (1–50, default 20)'),
});

// ── Family definition ───────────────────────────────────────────────────────

const researchFamily: FamilyDefinition = {
  name: 'research',
  description:
    'Search academic, news, and public-data sources: ArXiv, Semantic Scholar, OpenAlex, Crossref, DataCite, ROR, GDELT, Wikidata, PubMed, Wikipedia, Hacker News, and Stack Overflow. ' +
    'Choose the `action` field to select the source.',
  actions: [
    {
      name: 'academic',
      description:
        'Search across all available research backends (ArXiv, Semantic Scholar, OpenAlex, Crossref, PubMed, Wikipedia, HN, SO, DataCite, ROR, GDELT, Wikidata) with parallel fan-out',
      schema: academicAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, source, limit, yearFrom } = args as {
          query: string;
          source:
            | 'all'
            | 'arxiv'
            | 'semantic_scholar'
            | 'openalex'
            | 'crossref'
            | 'pubmed'
            | 'wikipedia'
            | 'hackernews'
            | 'stackoverflow'
            | 'datacite'
            | 'ror'
            | 'gdelt'
            | 'wikidata';
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
    {
      name: 'openalex',
      description: 'Search OpenAlex scholarly works (papers, authors, venues)',
      schema: openalexAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchOpenAlex(query, limit);
      },
    },
    {
      name: 'crossref',
      description: 'Search Crossref DOI metadata (journal articles, books, proceedings)',
      schema: crossrefAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchCrossref(query, limit);
      },
    },
    {
      name: 'datacite',
      description: 'Search DataCite research data DOIs with relation graph',
      schema: dataciteAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchDataCite(query, limit);
      },
    },
    {
      name: 'ror',
      description: 'Look up research organizations via the ROR registry',
      schema: rorAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchRor(query, limit);
      },
    },
    {
      name: 'semantic_scholar',
      description: 'Direct Semantic Scholar paper search (independent of academic action)',
      schema: semanticScholarAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, limit } = args as { query: string; limit: number };
        return searchSemanticScholar(query, limit);
      },
    },
    {
      name: 'gdelt',
      description: 'Search GDELT global news and events database',
      schema: gdeltAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, timespan, limit } = args as {
          query: string;
          timespan: string;
          limit: number;
        };
        return searchGdelt(query, timespan, limit);
      },
    },
    {
      name: 'wikidata',
      description: 'Search Wikidata for structured entity data',
      schema: wikidataAction,
      handler: async (args, _cfg) => {
        void _cfg;
        const { query, language, limit } = args as {
          query: string;
          language: string;
          limit: number;
        };
        return searchWikidata(query, language, limit);
      },
    },
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerResearchTool(server: McpServer, cfg: SearchConfig, kgHook?: KnowledgeGraphHook): void {
  registerFamily(server, researchFamily, cfg, kgHook);
}

export function researchCapabilities(cfg: SearchConfig) {
  return researchFamily.actions.map((a) => ({
    name: `research.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
