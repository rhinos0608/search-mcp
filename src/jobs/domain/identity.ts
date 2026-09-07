import { z } from 'zod/v4';
import {
  EvidenceRefSchema,
  IdentityDecisionIdSchema,
  InstantSchema,
  SourceListingIdSchema,
  SourceObservationIdSchema,
} from './ids.js';

export const IdentityOutcomeSchema = z.enum([
  'same_posting',
  'probable_cluster',
  'distinct',
  'unresolved',
  'split',
]);
export const IdentityFeatureContributionSchema = z
  .object({
    feature: z.string().min(1),
    contribution: z.number(),
    evidenceRefs: z.array(EvidenceRefSchema),
  })
  .strict();
export type IdentityFeatureContribution = z.infer<typeof IdentityFeatureContributionSchema>;
export const IdentityDecisionSchema = z
  .object({
    decisionId: IdentityDecisionIdSchema,
    subjectObservationIds: z.array(SourceObservationIdSchema).min(1),
    subjectListingIds: z.array(SourceListingIdSchema).min(1),
    outcome: IdentityOutcomeSchema,
    confidence: z.number().min(0).max(1),
    featureContributions: z.array(IdentityFeatureContributionSchema),
    contradictoryEvidenceRefs: z.array(EvidenceRefSchema),
    resolverVersion: z.string().min(1),
    createdAt: InstantSchema,
    supersededBy: IdentityDecisionIdSchema.optional(),
  })
  .strict();
export type IdentityDecision = z.infer<typeof IdentityDecisionSchema>;
