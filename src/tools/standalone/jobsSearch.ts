/**
 * jobs_search standalone MCP tool (Checkpoint D product surface).
 *
 * Additive high-level search over the frozen executeJobsSearch seam.
 * Builds a real acquisition plan from intent (indexed providers +
 * permitted JobSpy boards), selects Sydney packs only when the caller
 * explicitly opts in (sydney:true or pack IDs) — generic core carries
 * no AU assumptions. Legacy search surfaces are not registered.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { tolerant } from '../normalize.js';
import { makeResult, errorResponse, successResponse } from '../response.js';
import { jobErrorCode, jobTelemetry } from '../../utils/jobTelemetry.js';
import { executeJobsSearch } from '../../jobs/orchestration/search.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../jobs/packs/nswPublicAdmin.domain.js';
import {
  buildJobsMcpDeps,
  jobspyUnconfigured,
  type JobsMcpDependencies,
} from '../jobs/jobsDeps.js';
import {
  buildPlan,
  deriveJobsRunBudget,
  deriveStageBudgets,
  supportingIndexedProviderCount,
} from '../jobs/planBuilder.js';
import {
  buildSeekEntry,
  informationalSeekEdgesFromEntry,
} from '../../jobs/acquisition/sourceClass/seek.js';
import { SEEK_POLICY_EVIDENCE } from '../../jobs/acquisition/sourceClass/evidence/livePolicyEvidence.js';
import { SEEK_DESTINATION_CLASS } from '../../jobs/acquisition/destinationClass.js';
import {
  mapPublicProfile,
  publicProfileSchema,
  type PublicProfileInput,
} from '../jobs/profileMapping.js';
import { buildJobsSearchExecutionRequest, projectJobsCandidate } from '../jobs/searchBuilder.js';

const inputSchema = {
  query: z
    .string()
    .min(1)
    .max(512)
    .describe('Job search query, e.g. "registry officer Sydney". Raw text only.'),
  location: z
    .array(z.string().min(1).max(128))
    .max(8)
    .optional()
    .describe('Preferred locations, e.g. ["Sydney", "Parramatta"]. Ranking signal only.'),
  workMode: z
    .array(z.enum(['remote', 'hybrid', 'onsite']))
    .max(3)
    .optional()
    .describe('Preferred work modes. Ranking signal only.'),
  isRemote: z.boolean().optional().describe('Restrict JobSpy boards to remote roles.'),
  jobType: z
    .enum(['fulltime', 'parttime', 'contract', 'temporary', 'internship'])
    .optional()
    .describe('JobSpy contract filter.'),
  sydney: z
    .boolean()
    .optional()
    .describe(
      'Opt in to the versioned Sydney/NSW locale + domain packs (au-nsw-sydney, nsw-public-admin). ' +
        'Default false: generic core carries no AU assumptions.',
    ),
  useJobSpy: z.boolean().optional().default(true).describe('Include permitted JobSpy boards.'),
  resultsWanted: tolerant(z.number().int().min(1).max(50))
    .optional()
    .default(20)
    .describe('Per-board results wanted (1–50, default 20).'),
  profile: publicProfileSchema
    .optional()
    .describe('Pack-approved role/capability hints; requires sydney:true.'),
  topK: tolerant(z.number().int().min(1).max(50))
    .optional()
    .default(10)
    .describe('Ranked candidates to return (1–50, default 10).'),
};

interface JobsSearchArgs {
  query: string;
  location?: string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  isRemote?: boolean;
  jobType?: 'fulltime' | 'parttime' | 'contract' | 'temporary' | 'internship';
  sydney?: boolean;
  useJobSpy?: boolean;
  resultsWanted?: number;
  topK?: number;
  profile?: PublicProfileInput;
}

export function registerJobsSearch(
  server: McpServer,
  cfg: SearchConfig,
  injectedDeps?: JobsMcpDependencies,
): void {
  server.registerTool(
    'jobs_search',
    {
      description:
        'Deterministic jobs search over indexed providers and permitted JobSpy boards with ' +
        'policy-gated acquisition, extraction, identity, retrieval, assessment, and ranking. ' +
        'Pass sydney:true to opt in to versioned Sydney/NSW packs; default is assumption-free generic core.',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const parsed = z.object(inputSchema).safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return errorResponse(
          new Error(`jobs_search validation error: ${issues.join('; ')}`),
          'jobs_search',
        );
      }
      const args = parsed.data as unknown as JobsSearchArgs;
      logger.info({ tool: 'jobs_search', ...jobTelemetry({ query: args.query }) }, 'Tool invoked');
      const start = Date.now();
      try {
        const deps: JobsMcpDependencies = injectedDeps ?? buildJobsMcpDeps(cfg);
        const sydney = args.sydney === true;
        if (
          deps.providerIds.length === 0 &&
          (args.useJobSpy !== true || deps.jobspyBoards.length === 0)
        ) {
          return errorResponse(
            new Error(
              'jobs_search unavailable: no indexed providers configured and no permitted JobSpy boards are configured. ' +
                'Configure a search backend or an explicitly approved JobSpy board.',
            ),
            'jobs_search',
          );
        }
        const runId = randomUUID();
        const capturedAt = new Date().toISOString();
        if (args.profile !== undefined && !sydney) {
          throw new Error('profile requires sydney:true so terms can be pack-approved');
        }
        const mappedProfile =
          args.profile !== undefined
            ? mapPublicProfile(args.profile, NSW_PUBLIC_ADMIN_DOMAIN_PACK)
            : undefined;
        const topK = args.topK ?? 10;
        const stageBudgets = deriveStageBudgets(topK);
        const seekEntry = buildSeekEntry(SEEK_POLICY_EVIDENCE);
        const plannedSlices = buildPlan(
          {
            ...args,
            jobspyFetchDescription: cfg.jobsAcquisition.jobspyFetchDescription,
          },
          runId,
          deps.providerIds,
          deps.jobspyBoards,
          {
            topK,
            ports: deps.ports,
            stageBudgets,
            informationalEdgesFor: (sourceId, providerId) =>
              sourceId === SEEK_DESTINATION_CLASS.id
                ? informationalSeekEdgesFromEntry(seekEntry, {
                    kind: 'provider',
                    namespace: 'search-provider',
                    id: providerId,
                  })
                : [],
          },
        );
        const supporting = supportingIndexedProviderCount(deps.ports);
        const runBudget = deriveJobsRunBudget(plannedSlices.length, supporting, stageBudgets);
        const request = buildJobsSearchExecutionRequest({
          query: args.query,
          topK,
          sydney,
          locations: (args.location ?? []).map((city) => ({ city })),
          workModes: (args.workMode ?? []).map((m) =>
            m === 'remote' ? 'remote' : m === 'hybrid' ? 'hybrid' : 'onsite',
          ),
          plan: plannedSlices,
          runId,
          capturedAt,
          runBudget,
          stageBudgets,
          mappedProfile,
        });
        const data = await executeJobsSearch(request, deps);
        const result = makeResult(
          'jobs_search',
          {
            runId: data.runId,
            status: data.status,
            packVersions: data.versions.packVersions,
            candidates: data.candidates.map(projectJobsCandidate),
            eligibilitySummary: data.eligibilitySummary,
            coverageOutcomes: data.coverageOutcomes,
          },
          Date.now() - start,
          {
            ...(jobspyUnconfigured(deps, args.useJobSpy) || data.warnings.length > 0
              ? {
                  warnings: [
                    ...(jobspyUnconfigured(deps, args.useJobSpy)
                      ? ['jobspy_unconfigured: useJobSpy requested but no boards authorized']
                      : []),
                    ...data.warnings,
                  ],
                }
              : {}),
          },
        );
        return successResponse(result);
      } catch (err: unknown) {
        logger.error(
          { tool: 'jobs_search', stage: 'tool', errorCode: jobErrorCode(err) },
          'Tool failed',
        );
        return errorResponse(err, 'jobs_search');
      }
    },
  );
}
