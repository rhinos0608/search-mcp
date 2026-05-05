import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { TRUNCATED_MARKER } from './httpGuards.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from './semanticLimits.js';
import { webSearch } from './tools/webSearch.js';
import { registerGitHubTool } from './tools/families/github.js';
import { registerYoutubeTool } from './tools/families/youtube.js';
import { registerRedditTool } from './tools/families/reddit.js';
import { registerPackagesTool } from './tools/families/packages.js';
import { registerResearchTool } from './tools/families/research.js';
import { registerDeepResearchTool } from './tools/deepResearch.js';
import { webCrawl } from './tools/webCrawl.js';
import { webRead } from './tools/webRead.js';
import { semanticCrawl } from './tools/semanticCrawl.js';
import { semanticJobs } from './tools/semanticJobs.js';
import { makeResult, errorResponse, successResponse } from './tools/response.js';
import { configHealth, getGatedTools, runHealthProbes } from './health.js';
import {
   extractionConfigSchema,
   validateExtractionConfig,
   type ExtractionConfig,
} from './utils/extractionConfig.js';
import type { LlmConfig } from './config.js';
import { isDocumentUrl } from './utils/documentUtils.js';


/** Map LLM config to the shape expected by extractionConfig validator. */
function normalizeLlmForValidation(llm: LlmConfig): {
   provider: string;
   apiToken: string;
   baseUrl?: string;
} {
   return {
      provider: llm.provider,
      apiToken: llm.apiToken ?? '',
      ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
   };
}

/** Build llmFallback config for Crawl4AI extraction when LLM strategy is used. */
function buildLlmFallback(
   extractionConfig: ExtractionConfig | undefined,
   llm: LlmConfig,
): { provider: string; apiToken: string; baseUrl?: string } | undefined {
   if (extractionConfig?.type !== 'llm') return undefined;
   return {
      provider: extractionConfig.llmProvider ?? llm.provider,
      apiToken: llm.apiToken ?? '',
      ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
   };
}

/** Build extraction warnings: pages that succeeded but returned no extractedData. */
function extractionWarnings(data: {
   pages: { url: string; success: boolean; extractedData?: unknown }[];
}): string[] {
   const warnings: string[] = [];
   for (const page of data.pages) {
      if (page.success && !page.extractedData) {
         warnings.push(`Extraction produced no data for ${page.url}`);
      }
   }
   return warnings;
}

/** Normalize a Readability article into the WebCrawlResult shape. */
function readabilityFallbackResult(
   url: string,
   article: import('./types.js').ArticleResult,
   strategy: 'bfs' | 'dfs',
   maxDepth: number,
   maxPages: number,
): import('./types.js').WebCrawlResult {
   return {
      seedUrl: url,
      strategy,
      maxDepth,
      maxPages,
      totalPages: 1,
      successfulPages: 1,
      pages: [
         {
            url,
            success: true,
            markdown: article.textContent,
            title: article.title ?? '',
            description: article.description ?? '',
            links: [],
            statusCode: null,
            errorMessage: null,
            ...(article.elements !== undefined &&
               article.elements.length > 0 && { elements: article.elements }),
            ...(article.truncatedElements !== undefined && {
               truncatedElements: article.truncatedElements,
            }),
            ...(article.originalElementCount !== undefined && {
               originalElementCount: article.originalElementCount,
            }),
            ...(article.omittedElementCount !== undefined && {
               omittedElementCount: article.omittedElementCount,
            }),
         },
      ],
   };
}


/** Use RAG-Anything bridge to extract content from a document URL. */
/** Maximum size for RAGA extraction results before truncation (500KB). */
const MAX_RAGA_MARKDOWN_BYTES = 500_000;

interface RAGAExtractConfig {
   baseUrl: string;
   timeoutMs: number;
}

async function extractWithRAGA(
   url: string,
   raga: RAGAExtractConfig,
   extra?: Record<string, unknown>,
): Promise<{ markdown: string; warnings: string[] }> {
   const startTime = Date.now();

   const sendProgress = async (progress: number, message: string) => {
      try {
         const e = extra as { _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> } | undefined;
         if (!e?.sendNotification || !e._meta?.progressToken) return;
         await e.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: e._meta.progressToken, progress, total: 100, message },
         });
      } catch { /* non-fatal */ }
   };

   await sendProgress(5, 'Submitting extraction job');

   const { RAGAnythingClient } = await import('./utils/ragAnythingClient.js');
   const client = new RAGAnythingClient({ baseUrl: raga.baseUrl, timeoutMs: raga.timeoutMs });

   // Use async extraction with progress polling.
   // The onProgress callback fires on each status poll, keeping the
   // MCP connection alive via notifications/progress.
   const result = await client.extractAsync(
      {
         url,
         parser: 'auto',
         extractTables: true,
         extractImages: false,
         extractEquations: true,
      },
      (progress: number, message: string) => {
         // Bridge progress is 0-100; pipe through to MCP progress notifications.
         // Fire-and-forget — progress visibility is best-effort.
         sendProgress(Math.round(progress), message).catch(() => { /* no-op */ });
      },
   );

   await sendProgress(70, 'Processing extracted content');
   await sendProgress(90, 'Building result');

   const elapsed = Date.now() - startTime;
   logger.info(
      { tool: 'extractWithRAGA', url, timeoutMs: raga.timeoutMs, elapsedMs: elapsed, markdownLen: result.markdown.length },
      'RAGA extraction completed',
   );

   await sendProgress(100, 'Extraction complete');

   if (!result.markdown) {
      return { markdown: '', warnings: ['Extraction returned no content'] };
   }

   const warnings: string[] = [];
   let markdown = result.markdown;

   if (markdown.length > MAX_RAGA_MARKDOWN_BYTES) {
      const hash = createHash('sha256').update(markdown).digest('hex');
      const filePath = `/tmp/raga-extracts/${hash}.md`;

      try {
         await mkdir('/tmp/raga-extracts/', { recursive: true });
         await writeFile(filePath, markdown);
         logger.info({ filePath }, 'Full RAGA extraction saved to temp file');
      } catch (err) {
         logger.warn({ err, filePath }, 'Failed to save full RAGA extraction to temp file');
      }

      markdown = markdown.slice(0, MAX_RAGA_MARKDOWN_BYTES) + TRUNCATED_MARKER;
      warnings.push(`Result was truncated to ${String(MAX_RAGA_MARKDOWN_BYTES / 1024)}KB. Full content saved to ${filePath}`);
   }

   return { markdown, warnings };
}

export function createServer(): McpServer {
   const cfg = loadConfig();
   logger.info({ backend: cfg.searchBackend }, 'Primary search backend');

   const gated = getGatedTools(cfg);
   if (gated.size > 0) {
      const startupHealth = configHealth(cfg);
      for (const tool of gated) {
         const h = startupHealth[tool];
         logger.info({ tool, remediation: h?.remediation }, 'Tool not registered (unconfigured)');
      }
   }

   const server = new McpServer({
      name: 'search-mcp',
      version: '1.0.0',
   });

   // ── web_search ────────────────────────────────────────────────────────────
   server.registerTool(
      'web_search',
      {
         description:
            'Search the web and return a ranked list of results with titles, URLs, descriptions, and citation metadata (position, domain, source backend, age). Uses the configured search backend (Exa, Brave, or SearXNG) with automatic fallback.',
         inputSchema: {
            query: z.string().describe('The search query string'),
            limit: z
               .number()
               .int()
               .min(1)
               .max(50)
               .optional()
               .default(10)
               .describe('Maximum number of results to return (1–50, default 10)'),
            safeSearch: z
               .enum(['strict', 'moderate', 'off'])
               .optional()
               .default('moderate')
               .describe('Safe-search level: strict | moderate | off'),
            expandQuery: z
               .boolean()
               .optional()
               .default(true)
               .describe(
                  'Generate query variations (question, concept, scope, opposition) and merge results for broader coverage.',
               ),
            mergeSearchBackends: z
               .boolean()
               .optional()
               .default(true)
               .describe(
                  'When multiple search backends are configured, query all of them and merge + deduplicate results. Adds engines field tracking which backend returned each result.',
               ),
         },
      },
      async ({ query, limit, safeSearch, expandQuery, mergeSearchBackends }) => {
         logger.info(
            { tool: 'web_search', limit, safeSearch, expandQuery, mergeSearchBackends },
            'Tool invoked',
         );
         const start = Date.now();
         try {
            const data = await webSearch(query, limit, safeSearch, expandQuery, mergeSearchBackends);
            const result = makeResult('web_search', data, Date.now() - start);
            return successResponse(result);
         } catch (err: unknown) {
            logger.error({ err, tool: 'web_search' }, 'Tool failed');
            return errorResponse(err);
         }
      },
   );

   // ── web_read (crawl4ai) ────────────────────────────────────────────────────
   server.registerTool(
      'web_read',
      {
         description:
            'Fetch and parse a web page via crawl4ai headless browser. Handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. Returns clean LLM-ready Markdown with title, description, and extracted links. [DEPRECATED] Use web_crawl for deep crawling support.',
         inputSchema: {
            url: z
               .url()
               .describe('The fully-qualified URL of the page to read (must include https://)'),
            strategy: z
               .enum(['bfs', 'dfs'])
               .optional()
               .default('bfs')
               .describe('Crawl strategy (default bfs)'),
            maxDepth: z
               .number()
               .int()
               .min(1)
               .max(5)
               .optional()
               .default(1)
               .describe('Max link depth to follow (1–5, default 1 = single page)'),
            maxPages: z
               .number()
               .int()
               .min(1)
               .max(100)
               .optional()
               .default(1)
               .describe('Max pages to crawl (1–100, default 1)'),
            includeExternalLinks: z
               .boolean()
               .optional()
               .default(false)
               .describe('Follow external domain links (default false)'),
            extractionConfig: extractionConfigSchema
               .optional()
               .describe(
                  'Optional structured data extraction config. Only works when crawl4ai is configured; ignored in Readability fallback.',
               ),
         },
      },
      async ({ url, strategy, maxDepth, maxPages, includeExternalLinks, extractionConfig }, extra) => {
         logger.info({ tool: 'web_read' }, 'Tool invoked');
         const start = Date.now();
         try {
            if (extractionConfig) {
               validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
            }

            let data: import('./types.js').WebCrawlResult = readabilityFallbackResult(
               url,
               {
                  url,
                  title: null,
                  textContent: '',
                  content: '',
                  extractionMethod: 'fallback',
                  elements: [],
                  byline: null,
                  siteName: null,
                  description: null,
                  publishedDate: null,
                  image: null,
               },
               strategy,
               maxDepth,
               maxPages,
            );
            const warnings: string[] = [];

            // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
            let ragaAttempted = false;
            if (isDocumentUrl(url) && cfg.raga.enabled && cfg.raga.baseUrl) {
               try {
                  logger.info(
                     { tool: 'web_read', url },
                     'Document URL detected — using RAG-Anything extraction',
                  );
                  const { markdown, warnings: ragaWarnings } = await extractWithRAGA(url, { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs }, extra);
                  warnings.push(...ragaWarnings);
                  data = readabilityFallbackResult(
                     url,
                     {
                        url,
                        title: null,
                        textContent: markdown,
                        content: markdown,
                        extractionMethod: 'raga',
                        elements: [],
                        byline: null,
                        siteName: null,
                        description: null,
                        publishedDate: null,
                        image: null,
                     },
                     strategy,
                     maxDepth,
                     maxPages,
                  );
                  ragaAttempted = true;
               } catch (ragaErr) {
                  logger.warn(
                     { tool: 'web_read', url, err: String(ragaErr) },
                     'RAGA extraction failed, falling back to Crawl4AI',
                  );
                  warnings.push(`RAGA extraction failed: ${String(ragaErr)}. Falling back to Crawl4AI.`);
               }
            }
            if (!ragaAttempted) {
               if (cfg.crawl4ai.baseUrl) {
                  const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
                  data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
                     strategy,
                     maxDepth,
                     maxPages,
                     includeExternalLinks,
                     ...(extractionConfig ? { extractionConfig } : {}),
                     ...(llmFallback ? { llmFallback } : {}),
                  });
                  warnings.push(...extractionWarnings(data));
               } else {
                  if (extractionConfig) {
                     warnings.push(
                        'extractionConfig is ignored when crawl4ai is not configured (Readability fallback does not support structured extraction)',
                     );
                  }
                  logger.debug('crawl4ai not configured — falling back to webRead (Readability)');
                  const article = await webRead(url);
                  data = readabilityFallbackResult(url, article, strategy, maxDepth, maxPages);
               }
            }

            const result = makeResult('web_read', data, Date.now() - start, {
               warnings,
            });
            return successResponse(result);
         } catch (err: unknown) {
            logger.error({ err, tool: 'web_read' }, 'Tool failed');
            return errorResponse(err);
         }
      },
   );

   // ── semantic_jobs ────────────────────────────────────────────────────────
   if (!gated.has('semantic_jobs'))
      server.registerTool(
         'semantic_jobs',
         {
            description:
               'Search for job listings across 20+ job boards (SEEK, Indeed, LinkedIn, Monster, Glassdoor, ZipRecruiter, ' +
               'CareerBuilder, Dice, Workable, Lever, Greenhouse, Ashby, Breezy, Wellfound, Otta, SimplyHired, FlexJobs, ' +
               'Upwork, Jooble, Adzuna, Jora), extract structured fields (title, company, location, salary, work mode), ' +
               'apply constraint filters, rank with weighted composite scoring, and return structured job results. ' +
               'Uses web search + crawl for discovery, then extracts structured data from listing pages. ' +
               'Requires EMBEDDING_SIDECAR_BASE_URL for semantic ranking. Falls back to constraint-only ranking without it.',
            inputSchema: {
               query: z
                  .string()
                  .describe('The job search query (e.g. "frontend developer", "data entry admin")'),
               location: z
                  .array(z.string())
                  .optional()
                  .describe(
                     'Preferred locations (e.g. ["Sydney", "Melbourne"]). Used for ranking boost - matches appear higher in results. ' +
                     'Set enforceConstraints: true to filter out non-matches.',
                  ),
               workMode: z
                  .array(z.enum(['remote', 'hybrid', 'onsite']))
                  .optional()
                  .describe(
                     'Preferred work modes. Used for ranking boost - matches appear higher in results. ' +
                     'Set enforceConstraints: true to filter out non-matches.',
                  ),
               maxSalary: z
                  .number()
                  .positive()
                  .optional()
                  .describe(
                     'Maximum annual salary. Listings exceeding this are ranked lower. ' +
                     'Set enforceConstraints: true to filter out exceeding listings.',
                  ),
               excludeTitles: z
                  .array(z.string())
                  .optional()
                  .describe(
                     'Title keywords to exclude. Used for ranking penalty - excluded keywords ranked lower. ' +
                     'Set enforceConstraints: true to filter out listings with these keywords.',
                  ),
               maxPages: z
                  .number()
                  .int()
                  .min(1)
                  .max(50)
                  .optional()
                  .default(20)
                  .describe('Maximum number of job listing pages to crawl (1–50, default 20)'),
               topK: z
                  .number()
                  .int()
                  .min(1)
                  .max(50)
                  .optional()
                  .default(10)
                  .describe('Number of top-ranked job listings to return (1–50, default 10)'),
               maxBytes: z
                  .number()
                  .int()
                  .min(1)
                  .max(DEFAULT_SEMANTIC_MAX_BYTES)
                  .optional()
                  .default(DEFAULT_SEMANTIC_MAX_BYTES)
                  .describe('Maximum total bytes of listing text to embed (1–250MB, default 250MB)'),
               addJobSuffix: z
                  .boolean()
                  .optional()
                  .default(true)
                  .describe(
                     'When true (default), appends "jobs" keyword to the search query for better discovery. ' +
                     'Set false to use the query as-is without the "jobs" suffix.',
                  ),
               useJobSpy: z
                  .boolean()
                  .optional()
                  .default(true)
                  .describe(
                     'Use JobSpy as primary acquisition layer instead of web search. ' +
                     'Provides structured job data from LinkedIn, Indeed, Glassdoor, ZipRecruiter, and more. ' +
                     'Set false to fall back to traditional web search + crawl.',
                  ),
               enforceConstraints: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe(
                     'When true, applies hard filtering to exclude listings that dont match constraints. ' +
                     'When false (default), constraints only influence ranking scores - all results are returned ' +
                     'but listings matching your constraints are ranked higher. Use true to filter out non-matches.',
                  ),
            },
         },
         async ({
            query,
            location,
            workMode,
            maxSalary,
            excludeTitles,
            maxPages,
            topK,
            maxBytes,
            addJobSuffix,
            useJobSpy,
            enforceConstraints,
         }) => {
            logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Tool invoked');
            const start = Date.now();
            try {
               const data = await semanticJobs({
                  query,
                  embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
                  ...(cfg.embeddingSidecar.apiToken
                     ? { embeddingApiToken: cfg.embeddingSidecar.apiToken }
                     : {}),
                  embeddingDimensions: cfg.embeddingSidecar.dimensions,
                  ...(location?.length ? { location } : {}),
                  ...(workMode?.length ? { workMode } : {}),
                  ...(maxSalary !== undefined ? { maxSalary } : {}),
                  ...(excludeTitles?.length ? { excludeTitles } : {}),
                  maxPages,
                  topK,
                  maxBytes,
                  addJobSuffix,
                  useJobSpy,
                  enforceConstraints,
               });
               const elapsed = Date.now() - start;
               const result = makeResult(
                  'semantic_jobs',
                  {
                     results: data.results.map((scored, index) => ({
                        rank: index + 1,
                        overallScore: Math.round(scored.overallScore * 1000) / 1000,
                        matchedConstraints: scored.matchedConstraints,
                        caveats: scored.caveats,
                        listing: {
                           title: scored.listing.title,
                           company: scored.listing.company,
                           location: scored.listing.location,
                           workMode: scored.listing.workMode,
                           salaryRaw: scored.listing.salaryRaw,
                           source: scored.listing.source,
                           sourceUrl: scored.listing.sourceUrl,
                           confidence: scored.listing.confidence,
                           verificationStatus: scored.listing.verificationStatus,
                        },
                     })),
                     corpusStatus: data.corpusStatus,
                  },
                  elapsed,
                  {
                     ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
                  },
               );
               return successResponse(result);
            } catch (err: unknown) {
               logger.error({ err, tool: 'semantic_jobs' }, 'Tool failed');
               return errorResponse(err);
            }
         },
      );

   // ── web_crawl ────────────────────────────────────────────────────────────
   if (!gated.has('web_crawl'))
      server.registerTool(
         'web_crawl',
         {
            description:
               'Crawl a URL using a headless Playwright browser (via a crawl4ai sidecar). ' +
               'Unlike web_read, this handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. ' +
               'Returns clean LLM-ready Markdown with title, description, and extracted links for each crawled page. ' +
               'Supports deep crawling across multiple pages. Requires CRAWL4AI_BASE_URL env var (self-hosted Docker sidecar).',
            inputSchema: {
               url: z.url().describe('Seed URL to start crawling from'),
               strategy: z
                  .enum(['bfs', 'dfs'])
                  .optional()
                  .default('bfs')
                  .describe(
                     'Crawl strategy: bfs (breadth-first, good for shallow wide coverage) | ' +
                     'dfs (depth-first, good for deeply nested docs)',
                  ),
               maxDepth: z
                  .number()
                  .int()
                  .min(1)
                  .max(5)
                  .optional()
                  .default(1)
                  .describe(
                     'Maximum link depth to follow from seed URL (1–5, default 1 = single page only)',
                  ),
               maxPages: z
                  .number()
                  .int()
                  .min(1)
                  .max(100)
                  .optional()
                  .default(1)
                  .describe('Maximum number of pages to crawl (1–100, default 1)'),
               includeExternalLinks: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe('Follow links to external domains (default false — stays on seed domain)'),
               extractionConfig: extractionConfigSchema
                  .optional()
                  .describe(
                     'Optional structured data extraction config. Supports css_schema, xpath_schema, regex, and llm strategies. ' +
                     'Requires Crawl4AI sidecar v0.8.x or later.',
                  ),
               waitFor: z
                  .string()
                  .optional()
                  .describe(
                     'Wait for a CSS selector (css:.selector) or JS expression (js:() => boolean) before extracting content. Useful for SPAs and dynamic content.',
                  ),
               delayBeforeReturnHtml: z
                  .number()
                  .min(0)
                  .max(30)
                  .optional()
                  .default(0.1)
                  .describe(
                     'Extra seconds to wait after page load for dynamic content to settle (0–30, default 0.1)',
                  ),
               pageTimeout: z
                  .number()
                  .int()
                  .min(1000)
                  .max(300000)
                  .optional()
                  .default(60000)
                  .describe('Page operation timeout in milliseconds (1000–300000, default 60000)'),
               jsCode: z
                  .string()
                  .optional()
                  .describe(
                     'Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More"). Runs after wait_for completes.',
                  ),
            },
         },
         async ({
            url,
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            extractionConfig,
            waitFor,
            delayBeforeReturnHtml,
            pageTimeout,
            jsCode,
         }, extra) => {
            logger.info({ tool: 'web_crawl', url, strategy, maxDepth, maxPages }, 'Tool invoked');
            const start = Date.now();
            try {
               const warnings: string[] = [];
               if (extractionConfig) {
                  validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
               }

               // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
               if (isDocumentUrl(url) && cfg.raga.enabled && cfg.raga.baseUrl) {
                  try {
                     logger.info(
                        { tool: 'web_crawl', url },
                        'Document URL detected — using RAG-Anything extraction',
                     );
                     const { markdown, warnings: ragaWarnings } = await extractWithRAGA(url, { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs }, extra);
                     warnings.push(...ragaWarnings);
                     const article: import('./types.js').ArticleResult = {
                        url,
                        title: null,
                        textContent: markdown,
                        content: markdown,
                        extractionMethod: 'raga',
                        elements: [],
                        byline: null,
                        siteName: null,
                        description: null,
                        publishedDate: null,
                        image: null,
                     };
                     const data = readabilityFallbackResult(url, article, strategy, maxDepth, maxPages);
                     if (data.pages[0]) {
                        data.pages[0].success = true;
                     }
                     const result = makeResult('web_crawl', data, Date.now() - start, { warnings: [] });
                     return successResponse(result);
                  } catch (ragaErr) {
                     logger.warn(
                        { tool: 'web_crawl', url, err: String(ragaErr) },
                        'RAGA extraction failed, falling back to Crawl4AI',
                     );
                     warnings.push(`RAGA extraction failed: ${String(ragaErr)}. Falling back to Crawl4AI.`);
                  }
               }

               const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);
               const data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
                  strategy,
                  maxDepth,
                  maxPages,
                  includeExternalLinks,
                  waitFor,
                  delayBeforeReturnHtml,
                  pageTimeout,
                  jsCode,
                  ...(extractionConfig ? { extractionConfig } : {}),
                  ...(llmFallback ? { llmFallback } : {}),
               });
               warnings.push(...extractionWarnings(data), ...(data.warnings ?? []));
               const result = makeResult('web_crawl', data, Date.now() - start, {
                  warnings,
               });
               return successResponse(result);
            } catch (err: unknown) {
               logger.error({ err, tool: 'web_crawl' }, 'Tool failed');
               return errorResponse(err);
            }
         },
      );

   // ── semantic_crawl ──────────────────────────────────────────────────────
   if (!gated.has('semantic_crawl'))
      server.registerTool(
         'semantic_crawl',
         {
            description:
               'Crawl an information space and return the most semantically relevant passages for a specific query. ' +
               'Uses EmbeddingGemma (300M, local) to chunk, embed, and rank content by similarity.\n\n' +
               'USE THIS TOOL when you need to:\n' +
               '- Find specific information within a large documentation site, codebase reference, or multi-page resource\n' +
               '- Answer "how does X handle Y" or "where does X explain Z" against a known URL\n' +
               '- Research a specific topic across an entire domain without reading every page\n\n' +
               'PREFER web_crawl instead when you need full page content or are summarising an entire site.\n' +
               "PREFER web_search when you don't have a target URL.",
            inputSchema: {
               source: z
                  .discriminatedUnion('type', [
                     z.object({
                        type: z.literal('url'),
                        url: z.url().describe('Seed URL to start crawling from'),
                        urls: z
                           .array(z.url())
                           .optional()
                           .describe('Additional seed URLs to crawl in the same corpus'),
                     }),
                     z.object({
                        type: z.literal('sitemap'),
                        url: z.url().describe('URL of a sitemap.xml to parse for seed URLs'),
                     }),
                     z.object({
                        type: z.literal('search'),
                        query: z
                           .string()
                           .describe('Web search query to discover seed URLs, then crawl them'),
                        maxSeedUrls: z
                           .number()
                           .int()
                           .min(1)
                           .max(20)
                           .optional()
                           .default(10)
                           .describe('Max URLs to collect from web search (1–20, default 10)'),
                     }),
                     z.object({
                        type: z.literal('github'),
                        owner: z.string().describe('GitHub repository owner'),
                        repo: z.string().describe('GitHub repository name'),
                        branch: z.string().optional().describe('Git branch (default: repo default branch)'),
                        extensions: z.array(z.string()).optional().describe('File extensions to include'),
                        query: z
                           .string()
                           .optional()
                           .describe('Optional code search query to pre-filter files'),
                     }),
                     z.object({
                        type: z.literal('cached'),
                        corpusId: z
                           .string()
                           .describe(
                              'Corpus ID returned by a previous semantic_crawl call. Skip re-crawl and re-embed.',
                           ),
                     }),
                  ])
                  .describe('Source of the corpus to crawl'),
               query: z.string().describe('The semantic search query — what are you looking for?'),
               topK: z
                  .number()
                  .int()
                  .min(1)
                  .max(50)
                  .optional()
                  .default(10)
                  .describe('Number of most-relevant chunks to return (1–50, default 10)'),
               strategy: z
                  .enum(['bfs', 'dfs'])
                  .optional()
                  .default('bfs')
                  .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
               maxDepth: z
                  .number()
                  .int()
                  .min(0)
                  .max(5)
                  .optional()
                  .default(2)
                  .describe(
                     'Maximum link depth (0–5, default 2). Set 0 for single-page / sitemap / search modes.',
                  ),
               maxPages: z
                  .number()
                  .int()
                  .min(1)
                  .max(100)
                  .optional()
                  .default(20)
                  .describe('Maximum pages to crawl (1–100, default 20). Divided across seeds.'),
               includeExternalLinks: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe('Follow external domain links (default false)'),
               maxBytes: z
                  .number()
                  .int()
                  .min(1)
                  .max(DEFAULT_SEMANTIC_MAX_BYTES)
                  .optional()
                  .default(DEFAULT_SEMANTIC_MAX_BYTES)
                  .describe('Maximum total bytes to crawl (1–250MB, default 250MB)'),
               useReranker: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe('Apply cross-encoder re-ranking to top candidates (default false)'),
               useContextualEmbeddings: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe('Use LLM-generated context for embedding corpus chunks (default false)'),
               maxChunkTokens: z
                  .number()
                  .int()
                  .min(100)
                  .max(8000)
                  .optional()
                  .describe(
                     'Override max tokens per chunk (100–8000, default 400). ' +
                     'Larger values produce fewer chunks, reducing LLM calls when useContextualEmbeddings is enabled. ' +
                     'Auto-scaled to 1200 when useContextualEmbeddings is on and this is not set.',
                  ),
               allowPathDrift: z
                  .boolean()
                  .optional()
                  .default(false)
                  .describe('Allow crawler to follow links outside the seed URL path (default false)'),
               extractionConfig: extractionConfigSchema
                  .optional()
                  .describe(
                     'Optional structured data extraction config. Ignored when using cached source. Not merged into chunk embeddings.',
                  ),
               waitFor: z
                  .string()
                  .optional()
                  .describe(
                     'Wait for a CSS selector (css:.selector) or JS expression (js:() => boolean) before extracting content. Useful for SPAs and dynamic content.',
                  ),
               delayBeforeReturnHtml: z
                  .number()
                  .min(0)
                  .max(30)
                  .optional()
                  .default(0.1)
                  .describe(
                     'Extra seconds to wait after page load for dynamic content to settle (0–30, default 0.1)',
                  ),
               pageTimeout: z
                  .number()
                  .int()
                  .min(1000)
                  .max(300000)
                  .optional()
                  .default(60000)
                  .describe('Page operation timeout in milliseconds (1000–300000, default 60000)'),
               jsCode: z
                  .string()
                  .optional()
                  .describe(
                     'Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More"). Runs after wait_for completes.',
                  ),
            },
         },
         async ({
            source,
            query,
            topK,
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
            maxBytes,
            useReranker,
            useContextualEmbeddings,
            maxChunkTokens,
            allowPathDrift,
            extractionConfig,
            waitFor,
            delayBeforeReturnHtml,
            pageTimeout,
            jsCode,
         }, extra) => {
            logger.info(
               { tool: 'semantic_crawl', sourceType: source.type, query, topK },
               'Tool invoked',
            );
            const start = Date.now();
            try {
               if (extractionConfig) {
                  validateExtractionConfig(extractionConfig, normalizeLlmForValidation(cfg.llm));
               }

               const warnings: string[] = [];
               if (source.type === 'cached' && extractionConfig) {
                  warnings.push(
                     'extractionConfig is ignored when using cached source (cached sources skip crawling)',
                  );
               }

               // RAG-Anything escalation for document URLs (PDF, Office, images, etc.)
               if (
                  source.type === 'url' &&
                  isDocumentUrl(source.url) &&
                  cfg.raga.enabled &&
                  cfg.raga.baseUrl
               ) {
                  try {
                     logger.info(
                        { tool: 'semantic_crawl', url: source.url },
                        'Document URL detected — using RAG-Anything extraction',
                     );
                     const { markdown, warnings: ragaWarnings } = await extractWithRAGA(source.url, { baseUrl: cfg.raga.baseUrl, timeoutMs: cfg.raga.timeoutMs }, extra);
                     warnings.push(...ragaWarnings);
                     const article: import('./types.js').ArticleResult = {
                        url: source.url,
                        title: null,
                        textContent: markdown,
                        content: markdown,
                        extractionMethod: 'raga',
                        elements: [],
                        byline: null,
                        siteName: null,
                        description: null,
                        publishedDate: null,
                        image: null,
                     };
                     const singlePage = readabilityFallbackResult(
                        source.url,
                        article,
                        strategy,
                        maxDepth,
                        maxPages,
                     );
                     const result = makeResult('semantic_crawl', singlePage, Date.now() - start, {
                        warnings,
                     });
                     return successResponse(result);
                  } catch (ragaErr) {
                     logger.warn(
                        { tool: 'semantic_crawl', url: source.url, err: String(ragaErr) },
                        'RAGA extraction failed, falling back to Crawl4AI',
                     );
                     warnings.push(`RAGA extraction failed: ${String(ragaErr)}. Falling back to Crawl4AI.`);
                  }
               }

               const llmFallback = buildLlmFallback(extractionConfig, cfg.llm);

               const effectiveMaxBytes = maxBytes;
               const data = await semanticCrawl(
                  {
                     source,
                     query,
                     topK,
                     strategy,
                     maxDepth,
                     maxPages,
                     includeExternalLinks,
                     maxBytes: effectiveMaxBytes,
                     useReranker,
                     maxChunkTokens,
                     allowPathDrift,
                     waitFor,
                     delayBeforeReturnHtml,
                     pageTimeout,
                     jsCode,
                     ...(extractionConfig ? { extractionConfig } : {}),
                     ...(llmFallback ? { llmFallback } : {}),
                     ...(useContextualEmbeddings
                        ? { useContextualEmbeddings, contextualEmbedding: cfg.llm }
                        : {}),
                  },
                  cfg.crawl4ai,
                  cfg.embeddingSidecar.baseUrl,
                  cfg.embeddingSidecar.apiToken ?? '',
                  cfg.embeddingSidecar.dimensions,
                  cfg.raga,
               );
               const result = makeResult('semantic_crawl', data, Date.now() - start, {
                  warnings: [...warnings, ...(data.warnings ?? [])],
               });
               return successResponse(result);
            } catch (err: unknown) {
               logger.error({ err, tool: 'semantic_crawl' }, 'Tool failed');
               return errorResponse(err);
            }
         },
      );

   // ── Family tools ────────────────────────────
   registerYoutubeTool(server, cfg);
   registerRedditTool(server, cfg);
   registerGitHubTool(server, cfg);
   registerPackagesTool(server, cfg);
   registerResearchTool(server, cfg);

   // ── deep_research ────────────────────────────
   if (!gated.has('deep_research')) registerDeepResearchTool(server, cfg);

   // ── health_check ──────────────────────────────────────────────────────
   server.registerTool(
      'health_check',
      {
         description:
            'Run a live health check across all search tools. Returns per-tool status (healthy, degraded, unconfigured, rate_limited, unreachable) with remediation hints, plus an overall server status. No caching — always reflects current state. Use this to diagnose failures or verify configuration before relying on a tool.',
         inputSchema: {},
      },
      async () => {
         logger.info({ tool: 'health_check' }, 'Tool invoked');
         const start = Date.now();
         try {
            const report = await runHealthProbes(cfg);
            const result = makeResult('health_check', report, Date.now() - start);
            return successResponse(result);
         } catch (err: unknown) {
            logger.error({ err, tool: 'health_check' }, 'Tool failed');
            return errorResponse(err);
         }
      },
   );

   return server;
}
