import { z } from 'zod/v4';

const boundedId = z.string().trim().min(1).max(256);

export const AcquisitionEdgeIdSchema = boundedId.brand<'AcquisitionEdgeId'>();
export const AcquisitionCandidateIdSchema = boundedId.brand<'AcquisitionCandidateId'>();
export const AcquisitionRunIdSchema = boundedId.brand<'AcquisitionRunId'>();
export const AcquisitionSliceIdSchema = boundedId.brand<'AcquisitionSliceId'>();
export const DiscoveryEvidenceIdSchema = boundedId.brand<'DiscoveryEvidenceId'>();

export type AcquisitionEdgeId = z.infer<typeof AcquisitionEdgeIdSchema>;
export type AcquisitionCandidateId = z.infer<typeof AcquisitionCandidateIdSchema>;
export type AcquisitionRunId = z.infer<typeof AcquisitionRunIdSchema>;
export type AcquisitionSliceId = z.infer<typeof AcquisitionSliceIdSchema>;
export type DiscoveryEvidenceId = z.infer<typeof DiscoveryEvidenceIdSchema>;
