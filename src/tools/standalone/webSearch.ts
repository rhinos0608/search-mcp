/**
 * Standalone web_search tool registration.
 *
 * Search every available web backend in parallel, with Codex as main source.
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { webSearch, type ProvenanceResult, type AiSummaryMode } from '../webSearch.js';
import {
  computeFetchLimit,
  assembleWebSearchResponse,
  writeWebSearchArtifact,
  type ArtifactOptions,
} from '../webSearchArtifact.js';
import { errorResponse } from '../response.js';
import { outputBudget } from '../../utils/outputBudget.js';
import { scrubContent } from '../../utils/contentScrubber.js';
import { enrichDocumentSnippets } from '../webSearchDocEnrich.js';
import type { SearchResult } from '../../types.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { CATEGORY_NAMES } from '../../utils/searchCategories.js';

export interface RegisterWebSearchOptions {
  /**
   * Injectable artifact base directory / fs options. When provided, overflow
   * artifacts are written here instead of the real user cache (used by tests).
   */
  artifactOptions?: ArtifactOptions;
  /** Injectable search implementation (defaults to the real webSearch). */
  search?: typeof webSearch;
}

export function registerWebSearch(
  server: McpServer,
  kgHook?: KnowledgeGraphHook,
  getConfig: () => SearchConfig = loadConfig,
  options?: RegisterWebSearchOptions,
): void {
  server.registerTool(
    'web_search',
    {
      description:
        'Search every configured available backend in parallel, deduplicate matching URLs (keeping the richest representation and unioning engine provenance), then return a single bare-Markdown block (no XML/JSON/hybrid envelope) headed "# Web search results", with one "## [N] title" section per result — the title is plain text, never a clickable link — followed by an optional "url: <safe http(s) URL>" line only when a safe URL is present, compact via/published/content/quality metadata, and cleaned Markdown content where each SEMANTIC BLOCK (prose paragraph, list item, blockquote paragraph, code fence, or table) carries exactly one stable [N-M] citation — never a per-sentence citation. ChatGPT/Codex is main source when credentials are available (CODEX_ACCESS_TOKEN or ~/.codex/auth.json); duplicates retain the richest content and Codex gets only a bounded tiebreak preference on (near-)equal ranking scores, so a rich Exa/Tavily result is never starved by a thin Codex snippet. Results are excerpt-only by default (Exa/Tavily request query-relevant highlights/snippets, never full page text), and each result carries honest metadata: a `via` list of every deduped MCP backend that surfaced the URL (the content donor marked `(content)`, SearXNG upstream engines as bracketed labels), publication/fetch origin, content kind, and a deterministic source-credibility tier with an explainable basis. When an embedding provider is configured, unique results are semantically reranked against the query (with a source-credibility floor). aiSummary controls native generated summaries: no (default, disabled), yes (provider-generated summaries that are URL-attributable per result — currently Exa — included under a separate "### AI summary (Exa)" section alongside the excerpt content; Tavily returns only a query-level answer with no per-URL grounding, so it contributes none in yes mode), only (restrict fanout to configured Exa/Tavily and return summary-only content; Tavily only uses its per-result ultra-fast NLP summary). SEARCH_BACKEND controls fallback ordering only, not provider scope. Codex search is undocumented best-effort endpoint; may be rate-limited or unavailable. When more usable candidates exist than the requested limit, or inline byte/prose caps trim content, the complete sanitized result set is written to a private per-invocation overflow artifact file (absolute path returned in a short additive notice line) that an agent can read.',
      inputSchema: {
        query: z.string().describe('The search query string'),
        limit: tolerant(z.number().int().min(1).max(50))
          .optional()
          .default(10)
          .describe('Maximum number of results to return (1–50, default 10)'),
        safeSearch: z
          .enum(['strict', 'moderate', 'off'])
          .optional()
          .default('moderate')
          .describe(
            'Safe-search level. strict restricts fanout to backends with verified strict support (DuckDuckGo, SearXNG, Brave, Exa with moderation); Tavily, Codex, and Ollama search are excluded under strict. moderate (default) and off retain full provider fanout.',
          ),
        expandQuery: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Generate query variations (question, concept, scope, opposition) and merge results for broader coverage.',
          ),
        category: z
          .enum(CATEGORY_NAMES)
          .optional()
          .describe(
            'Search category profile to enhance the query (company, research paper, news, pdf, github, tweet, personal site, people, financial report)',
          ),
        aiSummary: z
          .enum(['no', 'yes', 'only'])
          .optional()
          .default('no')
          .describe(
            'Native AI summaries: no (default, disabled), yes (URL-attributable provider summaries — Exa — included alongside excerpt content; Tavily provides none in yes), only (restrict fanout to configured Exa/Tavily and return summary-only content).',
          ),
        multimodal: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Opt-in: describe figures/complex tables in parsed documents via the configured vision LLM. Requires DOCUMENT_PARSING_ENABLED and a configured LLM.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, safeSearch, expandQuery, category, aiSummary, multimodal }) => {
      // Server-level defaults (always on, hidden from schema to reduce param noise)
      const mergeSearchBackends = true;

      // Load a single current config snapshot at invocation time so webSearch
      // backend selection and the final SCRUB_CONTENT / knowledge-graph
      // decisions observe the same config — no drift after dashboard config
      // cache invalidation. Injectable for hermetic tests (defaults to the
      // runtime cache).
      const invocationCfg = getConfig();

      // Per-call multimodal override: when the caller opts in, shallow-clone the
      // loaded config so THIS invocation uses documentParsing.multimodal=true
      // without mutating the shared cached config object.
      const effectiveCfg =
        multimodal && !invocationCfg.documentParsing.multimodal
          ? {
              ...invocationCfg,
              documentParsing: { ...invocationCfg.documentParsing, multimodal: true },
            }
          : invocationCfg;

      logger.info(
        {
          tool: 'web_search',
          limit,
          safeSearch,
          expandQuery,
          aiSummary,
        },
        'Tool invoked',
      );
      try {
        // Internally over-fetch bounded headroom so navigation-only candidates
        // can be dropped and replacements still reach the requested `limit`.
        // The public schema (default 10 / max 50) is unchanged; `limit` is
        // honored exactly for the inline preview and the returned count.
        const fetchLimit = computeFetchLimit(limit);
        const provenanceRef: { current: ProvenanceResult | null } = { current: null };
        const searchImpl = options?.search ?? webSearch;
        const searchResults = await searchImpl(
          query,
          fetchLimit,
          safeSearch,
          expandQuery,
          mergeSearchBackends,
          provenanceRef,
          category,
          aiSummary,
          invocationCfg,
        );

        // Auto-enrich thin document snippets (fetch + parse the full document for
        // the top-ranked doc-URL results). Config-gated internally — when
        // documentParsing.enabled is false this is a cheap no-op returning the
        // results unchanged (no fetches), so behavior is identical to today.
        const enriched = await enrichDocumentSnippets(searchResults, effectiveCfg, limit);

        // Threat-scrub untrusted result fields before the markdown formatter when
        // scrubbing is enabled. Nothing about content or threat evidence is
        // logged. Disabled behavior is unchanged.
        const results = invocationCfg.scrubContent ? scrubSearchResults(enriched) : enriched;

        const summaryMode: AiSummaryMode = aiSummary;
        // Single LLM-ingestible Markdown string returned as bare MCP text content —
        // no XML/JSON/hybrid envelope. The formatter enforces the inline output
        // budget; when usable results exceed `limit` or inline caps trim content,
        // the complete sanitized result set is written to a private overflow
        // artifact whose path is returned in a short additive notice line.
        const writer =
          options?.artifactOptions !== undefined
            ? (content: string) => writeWebSearchArtifact(content, options.artifactOptions)
            : undefined;
        const { text: markdown } = assembleWebSearchResponse(results, {
          limit,
          aiSummary: summaryMode,
          ...(writer !== undefined ? { writeArtifact: writer } : {}),
        });
        const data: { text: string } = { text: markdown };

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && invocationCfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall('web_search', data).catch((err: unknown) => {
            logger.warn({ err, tool: 'web_search' }, 'KG passive capture failed (non-fatal)');
          });
        }

        outputBudget.recordResponse('web_search', Buffer.byteLength(markdown));
        return { content: [{ type: 'text' as const, text: markdown }] };
      } catch (err: unknown) {
        logger.error({ err, tool: 'web_search' }, 'Tool failed');
        return errorResponse(err, 'web_search');
      }
    },
  );
}

/**
 * Run the threat scrubber over every untrusted result field before XML
 * formatting. Redacted content replaces the original value; the scrubbed
 * content and threat evidence are never logged.
 */
function scrubField(value: string): string {
  return scrubContent(value).content;
}

function scrubSearchResults(results: SearchResult[]): SearchResult[] {
  return results.map((result) => ({
    ...result,
    title: scrubField(result.title),
    url: scrubField(result.url),
    description: scrubField(result.description),
    domain: scrubField(result.domain),
    age: result.age === null ? null : scrubField(result.age),
    extraSnippet: result.extraSnippet === null ? null : scrubField(result.extraSnippet),
    generatedSummary:
      result.generatedSummary === undefined || result.generatedSummary === null
        ? result.generatedSummary
        : scrubField(result.generatedSummary),
    ...(result.engines !== undefined
      ? { engines: result.engines.map((engine) => scrubField(engine)) }
      : {}),
  }));
}
