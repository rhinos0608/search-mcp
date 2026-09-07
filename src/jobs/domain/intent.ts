import { z } from 'zod/v4';
import { EvidenceRefSchema, InstantSchema } from './ids.js';
import { LocationSchema, SalaryIntervalSchema } from './posting.js';

export const SearchIntentSchema = z
  .object({
    query: z.string().min(1),
    profileHandle: z.string().min(1).optional(),
    profileRevision: z.string().min(1).optional(),
    localePackIds: z.array(z.string().min(1)),
    domainPackIds: z.array(z.string().min(1)),
    requestedRoleFamilies: z.array(z.string().min(1)),
    sectors: z.array(z.string().min(1)),
    locations: z.array(LocationSchema),
    freshnessSince: InstantSchema.optional(),
    workModes: z.array(z.enum(['onsite', 'hybrid', 'remote', 'unknown'])),
    employmentTypes: z.array(
      z.enum([
        'full_time',
        'part_time',
        'casual',
        'contract',
        'temporary',
        'internship',
        'unknown',
      ]),
    ),
    compensation: z.array(SalaryIntervalSchema),
    sourceIds: z.array(z.string().min(1)),
    explorationBreadth: z.enum(['focused', 'balanced', 'broad']),
    strictness: z.enum(['normal', 'strict']),
    unknownPolicy: z.enum(['include', 'exclude']),
    topK: z.number().int().positive().max(100),
    budgets: z
      .object({
        requests: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        milliseconds: z.number().int().positive(),
        enrichment: z.number().int().nonnegative(),
        reasoning: z.number().int().nonnegative(),
      })
      .strict(),
    evidenceRefs: z.array(EvidenceRefSchema),
  })
  .strict();
export type SearchIntent = z.infer<typeof SearchIntentSchema>;
export const QueryPlanSchema = z
  .object({
    planId: z.string().min(1),
    version: z.string().min(1),
    normalizedIntent: SearchIntentSchema,
    selectedPackVersions: z.array(z.string().min(1)),
    searchSlices: z.array(
      z.object({ query: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    adapterDecisions: z.array(
      z.object({ adapterId: z.string().min(1), decision: z.string().min(1) }).strict(),
    ),
    budgets: SearchIntentSchema.shape.budgets,
    warnings: z.array(z.string()),
    evidenceRefs: z.array(EvidenceRefSchema),
    reproducibilityInputs: z.record(z.string(), z.string()),
  })
  .strict();
export type QueryPlan = z.infer<typeof QueryPlanSchema>;
