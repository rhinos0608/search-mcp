/**
 * Standalone semantic_jobs tool registration.
 *
 * Search for job listings across 20+ job boards with semantic ranking
 * and constraint filtering.
 */

import { z } from 'zod/v4';
import { tolerant } from '../normalize.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../../semanticLimits.js';
import { semanticJobs } from '../semanticJobs.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import { correctQuery } from '../../utils/fuzzyCorrection.js';
import { applyIntentFilter, type IntentFilterResult } from '../../utils/intentFilter.js';

export function registerSemanticJobs(server: McpServer, cfg: SearchConfig): void {
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
        maxSalary: tolerant(z.number().positive())
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
        maxPages: tolerant(z.number().int().min(1).max(50))
          .optional()
          .default(20)
          .describe('Maximum number of job listing pages to crawl (1–50, default 20)'),
        topK: tolerant(z.number().int().min(1).max(50))
          .optional()
          .default(10)
          .describe('Number of top-ranked job listings to return (1–50, default 10)'),
        maxBytes: tolerant(z.number().int().min(1).max(DEFAULT_SEMANTIC_MAX_BYTES))
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
        fuzzyCorrect: z
          .boolean()
          .optional()
          .default(true)
          .describe('Auto-correct typos in the query using Levenshtein fuzzy matching.'),
        intent: z
          .string()
          .optional()
          .describe('Natural language intent for result filtering when output exceeds ~5KB.'),
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
      fuzzyCorrect,
      intent,
    }) => {
      logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Tool invoked');
      const start = Date.now();
      try {
        let query_ = query;
        let correction:
          | {
              original: string;
              corrected: string;
              changes: { original: string; corrected: string; distance: number }[];
            }
          | undefined;
        if (fuzzyCorrect) {
          const cr = correctQuery(query);
          if (cr.changes.length > 0) {
            correction = { original: query, corrected: cr.corrected, changes: cr.changes };
            query_ = cr.corrected;
          }
        }

        const data = await semanticJobs({
          query: query_,
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
        let intentFilterResult: IntentFilterResult<(typeof data.results)[number]> | undefined;
        if (intent) {
          intentFilterResult = applyIntentFilter(
            data.results,
            intent,
            5000,
            (item) =>
              `${item.listing.title} ${item.listing.company ?? ''} ${item.listing.location ?? ''}`,
          );
        }
        const filteredResults = intentFilterResult?.filtered
          ? intentFilterResult.results
          : data.results;

        const result = makeResult(
          'semantic_jobs',
          {
            results: filteredResults.map((scored, index) => ({
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
            ...(correction ? { correction } : {}),
            ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
            ...(intentFilterResult ? { intentFilter: intentFilterResult } : {}),
          },
        );
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'semantic_jobs' }, 'Tool failed');
        return errorResponse(err, 'semantic_jobs');
      }
    },
  );
}
