/**
 * Compact composable jobs family (Checkpoint D product surface).
 *
 * Per ADR-017: strongly typed outer `action` + bounded request.
 * - `search` — full executeJobsSearch run (same runtime as jobs_search).
 * - `capabilities` — action cards with availability + remediation.
 * - `describe_action` — one strict schema, effects, limits, examples.
 * Unsupported/unknown actions return actionable capability-unavailable
 * errors via the family registry (unknown action) or explicit handler
 * errors (e.g. reasoning without budget). No stubs: every registered
 * action invokes the real seam or reports real capability state.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';
import { executeJobsSearch } from '../../jobs/orchestration/search.js';
import { AU_NSW_SYDNEY_LOCALE_PACK } from '../../jobs/packs/auNswSydney.locale.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../jobs/packs/nswPublicAdmin.domain.js';
import { buildJobsMcpDeps, jobspyUnconfigured } from '../jobs/jobsDeps.js';
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
import { mapPublicProfile } from '../jobs/profileMapping.js';

const publicProfileSchema = z
  .object({
    roleHints: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  })
  .strict()
  .refine((value) => value.roleHints !== undefined || value.capabilities !== undefined, {
    message: 'profile requires roleHints or capabilities',
  });

const searchAction = z.object({
  action: z.literal('search').describe('Run a deterministic jobs search over the live seam'),
  query: z.string().min(1).max(512).describe('Job search query, raw text only.'),
  location: z.string().min(1).max(128).optional().describe('Preferred location (ranking signal).'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Ranked candidates (1–50).'),
  sydney: z
    .boolean()
    .optional()
    .describe('Opt in to versioned Sydney/NSW packs. Default false (assumption-free).'),
  useJobSpy: z.boolean().optional().default(true).describe('Include permitted JobSpy boards.'),
  profile: publicProfileSchema
    .optional()
    .describe('Pack-approved role/capability hints; requires sydney:true.'),
});

const capabilitiesAction = z.object({
  action: z.literal('capabilities').describe('List jobs action cards with availability'),
});

const describeActionSchema = z.object({
  action: z.literal('describe_action').describe('Describe one action: schema, effects, limits'),
  name: z.enum(['search', 'capabilities', 'describe_action']).describe('Action to describe.'),
});

const ACTION_CARDS = [
  {
    name: 'jobs.search',
    available: true,
    effects: 'read-only ranked search; no persistence; no side effects',
    limits: 'topK 1–50; budgets fixed per slice; deadline 60s',
  },
  {
    name: 'jobs.capabilities',
    available: true,
    effects: 'read-only capability report',
    limits: 'none',
  },
  {
    name: 'jobs.describe_action',
    available: true,
    effects: 'read-only schema description',
    limits: 'name must be a registered action',
  },
] as const;

const jobsFamily: FamilyDefinition = {
  name: 'jobs',
  description:
    'Composable jobs search over the deterministic seam. ' +
    'Actions: `search` (ranked search), `capabilities` (action cards), `describe_action` (one strict schema). ' +
    'Sydney packs opt-in only; use jobs_search for this surface.',
  defaultAction: 'search',
  actions: [
    {
      name: 'search',
      description: 'Run a deterministic jobs search over the live seam',
      schema: searchAction,
      handler: async (args, cfg) => {
        const a = args as z.infer<typeof searchAction>;
        const deps = buildJobsMcpDeps(cfg);
        const sydney = a.sydney === true;
        if (deps.providerIds.length === 0 && (!a.useJobSpy || deps.jobspyBoards.length === 0)) {
          throw new Error(
            'jobs.search unavailable: no indexed providers configured and no permitted JobSpy boards are configured. ' +
              'Configure a search backend or an explicitly approved JobSpy board.',
          );
        }
        const runId = randomUUID();
        const capturedAt = new Date().toISOString();
        const mappedProfile =
          a.profile !== undefined
            ? sydney
              ? mapPublicProfile(a.profile, NSW_PUBLIC_ADMIN_DOMAIN_PACK)
              : (() => {
                  throw new Error('profile requires sydney:true so terms can be pack-approved');
                })()
            : undefined;
        const topK = a.topK;
        const stageBudgets = deriveStageBudgets(topK);
        const seekEntry = buildSeekEntry(SEEK_POLICY_EVIDENCE);
        const plannedSlices = buildPlan(
          {
            query: a.query,
            useJobSpy: a.useJobSpy,
            jobspyFetchDescription: cfg.jobsAcquisition.jobspyFetchDescription,
            resultsWanted: 20,
            ...(a.location !== undefined ? { location: a.location } : {}),
            sydney,
          },
          runId,
          deps.providerIds,
          deps.jobspyBoards,
          {
            topK,
            ports: deps.ports,
            stageBudgets,
            informationalEdgesFor: (sourceId, providerId) =>
              sourceId === 'board:seek'
                ? informationalSeekEdgesFromEntry(
                    seekEntry,
                    { kind: 'provider', namespace: 'search-provider', id: providerId },
                    capturedAt,
                  )
                : [],
          },
        );
        const supporting = supportingIndexedProviderCount(deps.ports);
        const runBudget = deriveJobsRunBudget(plannedSlices.length, supporting, stageBudgets);
        const data = await executeJobsSearch(
          {
            intent: {
              query: a.query,
              localePackIds: sydney ? ['au-nsw-sydney'] : [],
              domainPackIds: sydney ? ['nsw-public-admin'] : [],
              requestedRoleFamilies: [],
              sectors: [],
              locations: a.location ? [{ city: a.location }] : [],
              workModes: [],
              employmentTypes: [],
              compensation: [],
              sourceIds: [],
              explorationBreadth: 'balanced',
              strictness: 'normal',
              unknownPolicy: 'include',
              topK,
              budgets: {
                requests: runBudget.logicalRequests,
                pages: 10,
                bytes: 200000,
                milliseconds: runBudget.milliseconds,
                enrichment: stageBudgets.indexedEnrichment,
                reasoning: 0,
              },
              evidenceRefs: [],
            },
            plan: plannedSlices,
            runId,
            capturedAt,
            budget: runBudget,
            ...(sydney
              ? { localePack: AU_NSW_SYDNEY_LOCALE_PACK, domainPack: NSW_PUBLIC_ADMIN_DOMAIN_PACK }
              : {}),
            ...(mappedProfile !== undefined
              ? {
                  profileInput: mappedProfile.profileInput,
                  allowedProfileTermRefs: mappedProfile.allowedTermRefs,
                }
              : {}),
          },
          deps,
        );
        const unconfigured = jobspyUnconfigured(deps, a.useJobSpy);
        return {
          runId: data.runId,
          status: data.status,
          packVersions: data.versions.packVersions,
          candidates: data.candidates.map((c) => ({
            rank: c.rank,
            title: c.title,
            organisation: c.organisation,
            utility: Math.round(c.utility * 1000) / 1000,
            coverage: Math.round(c.coverage * 1000) / 1000,
            confidence: Math.round(c.confidence * 1000) / 1000,
            eligibility: c.eligibility,
            evidenceState: c.evidenceState,
            // Posting locator (canonical, credential-free) + bounded posting
            // facts. Evidence refs/text stay non-public.
            ...(c.listingUrl !== undefined ? { listingUrl: c.listingUrl } : {}),
            ...(c.applyUrl !== undefined ? { applyUrl: c.applyUrl } : {}),
            ...(c.location !== undefined ? { location: c.location } : {}),
            ...(c.salaryText !== undefined ? { salaryText: c.salaryText } : {}),
            ...(c.description !== undefined ? { description: c.description } : {}),
            flags: c.flags,
            caveats: c.caveats,
            provenance: c.provenance,
            sourceListingIds: c.sourceListingIds,
            observationIds: c.observationIds,
          })),
          eligibilitySummary: data.eligibilitySummary,
          coverageOutcomes: data.coverageOutcomes,
          ...(unconfigured || data.warnings.length > 0
            ? {
                warnings: [
                  ...(unconfigured
                    ? ['jobspy_unconfigured: useJobSpy requested but no boards authorized']
                    : []),
                  ...data.warnings,
                ],
              }
            : {}),
        };
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'capabilities',
      description: 'List jobs action cards with availability',
      schema: capabilitiesAction,
      handler: async (args, cfg) => {
        void args;
        const deps = buildJobsMcpDeps(cfg);
        const searchAvailable = deps.providerIds.length > 0 || deps.jobspyBoards.length > 0;
        return ACTION_CARDS.map((c) =>
          c.name === 'jobs.search'
            ? {
                ...c,
                available: searchAvailable,
                ...(searchAvailable
                  ? {}
                  : {
                      remediation:
                        'Configure a search backend (EXA_API_KEY, BRAVE_API_KEY, SEARXNG_BASE_URL) or use JobSpy boards.',
                    }),
              }
            : c,
        );
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'describe_action',
      description: 'Describe one action: schema, effects, limits',
      schema: describeActionSchema,
      handler: async (args) => {
        const a = args as z.infer<typeof describeActionSchema>;
        const card = ACTION_CARDS.find((c) => c.name === `jobs.${a.name}`);
        if (!card) {
          throw new Error(
            `jobs.describe_action unavailable: unknown action "${a.name}". ` +
              'Registered actions: search, capabilities, describe_action.',
          );
        }
        return {
          name: card.name,
          schema:
            a.name === 'search'
              ? {
                  required: ['query'],
                  properties: { query: 'string', topK: 'integer 1-50', sydney: 'boolean' },
                }
              : { required: ['action'], properties: { action: 'literal ' + a.name } },
          effects: card.effects,
          limits: card.limits,
          examples:
            a.name === 'search'
              ? ['{ "action": "search", "query": "registry officer Sydney", "sydney": true }']
              : [`{ "action": "${a.name}" }`],
        };
      },
      annotations: { readOnlyHint: true },
    },
  ],
};

export function registerJobsTool(server: McpServer, cfg: SearchConfig): void {
  registerFamily(server, jobsFamily, cfg);
  logger.info({ tool: 'jobs', actions: jobsFamily.actions.length }, 'Jobs family registered');
}

export function jobsCapabilities(cfg: SearchConfig) {
  const deps = buildJobsMcpDeps(cfg);
  const searchAvailable = deps.providerIds.length > 0 || deps.jobspyBoards.length > 0;
  return jobsFamily.actions.map((a) => ({
    name: `jobs.${a.name}`,
    available: a.name === 'search' ? searchAvailable : true,
    issue:
      a.name === 'search' && !searchAvailable
        ? 'Configure an indexed provider or enable JobSpy boards.'
        : null,
  }));
}

export function jobsMcpActionCards() {
  return ACTION_CARDS.map((c) => ({ ...c }));
}
