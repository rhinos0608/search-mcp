/* eslint-disable @typescript-eslint/dot-notation */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { LifecycleEvent, LifecycleState } from '../domain/lifecycle.js';
import type { JobsDatabase } from './contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rowToListing(row: Record<string, unknown>) {
  return {
    sourceListingId: row['source_listing_id'] as string,
    adapterId: row['adapter_id'] as string,
    externalId: row['external_id'] as string | undefined,
    canonicalUrl: row['canonical_url'] as string | undefined,
    firstSeenAt: row['first_seen_at'] as string,
    lastSeenAt: row['last_seen_at'] as string,
    currentObservationId: row['current_observation_id'] as string,
  };
}

function rowToObservation(row: Record<string, unknown>, db: JobsDatabase) {
  const refs = (
    db
      .prepare(
        'SELECT evidence_id FROM observation_evidence_refs WHERE observation_id = ? ORDER BY ordinal',
      )
      .all(row['observation_id'] as string) as { evidence_id: string }[]
  ).map((r) => r.evidence_id);
  return {
    observationId: row['observation_id'] as string,
    sourceListingId: row['source_listing_id'] as string,
    fetchedAt: row['fetched_at'] as string,
    contentHash: row['content_hash'] as string,
    payloadRef: row['payload_ref'] as string | undefined,
    evidenceRefs: refs,
    extractionVersion: row['extraction_version'] as string,
    adapterVersion: row['adapter_version'] as string,
    fetchOutcome: row['fetch_outcome'] as 'success' | 'partial' | 'failed' | 'not_supported',
    sourceConfidence: JSON.parse(row['source_confidence_json'] as string) as Record<string, number>,
    immutable: true as const,
  };
}

function rowToIdentityDecision(row: Record<string, unknown>) {
  return {
    decisionId: row['decision_id'] as string,
    subjectObservationIds: [] as string[],
    subjectListingIds: [] as string[],
    outcome: row['outcome'] as
      | 'same_posting'
      | 'probable_cluster'
      | 'distinct'
      | 'unresolved'
      | 'split',
    confidence: row['confidence'] as number,
    featureContributions: [] as { feature: string; contribution: number; evidenceRefs: string[] }[],
    contradictoryEvidenceRefs: [] as string[],
    resolverVersion: row['resolver_version'] as string,
    createdAt: row['created_at'] as string,
    supersededBy: row['superseded_by'] as string | undefined,
  };
}

function rowToPosting(row: Record<string, unknown>, db: JobsDatabase): Any {
  const pid = row['posting_id'] as string;
  const roleFamilies = (
    db.prepare('SELECT * FROM posting_role_families WHERE posting_id = ?').all(pid) as Record<
      string,
      Any
    >[]
  ).map((r) => ({
    family: r['family'] as string,
    confidence: r['confidence'] as number,
    evidenceRefs: [] as string[],
  }));
  const listingUrls = (
    db.prepare('SELECT url FROM posting_listing_urls WHERE posting_id = ?').all(pid) as {
      url: string;
    }[]
  ).map((r) => r.url);
  const responsibilities = (
    db
      .prepare('SELECT text FROM posting_responsibilities WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const desirableCriteria = (
    db
      .prepare('SELECT text FROM posting_desirable WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const applicationRequirements = (
    db
      .prepare(
        'SELECT text FROM posting_application_requirements WHERE posting_id = ? ORDER BY ordinal',
      )
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const selectionQuestions = (
    db
      .prepare('SELECT text FROM posting_selection_questions WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const licencesChecksRegistration = (
    db
      .prepare('SELECT text FROM posting_licences WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const flags = (
    db.prepare('SELECT flag FROM posting_flags WHERE posting_id = ?').all(pid) as { flag: string }[]
  ).map((r) => r.flag);
  const caveats = (
    db
      .prepare('SELECT text FROM posting_caveats WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as { text: string }[]
  ).map((r) => r.text);
  const feLinks = db
    .prepare('SELECT field_path, evidence_id FROM posting_field_evidence WHERE posting_id = ?')
    .all(pid) as { field_path: string; evidence_id: string }[];
  const fieldEvidenceLinks: { fieldPath: string; evidenceRefs: string[] }[] = [];
  for (const fe of feLinks) {
    const existing = fieldEvidenceLinks.find((l) => l.fieldPath === fe.field_path);
    if (existing) existing.evidenceRefs.push(fe.evidence_id);
    else fieldEvidenceLinks.push({ fieldPath: fe.field_path, evidenceRefs: [fe.evidence_id] });
  }
  const salaries = (
    db
      .prepare('SELECT * FROM posting_salaries WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as Record<string, Any>[]
  ).map((r) => ({
    min: r['min'] as number | undefined,
    max: r['max'] as number | undefined,
    currency: r['currency'] as string,
    unit: r['unit'] as Any,
    period: r['period'] as Any,
    raw: r['raw'] as string,
  }));
  const classifications = (
    db
      .prepare('SELECT * FROM posting_classifications WHERE posting_id = ? ORDER BY ordinal')
      .all(pid) as Record<string, Any>[]
  ).map((r) => ({
    scheme: r['scheme'] as string,
    value: r['value'] as string,
    level: r['level'] as string | undefined,
  }));
  return {
    postingId: pid,
    schemaVersion: row['schema_version'] as string,
    canonicalRevision: row['canonical_revision'] as number,
    title: row['title'] as string,
    normalizedTitle: row['normalized_title'] as string,
    organisation: row['organisation'] as string,
    organisationUnit: row['organisation_unit'] as string | undefined,
    sector: row['sector'] as string | undefined,
    industry: row['industry'] as string | undefined,
    roleFamilies,
    locations: [],
    workMode: row['work_mode'] as Any,
    employmentType: row['employment_type'] as Any,
    hoursFte: (row['hours_fte'] as number) ?? undefined,
    salaries,
    classifications,
    seniority: row['seniority'] as Any,
    postedAt: row['posted_at'] as string | undefined,
    closingAt: row['closing_at'] as string | undefined,
    startAt: row['start_at'] as string | undefined,
    applyUrl: row['apply_url'] as string | undefined,
    listingUrls,
    description: row['description'] as string,
    responsibilities,
    requirements: [],
    desirableCriteria,
    applicationRequirements,
    selectionQuestions,
    vacancyCount: (row['vacancy_count'] as number) ?? undefined,
    securityClearance: row['security_clearance'] as string | undefined,
    licencesChecksRegistration,
    workRights: row['work_rights'] as string | undefined,
    targetedPosition:
      row['targeted_position'] === 1 ? true : row['targeted_position'] === 0 ? false : undefined,
    verificationState: row['verification_state'] as Any,
    lifecycleState: row['lifecycle_state'] as Any,
    flags,
    confidence: row['confidence'] as number,
    caveats,
    evidenceRefs: [] as string[],
    fieldEvidenceLinks,
    claimCandidates: undefined,
    claimResolutions: undefined,
    sourceListingIds: [] as string[],
    observationIds: [] as string[],
    identityDecisionRevision: row['identity_decision_revision'] as string,
  };
}

const POSTING_CHILD_TABLES = [
  'posting_role_families',
  'posting_listing_urls',
  'posting_responsibilities',
  'posting_desirable',
  'posting_application_requirements',
  'posting_selection_questions',
  'posting_licences',
  'posting_flags',
  'posting_caveats',
  'posting_field_evidence',
  'posting_salaries',
  'posting_classifications',
];

function deletePostingChildren(db: JobsDatabase, postingId: string): void {
  for (const table of POSTING_CHILD_TABLES)
    db.prepare(`DELETE FROM ${table} WHERE posting_id = ?`).run(postingId);
}

export type { LifecycleEvent, LifecycleState };
export {
  rowToListing,
  rowToObservation,
  rowToIdentityDecision,
  rowToPosting,
  deletePostingChildren,
};
