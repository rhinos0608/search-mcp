import { z } from 'zod/v4';

export const SourceIdSchema = z.string().min(1).brand<'SourceId'>();
export const SourceAdapterIdSchema = z.string().min(1).brand<'SourceAdapterId'>();
export const SourceListingIdSchema = z.string().min(1).brand<'SourceListingId'>();
export const SourceObservationIdSchema = z.string().min(1).brand<'SourceObservationId'>();
export const EvidenceIdSchema = z.string().min(1).brand<'EvidenceId'>();
export const ClaimCandidateIdSchema = z.string().min(1).brand<'ClaimCandidateId'>();
export const JobPostingIdSchema = z.string().min(1).brand<'JobPostingId'>();
export const IdentityDecisionIdSchema = z.string().min(1).brand<'IdentityDecisionId'>();
export const ContentHashSchema = z.string().min(1).brand<'ContentHash'>();

export type SourceId = z.infer<typeof SourceIdSchema>;
export type SourceAdapterId = z.infer<typeof SourceAdapterIdSchema>;
export type SourceListingId = z.infer<typeof SourceListingIdSchema>;
export type SourceObservationId = z.infer<typeof SourceObservationIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type ClaimCandidateId = z.infer<typeof ClaimCandidateIdSchema>;
export type JobPostingId = z.infer<typeof JobPostingIdSchema>;
export type IdentityDecisionId = z.infer<typeof IdentityDecisionIdSchema>;
export type ContentHash = z.infer<typeof ContentHashSchema>;

export const InstantSchema = z.iso.datetime({ offset: true });
export type Instant = z.infer<typeof InstantSchema>;
export const EvidenceRefSchema = EvidenceIdSchema;
export type EvidenceRef = EvidenceId;
