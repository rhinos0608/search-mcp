import { z } from 'zod/v4';
import type { IdentityFeatureContribution } from '../domain/identity.js';
import { IdentityOutcomeSchema } from '../domain/identity.js';
type IdentityOutcome = z.infer<typeof IdentityOutcomeSchema>;
import type { EvidenceRef, SourceListingId, SourceObservationId } from '../domain/ids.js';
import type { SourceListing, SourceObservation } from '../domain/source.js';
import type { JobPosting } from '../domain/posting.js';

export const IDENTITY_CONTRACT_VERSION = '1.0.0' as const;
export const IDENTITY_RESOLVER_VERSION = 'identity-resolver/1.0.0' as const;

export const IdentityFeatureNameSchema = z.enum([
  'source_listing_id',
  'adapter_external_id',
  'canonical_url',
  'content_hash',
  'requisition_id',
  'apply_url',
  'description_fingerprint',
  'posted_at_proximity',
  'location_overlap',
  'salary_overlap',
  'organisation_normalized',
  'title_normalized',
  'contradictory_employer',
  'contradictory_location',
  'contradictory_dates',
  'contradictory_requisition',
]);
export type IdentityFeatureName = z.infer<typeof IdentityFeatureNameSchema>;

export interface IdentitySubject {
  listing: SourceListing;
  observation: SourceObservation;
  postingProjection?: Pick<
    JobPosting,
    | 'title'
    | 'normalizedTitle'
    | 'organisation'
    | 'locations'
    | 'salaries'
    | 'applyUrl'
    | 'listingUrls'
    | 'postedAt'
    | 'closingAt'
    | 'description'
    | 'claimCandidates'
    | 'claimResolutions'
    | 'evidenceRefs'
  >;
}

export interface IdentityFeatureVector {
  subject: { observationId: SourceObservationId; listingId: SourceListingId };
  features: Readonly<Record<IdentityFeatureName, unknown>>;
  evidenceByFeature: Readonly<Partial<Record<IdentityFeatureName, EvidenceRef[]>>>;
  extractorVersion: string;
}

export interface PairScore {
  leftObservationId: SourceObservationId;
  rightObservationId: SourceObservationId;
  contributions: IdentityFeatureContribution[];
  contradictoryEvidenceRefs: EvidenceRef[];
  score: number;
  proposedOutcome: IdentityOutcome;
  confidence: number;
}

export type IdentityClusterId = string;

export interface IdentityCluster {
  clusterId: IdentityClusterId;
  kind: 'same_posting' | 'probable_cluster';
  memberObservationIds: string[];
  memberListingIds: string[];
  activeDecisionIds: string[];
  revision: string;
}
