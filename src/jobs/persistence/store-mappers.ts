/* eslint-disable @typescript-eslint/dot-notation */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { LifecycleEvent, LifecycleState } from '../domain/lifecycle.js';
import { resolveClaim } from '../domain/claims.js';
import { JobsStoreError, JobsStoreErrorCode, type JobsDatabase } from './contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rowToListing(row: Record<string, unknown>) {
  return {
    sourceListingId: row['source_listing_id'] as string,
    adapterId: row['adapter_id'] as string,
    ...(row['external_id'] != null ? { externalId: row['external_id'] as string } : {}),
    ...(row['canonical_url'] != null ? { canonicalUrl: row['canonical_url'] as string } : {}),
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
    ...(row['payload_ref'] != null ? { payloadRef: row['payload_ref'] as string } : {}),
    evidenceRefs: refs,
    extractionVersion: row['extraction_version'] as string,
    adapterVersion: row['adapter_version'] as string,
    fetchOutcome: row['fetch_outcome'] as 'success' | 'partial' | 'failed' | 'not_supported',
    sourceConfidence: JSON.parse(row['source_confidence_json'] as string) as Record<string, number>,
    immutable: true as const,
  };
}

interface IdentityDecisionStatements {
  observations: { all: (id: string) => unknown[] };
  listings: { all: (id: string) => unknown[] };
  features: { all: (id: string) => unknown[] };
  featureEvidence: { all: (id: string) => unknown[] };
  contradictions: { all: (id: string) => unknown[] };
}

function prepareIdentityDecisionStatements(db: JobsDatabase): IdentityDecisionStatements {
  return {
    observations: db.prepare(
      'SELECT observation_id FROM identity_decision_observations WHERE decision_id = ?',
    ),
    listings: db.prepare(
      'SELECT source_listing_id FROM identity_decision_listings WHERE decision_id = ?',
    ),
    features: db.prepare(
      'SELECT feature, contribution FROM identity_decision_features WHERE decision_id = ?',
    ),
    featureEvidence: db.prepare(
      'SELECT feature, evidence_id FROM identity_decision_feature_evidence WHERE decision_id = ?',
    ),
    contradictions: db.prepare(
      'SELECT evidence_id FROM identity_decision_contradictions WHERE decision_id = ?',
    ),
  };
}

function rowToIdentityDecision(
  row: Record<string, unknown>,
  dbOrStmts?: JobsDatabase | IdentityDecisionStatements,
) {
  const decisionId = row['decision_id'] as string;
  // Join tables hold relations writer populates; hydrate them instead of
  // returning empties that would silently erase provenance on read.
  const stmts =
    dbOrStmts && 'prepare' in dbOrStmts
      ? prepareIdentityDecisionStatements(dbOrStmts)
      : (dbOrStmts as IdentityDecisionStatements | undefined);
  const subjectObservationIds = stmts
    ? (stmts.observations.all(decisionId) as { observation_id: string }[]).map(
        (r) => r.observation_id,
      )
    : [];
  const subjectListingIds = stmts
    ? (stmts.listings.all(decisionId) as { source_listing_id: string }[]).map(
        (r) => r.source_listing_id,
      )
    : [];
  const featureRows = stmts
    ? (stmts.features.all(decisionId) as { feature: string; contribution: number }[])
    : [];
  const featureEvidenceRows = stmts
    ? (stmts.featureEvidence.all(decisionId) as { feature: string; evidence_id: string }[])
    : [];
  const evidenceByFeature = new Map<string, string[]>();
  for (const r of featureEvidenceRows) {
    const list = evidenceByFeature.get(r.feature) ?? [];
    list.push(r.evidence_id);
    evidenceByFeature.set(r.feature, list);
  }
  const featureContributions = featureRows.map((f) => ({
    feature: f.feature,
    contribution: f.contribution,
    evidenceRefs: evidenceByFeature.get(f.feature) ?? [],
  }));
  const contradictoryEvidenceRefs = stmts
    ? (stmts.contradictions.all(decisionId) as { evidence_id: string }[]).map((r) => r.evidence_id)
    : [];
  return {
    decisionId,
    subjectObservationIds,
    subjectListingIds,
    outcome: row['outcome'] as
      | 'same_posting'
      | 'probable_cluster'
      | 'distinct'
      | 'unresolved'
      | 'split',
    confidence: row['confidence'] as number,
    featureContributions,
    contradictoryEvidenceRefs,
    resolverVersion: row['resolver_version'] as string,
    createdAt: row['created_at'] as string,
    ...(row['superseded_by'] != null ? { supersededBy: row['superseded_by'] as string } : {}),
  };
}

function validateContactMetadata(obj: unknown): Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
  const entries = Object.entries(obj as Record<string, unknown>);
  if (
    entries.length > 32 ||
    entries.some(
      ([k, v]) => k.length === 0 || k.length > 128 || typeof v !== 'string' || v.length > 2048,
    )
  )
    throw new Error();
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseContactMetadata(value: unknown): Record<string, string> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'invalid contact metadata');
  try {
    const parsed: unknown = JSON.parse(value);
    return validateContactMetadata(parsed);
  } catch {
    throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'invalid contact metadata');
  }
}

function rowToPosting(row: Record<string, unknown>, db: JobsDatabase): Any {
  const pid = row['posting_id'] as string;
  const contactMetadata = parseContactMetadata(row['contact_metadata']);
  // posting_role_families has no evidence column (frozen DDL v1): the writer
  // cannot persist per-family evidenceRefs, so hydration honestly returns [].
  // Joining claim_candidate_evidence here would misattribute every posting
  // candidate to every family, which fabricates provenance. Schema change
  // would require a new migration version; out of scope for this checkpoint.
  const roleFamilies = (
    db
      .prepare('SELECT family, confidence FROM posting_role_families WHERE posting_id = ?')
      .all(pid) as Record<string, Any>[]
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
    ...(r['min'] != null ? { min: r['min'] as number } : {}),
    ...(r['max'] != null ? { max: r['max'] as number } : {}),
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
    ...(r['level'] != null ? { level: r['level'] as string } : {}),
  }));
  return {
    postingId: pid,
    schemaVersion: row['schema_version'] as string,
    canonicalRevision: row['canonical_revision'] as number,
    title: row['title'] as string,
    normalizedTitle: row['normalized_title'] as string,
    organisation: row['organisation'] as string,
    ...(row['organisation_unit'] != null
      ? { organisationUnit: row['organisation_unit'] as string }
      : {}),
    ...(row['sector'] != null ? { sector: row['sector'] as string } : {}),
    ...(row['industry'] != null ? { industry: row['industry'] as string } : {}),
    roleFamilies,
    locations: (
      db
        .prepare('SELECT * FROM locations WHERE posting_id = ? ORDER BY ordinal')
        .all(pid) as Record<string, Any>[]
    ).map((r) => ({
      ...(r['country'] != null ? { country: r['country'] as string } : {}),
      ...(r['region'] != null ? { region: r['region'] as string } : {}),
      ...(r['city'] != null ? { city: r['city'] as string } : {}),
      ...(r['postcode'] != null ? { postcode: r['postcode'] as string } : {}),
      ...(r['latitude'] != null ? { latitude: r['latitude'] as number } : {}),
      ...(r['longitude'] != null ? { longitude: r['longitude'] as number } : {}),
      ...(r['remote_eligible'] === 1
        ? { remoteEligible: true }
        : r['remote_eligible'] === 0
          ? { remoteEligible: false }
          : {}),
    })),
    workMode: row['work_mode'] as Any,
    employmentType: row['employment_type'] as Any,
    hoursFte: (row['hours_fte'] as number) ?? undefined,
    salaries,
    classifications,
    ...(row['seniority'] != null ? { seniority: row['seniority'] as Any } : {}),
    ...(row['posted_at'] != null ? { postedAt: row['posted_at'] as string } : {}),
    ...(row['closing_at'] != null ? { closingAt: row['closing_at'] as string } : {}),
    ...(row['start_at'] != null ? { startAt: row['start_at'] as string } : {}),
    ...(row['apply_url'] != null ? { applyUrl: row['apply_url'] as string } : {}),
    listingUrls,
    description: row['description'] as string,
    responsibilities,
    requirements: (() => {
      const reqRows = db
        .prepare('SELECT * FROM requirements WHERE posting_id = ? ORDER BY ordinal')
        .all(pid) as Record<string, Any>[];
      const reqEvidenceRows = db
        .prepare('SELECT ordinal, evidence_id FROM requirement_evidence WHERE posting_id = ?')
        .all(pid) as { ordinal: number; evidence_id: string }[];
      const evidenceByOrdinal = new Map<number, string[]>();
      for (const r of reqEvidenceRows) {
        const list = evidenceByOrdinal.get(r.ordinal) ?? [];
        list.push(r.evidence_id);
        evidenceByOrdinal.set(r.ordinal, list);
      }
      return reqRows.map((r) => {
        const ordinal = r['ordinal'] as number;
        return {
          rawText: r['raw_text'] as string,
          category: r['category'] as Any,
          force: r['force'] as Any,
          ...(r['semantic_capability'] != null
            ? { semanticCapability: r['semantic_capability'] as string }
            : {}),
          ...(r['years_min'] != null || r['years_max'] != null || r['years_unit'] != null
            ? {
                years: {
                  ...(r['years_min'] != null ? { min: r['years_min'] as number } : {}),
                  ...(r['years_max'] != null ? { max: r['years_max'] as number } : {}),
                  unit: (r['years_unit'] as 'month' | 'year' | undefined) ?? 'year',
                },
              }
            : {}),
          ...(r['qualification'] != null ? { qualification: r['qualification'] as string } : {}),
          ...(r['licence'] != null ? { licence: r['licence'] as string } : {}),
          ...(r['clearance'] != null ? { clearance: r['clearance'] as string } : {}),
          ...(r['registration'] != null ? { registration: r['registration'] as string } : {}),
          evidenceRefs: evidenceByOrdinal.get(ordinal) ?? [],
          confidence: r['confidence'] as number,
          interpretationProvenance: r['interpretation_provenance'] as string,
        };
      });
    })(),
    desirableCriteria,
    applicationRequirements,
    selectionQuestions,
    vacancyCount: (row['vacancy_count'] as number) ?? undefined,
    ...(row['security_clearance'] != null
      ? { securityClearance: row['security_clearance'] as string }
      : {}),
    licencesChecksRegistration,
    ...(row['work_rights'] != null ? { workRights: row['work_rights'] as string } : {}),
    targetedPosition:
      row['targeted_position'] === 1 ? true : row['targeted_position'] === 0 ? false : undefined,
    ...(contactMetadata !== undefined ? { contactMetadata } : {}),
    verificationState: row['verification_state'] as Any,
    ...(row['lifecycle_state'] != null ? { lifecycleState: row['lifecycle_state'] as Any } : {}),
    flags,
    confidence: row['confidence'] as number,
    caveats,
    // posting_field_evidence aggregates every field's evidenceRefs; unioning
    // preserves provenance instead of returning [] that erases it on read.
    evidenceRefs: [...new Set(fieldEvidenceLinks.flatMap((l) => l.evidenceRefs))],
    fieldEvidenceLinks,
    // claims hydrate via claim_* tables only when written through
    // putClaimCandidates/putClaimResolution; absent claims stay undefined
    // (optional on JobPosting) rather than fabricated empties.
    claimCandidates: readClaimCandidates(db, pid),
    claimResolutions: readClaimResolutions(db, pid),
    // memberships hold posting↔listing links written by setMemberships.
    sourceListingIds: (
      db.prepare('SELECT source_listing_id FROM memberships WHERE posting_id = ?').all(pid) as {
        source_listing_id: string;
      }[]
    ).map((r) => r.source_listing_id),
    // observation links resolve through membership listings; distinct keeps
    // reposted listings from duplicating the same observation id.
    observationIds: (
      db
        .prepare(
          `SELECT DISTINCT o.observation_id AS observation_id
         FROM observations o
         JOIN memberships m ON m.source_listing_id = o.source_listing_id
         WHERE m.posting_id = ? ORDER BY o.observation_id`,
        )
        .all(pid) as { observation_id: string }[]
    ).map((r) => r.observation_id),
    identityDecisionRevision: row['identity_decision_revision'] as string,
  };
}

// Claim rows carry value_json + provenance columns; hydrate to the domain
// ClaimCandidate shape (value parsed, evidenceRefs from the link table).
interface HydratedClaimCandidate {
  candidateId: string;
  value: unknown;
  evidenceRefs: string[];
  confidence: number;
  origin: string;
  method: string;
  provenance: {
    component: string;
    version: string;
    model?: string;
    promptVersion?: string;
    producedAt: string;
  };
}
function readClaimCandidates(
  db: JobsDatabase,
  postingId: string,
): HydratedClaimCandidate[] | undefined {
  const rows = db
    .prepare('SELECT * FROM claim_candidates WHERE posting_id = ? ORDER BY candidate_id')
    .all(postingId) as Record<string, string | number>[];
  if (rows.length === 0) return undefined;
  const evByCandidate = db
    .prepare(
      'SELECT candidate_id, evidence_id FROM claim_candidate_evidence WHERE candidate_id IN (SELECT candidate_id FROM claim_candidates WHERE posting_id = ?)',
    )
    .all(postingId) as { candidate_id: string; evidence_id: string }[];
  const refsByCandidate = new Map<string, string[]>();
  for (const row of evByCandidate) {
    const list = refsByCandidate.get(row.candidate_id) ?? [];
    list.push(row.evidence_id);
    refsByCandidate.set(row.candidate_id, list);
  }
  return rows.map((r) => ({
    candidateId: r['candidate_id'] as string,
    value: JSON.parse(r['value_json'] as string) as unknown,
    evidenceRefs: refsByCandidate.get(r['candidate_id'] as string) ?? [],
    confidence: r['confidence'] as number,
    origin: r['origin'] as Any,
    method: r['method'] as string,
    provenance: {
      component: r['provenance_component'] as string,
      version: r['provenance_version'] as string,
      ...(r['provenance_model'] != null ? { model: r['provenance_model'] as string } : {}),
      ...(r['provenance_prompt_version'] != null
        ? { promptVersion: r['provenance_prompt_version'] as string }
        : {}),
      producedAt: r['produced_at'] as string,
    },
  }));
}

function readClaimResolutions(
  db: JobsDatabase,
  postingId: string,
): Record<string, Record<string, unknown>> | undefined {
  const rows = db
    .prepare('SELECT * FROM claim_resolutions WHERE posting_id = ?')
    .all(postingId) as Record<string, string>[];
  if (rows.length === 0) return undefined;
  const candidates = readClaimCandidates(db, postingId) ?? [];
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const altRows = db
    .prepare(
      'SELECT field_path, candidate_id FROM claim_resolution_alternatives WHERE posting_id = ? ORDER BY field_path, candidate_id',
    )
    .all(postingId) as { field_path: string; candidate_id: string }[];
  const altsByField = new Map<string, Any[]>();
  for (const row of altRows) {
    const cand = byId.get(row.candidate_id);
    if (!cand) continue;
    const list = altsByField.get(row.field_path) ?? [];
    list.push(cand);
    altsByField.set(row.field_path, list);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const fieldPath = (row['field_path'] ?? '') as string;
    if (fieldPath.length === 0) continue;
    if (row['state'] === 'unresolved') {
      out.set(fieldPath, { state: 'unresolved', alternatives: altsByField.get(fieldPath) ?? [] });
    } else {
      const selectedId = (row['selected_candidate_id'] ?? '') as string;
      const selected = byId.get(selectedId);
      const alternatives = altsByField.get(fieldPath) ?? [];
      const pool = selected ? [selected, ...alternatives] : alternatives;
      if (pool.length === 0) {
        throw new JobsStoreError(
          JobsStoreErrorCode.SCHEMA_INCOMPATIBLE,
          'missing selected claim candidate',
        );
      }
      // Recompute representative at read boundary: persisted alternatives are
      // untrusted input and model-derived claims cannot outrank observations.
      const resolved = resolveClaim(pool);
      if (resolved.state === 'unresolved') {
        out.set(fieldPath, { state: 'unresolved', alternatives });
      } else {
        out.set(fieldPath, {
          state: (row['state'] ?? '') as string,
          selected: resolved.selected,
          alternatives,
        });
      }
    }
  }
  return Object.fromEntries(out);
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

export type { LifecycleEvent, LifecycleState, IdentityDecisionStatements };
export {
  rowToListing,
  rowToObservation,
  rowToIdentityDecision,
  prepareIdentityDecisionStatements,
  validateContactMetadata,
  rowToPosting,
  deletePostingChildren,
};
