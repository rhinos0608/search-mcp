/**
 * AgentTools — tool definitions for the ReAct agent.
 *
 * Delegates to the existing `createResearchTools()` factory which already wraps
 * all backend implementations with proper error handling. The agent formats
 * results for LLM consumption and assigns citation indices.
 */

import { loadConfig } from '../../config.js';
import type { CitationCollector } from '../citationCollector.js';
import type { StrategyContext } from './types.js';
import type { ResearchTools } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  error?: string;
}

// ── Tool builder ─────────────────────────────────────────────────────────

export function buildAgentTools(ctx: StrategyContext, collector: CitationCollector): AgentTool[] {
  const tools: AgentTool[] = [];
  const cfg = loadConfig();

  // Lazily created on first use to avoid loading all backends at startup
  let _researchTools: ResearchTools | null = null;
  const getTools = async (): Promise<ResearchTools> => {
    if (!_researchTools) {
      // Dynamically import to avoid circular dependency at top-level
      const { createResearchTools } = await import('../researchTools.js');
      _researchTools = createResearchTools();
    }
    return _researchTools;
  };

  // Web search — always if any backend configured
  if (cfg.searchBackend.length > 0) {
    tools.push(createWebSearchTool(getTools, collector));
  }

  // Free, no-key tools
  tools.push(createArxivSearchTool(collector));
  tools.push(createSemanticScholarTool(collector));
  tools.push(createHackerNewsTool(getTools, collector));
  tools.push(createStackExchangeTool(collector));

  // Multi-backend academic search (fans out to all research backends)
  tools.push(createAcademicSearchTool(collector));

  // Free standalone tools (PubMed, Wikipedia — no API key needed)
  tools.push(createPubMedSearchTool(collector));
  tools.push(createWikipediaSearchTool(collector));

  // Free academic/discovery backends
  tools.push(createOpenAlexSearchTool(collector));
  tools.push(createCrossrefSearchTool(collector));
  tools.push(createDataCiteSearchTool(collector));
  tools.push(createRorSearchTool(collector));
  tools.push(createGdeltSearchTool(collector));
  tools.push(createWikidataSearchTool(collector));

  // Conditional
  if ((cfg.github.token ?? '').length > 0) {
    tools.push(createGitHubSearchTool(getTools, collector));
  }

  if ((cfg.reddit.clientId ?? '').length > 0) {
    tools.push(createRedditSearchTool(getTools, collector));
  }

  // YouTube — needs an API key
  if ((cfg.youtube.apiKey ?? '').length > 0) {
    tools.push(createYouTubeSearchTool(getTools, collector));
  }

  // Fetch page — needs Crawl4AI
  if (cfg.crawl4ai.baseUrl.length > 0) {
    tools.push(createFetchPageTool(getTools, collector));
  }

  // research_subtopic — needs LLM for decomposition
  if (ctx.llm) {
    tools.push(createResearchSubtopicTool(ctx, collector));
  }

  return tools;
}

/** Format tool descriptions for the system prompt. */
export function describeTools(tools: AgentTool[]): string {
  return tools
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `  ${k}${v.required ? ' (required)' : ''}: ${v.description}`)
        .join('\n');
      return `${t.name}: ${t.description}\n${params}`;
    })
    .join('\n\n');
}

// ── Individual tool factories ───────────────────────────────────────────

function createWebSearchTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'search_web',
    description:
      'Search the web for general information. Best for current events, factual questions, and broad topics.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const results = await (await getTools()).webSearch(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.url, snippet: r.description })),
          'web',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.description}`)
          .join('\n\n');
        return { content: text || 'No results found.' };
      } catch (err) {
        return {
          content: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createArxivSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_arxiv',
    description:
      'Search scientific papers on arXiv. Best for physics, math, CS, and quantitative biology preprints. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { arxivSearch } = await import('../../tools/arxivSearch.js');
        const results = await arxivSearch(query, null, 'relevance', null, null, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.url, snippet: r.abstract })),
          'arxiv',
        );
        const text = results
          .map(
            (r, i) =>
              `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.abstract}${r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : ''}`,
          )
          .join('\n\n');
        return { content: text || 'No arXiv results found.' };
      } catch (err) {
        return {
          content: `arXiv search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createSemanticScholarTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_semantic_scholar',
    description:
      'Search academic papers on Semantic Scholar. Best for scientific literature with citation counts and impact analysis.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { academicSearch } = await import('../../tools/academicSearch.js');
        const result = await academicSearch(query, 'semantic_scholar', limit);
        const startIdx = collector.addResults(
          result.papers.map((r) => ({ title: r.title, link: r.url, snippet: r.abstract })),
          'semantic_scholar',
        );
        const text = result.papers
          .map(
            (r, i) =>
              `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.abstract}${r.year ? ` (${String(r.year)})` : ''}`,
          )
          .join('\n\n');
        return { content: text || 'No Semantic Scholar results found.' };
      } catch (err) {
        return {
          content: `Semantic Scholar search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createHackerNewsTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'search_hackernews',
    description:
      'Search Hacker News for tech news and discussion. Best for technology trends and startup ecosystem insights.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const results = await (await getTools()).hackernewsSearch(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.url, snippet: r.text })),
          'hackernews',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.text ?? ''}`)
          .join('\n\n');
        return { content: text || 'No Hacker News results found.' };
      } catch (err) {
        return {
          content: `HN search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createGitHubSearchTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'search_github',
    description:
      'Search GitHub repositories and code. Best for implementation examples, source code, and repository discovery.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const results = await (await getTools()).githubSearch(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.fullName, link: r.htmlUrl, snippet: r.description })),
          'github',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.fullName}\n${r.htmlUrl}\n${r.description}`)
          .join('\n\n');
        return { content: text || 'No GitHub results found.' };
      } catch (err) {
        return {
          content: `GitHub search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createStackExchangeTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_stackexchange',
    description:
      'Search Stack Overflow/Stack Exchange for technical Q&A. Best for programming, engineering, and technical problem-solving.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        // Stackoverflow search is available via the research family but not directly
        // in ResearchTools. Use dynamic import as fallback.
        const { stackoverflowSearch } = await import('../../tools/stackoverflowSearch.js');
        // Cast to unknown first to avoid unsafe any
        const rawResults = await (
          stackoverflowSearch as (
            q: string,
            key: string,
            s: string,
            t: string,
            a: boolean,
            l: number,
          ) => Promise<unknown>
        )(
          query,
          '', // apiKey
          'relevance',
          '', // tagged
          false, // accepted
          limit,
        );

        interface SOResult {
          title?: string;
          question_title?: string;
          link?: string;
          url?: string;
          snippet?: string;
          body?: string;
        }

        const results = Array.isArray(rawResults) ? (rawResults as SOResult[]) : [];
        const normalized = results.map((r) => ({
          title: r.title ?? r.question_title ?? 'Untitled',
          link: r.link ?? r.url ?? '',
          snippet: r.snippet ?? r.body ?? '',
        }));

        const startIdx = collector.addResults(normalized, 'stackoverflow');
        const text = normalized
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No Stack Overflow results found.' };
      } catch (err) {
        return {
          content: `StackExchange search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createRedditSearchTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'search_reddit',
    description:
      'Search Reddit for community discussions, opinions, and real user experiences. Searches all of Reddit by default; pass a subreddit to narrow the search.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      subreddit: {
        type: 'string',
        description:
          'Optional subreddit to narrow the search (without r/ prefix). Omit to search all of Reddit.',
      },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      // Default to r/all so the agent can search across all of Reddit without guessing a subreddit.
      const subreddit =
        typeof args.subreddit === 'string' && args.subreddit.trim().length > 0
          ? args.subreddit.trim()
          : 'all';
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        // ResearchTools.redditSearch takes (query, limit, subreddit) to match the ResearchTools interface;
        // limit is passed second (positional) and subreddit third.
        const tools = await getTools();
        const results = await tools.redditSearch(query, limit, subreddit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.url, snippet: r.selftext })),
          'reddit',
        );
        const text = results
          .map(
            (r, i) =>
              `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.selftext?.slice(0, 300) ?? ''}`,
          )
          .join('\n\n');
        return { content: text || 'No Reddit results found.' };
      } catch (err) {
        return {
          content: `Reddit search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createYouTubeSearchTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'search_youtube',
    description:
      'Search YouTube for videos. Best for tutorials, talks, demos, interviews, and first-hand walkthroughs.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const results = await (await getTools()).youtubeSearch(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({
            title: r.title,
            link: r.url,
            snippet: `${r.channelTitle}${r.publishedAt ? ` — ${r.publishedAt.slice(0, 10)}` : ''}`,
          })),
          'youtube',
        );
        const text = results
          .map(
            (r, i) =>
              `[${String(startIdx + i)}] ${r.title}\n${r.url}\n${r.channelTitle}${r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : ''}`,
          )
          .join('\n\n');
        return { content: text || 'No YouTube results found.' };
      } catch (err) {
        return {
          content: `YouTube search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createFetchPageTool(
  getTools: () => Promise<ResearchTools>,
  collector: CitationCollector,
): AgentTool {
  return {
    name: 'fetch_page',
    description:
      'Fetch and read the full content of a web page. Use when you need to read a specific source in detail.',
    parameters: {
      url: { type: 'string', description: 'The URL to fetch', required: true },
    },
    execute: async (args) => {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) return { content: 'Error: url is required', error: 'missing url' };

      try {
        const pages = await (await getTools()).webCrawl(url, 1);
        const page = pages[0];
        if (!page) {
          return { content: `No content extracted from ${url}`, error: 'empty page' };
        }
        const content = page.markdown.slice(0, 12000);

        collector.addResults(
          [{ title: page.title, link: url, snippet: content.slice(0, 300) }],
          'web',
        );

        return { content: `[Page: ${page.title}]\n${url}\n\n${content}` };
      } catch (err) {
        return {
          content: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
          error: 'fetch failed',
        };
      }
    },
  };
}

function createPubMedSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_pubmed',
    description:
      'Search biomedical literature on PubMed. Best for medical, biology, and life sciences research. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchPubMed } = await import('../../tools/pubmedSearch.js');
        const results = await searchPubMed(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'pubmed',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No PubMed results found.' };
      } catch (err) {
        return {
          content: `PubMed search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createWikipediaSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_wikipedia',
    description:
      'Search Wikipedia for encyclopedia articles. Best for background knowledge, definitions, and fact verification. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };

      try {
        const { searchWikipedia } = await import('../../tools/wikipediaSearch.js');
        const results = await searchWikipedia(query);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'wikipedia',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No Wikipedia results found.' };
      } catch (err) {
        return {
          content: `Wikipedia search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

// ── Multi-backend academic ────────────────────────────────────────────

function createAcademicSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_academic',
    description:
      'Search across ALL available research backends (ArXiv, Semantic Scholar, OpenAlex, Crossref, PubMed, Wikipedia, HN, SO, DataCite, ROR, GDELT, Wikidata) in parallel. Best for comprehensive literature and cross-disciplinary searches.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { academicSearch } = await import('../../tools/academicSearch.js');
        const result = await academicSearch(query, 'all', limit);
        const startIdx = collector.addResults(
          result.papers.map((r) => ({ title: r.title, link: r.url, snippet: r.abstract })),
          'academic',
        );
        const text = result.papers
          .map(
            (r, i) =>
              `[${String(startIdx + i)}] [${r.source}] ${r.title}\n${r.url}\n${r.abstract}${r.year ? ` (${String(r.year)})` : ''}`,
          )
          .join('\n\n');
        return { content: text || 'No academic results found.' };
      } catch (err) {
        return {
          content: `Academic search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

// ── Free academic/discovery backends ────────────────────────────────────

function createOpenAlexSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_openalex',
    description:
      'Search OpenAlex scholarly works index (papers, authors, venues). Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchOpenAlex } = await import('../../tools/openalexSearch.js');
        const results = await searchOpenAlex(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'openalex',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No OpenAlex results found.' };
      } catch (err) {
        return {
          content: `OpenAlex search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createCrossrefSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_crossref',
    description:
      'Search Crossref for DOIs, journal articles, and citation metadata. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchCrossref } = await import('../../tools/crossrefSearch.js');
        const results = await searchCrossref(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'crossref',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No Crossref results found.' };
      } catch (err) {
        return {
          content: `Crossref search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createDataCiteSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_datacite',
    description: 'Search DataCite for research datasets and data DOIs. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchDataCite } = await import('../../tools/dataciteSearch.js');
        const results = await searchDataCite(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'datacite',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No DataCite results found.' };
      } catch (err) {
        return {
          content: `DataCite search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createRorSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_ror',
    description: 'Look up research organizations in the ROR registry. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'Organization name to look up', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchRor } = await import('../../tools/rorSearch.js');
        const results = await searchRor(query, limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'ror',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No ROR results found.' };
      } catch (err) {
        return {
          content: `ROR search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createGdeltSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_gdelt',
    description: 'Search GDELT for global news coverage and events. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchGdelt } = await import('../../tools/gdeltSearch.js');
        const results = await searchGdelt(query, '30d', limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'gdelt',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No GDELT results found.' };
      } catch (err) {
        return {
          content: `GDELT search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

function createWikidataSearchTool(collector: CitationCollector): AgentTool {
  return {
    name: 'search_wikidata',
    description:
      'Search Wikidata for structured knowledge graph entities. Free, no API key needed.',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results (1-20, default 10)' },
    },
    execute: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'Error: query is required', error: 'missing query' };
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 20));

      try {
        const { searchWikidata } = await import('../../tools/wikidataSearch.js');
        const results = await searchWikidata(query, 'en', limit);
        const startIdx = collector.addResults(
          results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
          'wikidata',
        );
        const text = results
          .map((r, i) => `[${String(startIdx + i)}] ${r.title}\n${r.link}\n${r.snippet}`)
          .join('\n\n');
        return { content: text || 'No Wikidata results found.' };
      } catch (err) {
        return {
          content: `Wikidata search failed: ${err instanceof Error ? err.message : String(err)}`,
          error: 'search failed',
        };
      }
    },
  };
}

// ── Research Subtopic ──────────────────────────────────────────────────

function createResearchSubtopicTool(ctx: StrategyContext, collector: CitationCollector): AgentTool {
  return {
    name: 'research_subtopic',
    description:
      'Investigate multiple subtopics in parallel. Best when a question has several distinct aspects that can be researched independently. Provide up to 6 subtopics.',
    parameters: {
      subtopics: {
        type: 'array',
        description: 'Array of subtopic questions to research in parallel (max 6)',
        required: true,
      },
    },
    execute: async (args) => {
      const subtopics = Array.isArray(args.subtopics) ? args.subtopics.slice(0, 6) : [];
      if (subtopics.length === 0) {
        return { content: 'Error: subtopics array is required', error: 'missing subtopics' };
      }

      const results: string[] = [];
      let hasError = false;
      const concurrency = 4;

      // Dynamically import AgentStrategy to avoid circular dependency
      const { AgentStrategy } = await import('./agentStrategy.js');

      for (let i = 0; i < subtopics.length; i += concurrency) {
        const batch = subtopics.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map(async (subtopic: string) => {
            // Create a sub-agent with a reduced iteration budget and the SHARED collector
            const subAgent = new AgentStrategy(
              {
                ...ctx,
                config: {
                  ...ctx.config,
                  agentMaxIterations: ctx.config.agentMaxSubIterations,
                },
              },
              collector,
            );

            const subResult = await subAgent.analyze(subtopic, ctx);
            return {
              subtopic,
              report: subResult.report.narrativeMarkdown,
              sourceCount: subResult.report.sourceCount,
            };
          }),
        );

        for (const batchResult of batchResults) {
          if (batchResult.status === 'fulfilled') {
            const { subtopic, report, sourceCount } = batchResult.value;
            results.push(
              `## Subtopic: ${subtopic}\n\nFindings (${String(sourceCount)} sources):\n\n${report}`,
            );
          } else {
            hasError = true;
            results.push(
              `## Subtopic: unknown\n\nResearch failed: ${batchResult.reason instanceof Error ? batchResult.reason.message : String(batchResult.reason)}`,
            );
          }
        }
      }

      const header = `Researched ${String(subtopics.length)} subtopic(s)${hasError ? ' (with some errors)' : ''}:\n\n`;
      return { content: header + results.join('\n\n---\n\n') };
    },
  };
}
