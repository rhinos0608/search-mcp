import { createHash } from 'node:crypto';
import type { IdentityFeatureName, IdentityFeatureVector, IdentitySubject } from './contracts.js';
import type { EvidenceRef } from '../domain/ids.js';

/**
 * Extract identity features from a single subject.
 *
 * Missing features omit keys (ADR-007). Never invent values.
 * Indexed-only subjects are not identity subjects; caller must not pass them.
 */
export function extractIdentityFeatures(subject: IdentitySubject): IdentityFeatureVector {
  const features: Record<string, unknown> = {};
  const evidenceByFeature: Partial<Record<IdentityFeatureName, EvidenceRef[]>> = {};

  // Strong: source_listing_id (always present)
  features.source_listing_id = subject.listing.sourceListingId;
  evidenceByFeature.source_listing_id = [];

  // Strong: adapter_external_id (only if adapterId + externalId both present)
  if (subject.listing.externalId) {
    features.adapter_external_id = `${subject.listing.adapterId}:${subject.listing.externalId}`;
    evidenceByFeature.adapter_external_id = [];
  }

  // Strong: canonical_url
  if (subject.listing.canonicalUrl) {
    features.canonical_url = subject.listing.canonicalUrl;
    evidenceByFeature.canonical_url = [];
  }

  // Strong: content_hash (only if fetchOutcome = success)
  if (subject.observation.fetchOutcome === 'success') {
    features.content_hash = subject.observation.contentHash;
    evidenceByFeature.content_hash = subject.observation.evidenceRefs.slice(0, 8);
  }

  // Strong: requisition_id (from posting projection claims)
  const posting = subject.postingProjection;
  if (posting?.claimResolutions) {
    const reqClaim = posting.claimResolutions.requisition_id;
    if (reqClaim?.state === 'resolved') {
      features.requisition_id = reqClaim.selected.value;
      evidenceByFeature.requisition_id = [];
    }
  }

  // Corroborating: apply_url
  if (posting?.applyUrl) {
    features.apply_url = posting.applyUrl;
    evidenceByFeature.apply_url = [];
  }

  // Corroborating: description_fingerprint (deterministic simhash over normalized text)
  if (posting?.description) {
    features.description_fingerprint = simhash64(posting.description);
    evidenceByFeature.description_fingerprint = [];
  }

  // Corroborating: posted_at_proximity
  if (posting?.postedAt) {
    features.posted_at_proximity = posting.postedAt;
    evidenceByFeature.posted_at_proximity = [];
  }

  // Corroborating: location_overlap
  if (posting?.locations && posting.locations.length > 0) {
    features.location_overlap = posting.locations.map(
      (l) => `${l.country ?? ''}:${l.region ?? ''}:${l.city ?? ''}`,
    );
    evidenceByFeature.location_overlap = [];
  }

  // Corroborating: salary_overlap
  if (posting?.salaries && posting.salaries.length > 0) {
    features.salary_overlap = posting.salaries.map((s) => {
      const min = s.min !== undefined ? String(s.min) : '';
      const max = s.max !== undefined ? String(s.max) : '';
      return `${s.currency}:${s.unit}:${min}:${max}`;
    });
    evidenceByFeature.salary_overlap = [];
  }

  // Weak: organisation_normalized (NEVER sufficient alone)
  if (posting?.organisation) {
    features.organisation_normalized = normalizeOrganisation(posting.organisation);
    evidenceByFeature.organisation_normalized = [];
  }

  // Weak: title_normalized (NEVER sufficient alone)
  if (posting?.normalizedTitle) {
    features.title_normalized = posting.normalizedTitle;
    evidenceByFeature.title_normalized = [];
  }

  // Veto: contradictory_employer (from claims)
  if (posting?.claimResolutions) {
    const employerClaim = posting.claimResolutions.employer;
    if (employerClaim?.state === 'conflicting') {
      features.contradictory_employer = true;
      evidenceByFeature.contradictory_employer = [];
    }
  }

  // Veto: contradictory_location (from location claims)
  if (posting?.claimResolutions) {
    const locClaim = posting.claimResolutions.location;
    if (locClaim?.state === 'conflicting') {
      features.contradictory_location = true;
      evidenceByFeature.contradictory_location = [];
    }
  }

  // Veto: contradictory_dates (from date claims)
  if (posting?.claimResolutions) {
    const dateClaim = posting.claimResolutions.posted_at;
    if (dateClaim?.state === 'conflicting') {
      features.contradictory_dates = true;
      evidenceByFeature.contradictory_dates = [];
    }
  }

  // Veto: contradictory_requisition
  if (posting?.claimResolutions) {
    const reqClaim = posting.claimResolutions.requisition_id;
    if (reqClaim?.state === 'conflicting') {
      features.contradictory_requisition = true;
      evidenceByFeature.contradictory_requisition = [];
    }
  }

  return {
    subject: {
      observationId: subject.observation.observationId,
      listingId: subject.listing.sourceListingId,
    },
    features: features as Readonly<Record<IdentityFeatureName, unknown>>,
    evidenceByFeature,
    extractorVersion: subject.observation.extractionVersion,
  };
}

/** Deterministic 64-bit simhash over normalized text. Returns hex string. */
function simhash64(text: string): string {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  const bits = new Int32Array(64);
  for (const token of normalized.split(' ')) {
    const digest = createHash('sha256').update(token, 'utf8').digest();
    for (let j = 0; j < 64; j++) {
      const set = ((digest[j >> 3] ?? 0) & (1 << (j & 7))) !== 0;
      bits[j] = (bits[j] ?? 0) + (set ? 1 : -1);
    }
  }
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if ((bits[i] ?? 0) > 0) hash |= 1n << BigInt(i);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Normalise organisation name: lowercase, collapse whitespace, strip punctuation. */
function normalizeOrganisation(org: string): string {
  return org
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\w\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
