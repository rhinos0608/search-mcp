/* eslint-disable @typescript-eslint/dot-notation */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { LifecycleEventSchema } from '../domain/lifecycle.js';
import type { JobPosting } from '../domain/posting.js';
import type { SourceListing, SourceObservation } from '../domain/source.js';
import type { JobsDatabase, JobsStore } from './contracts.js';
import { JobsStoreError, JobsStoreErrorCode } from './contracts.js';
import { applyJobsMigrations } from './migrations.js';
import {
  deletePostingChildren,
  rowToIdentityDecision,
  rowToListing,
  rowToObservation,
  rowToPosting,
} from './store-mappers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function createJobsStore(db: JobsDatabase): JobsStore {
  const migrationResult = applyJobsMigrations(db);
  const schemaVersion = migrationResult.version;

  return {
    db,
    schemaVersion,

    upsertListing(listing) {
      const existing = db
        .prepare('SELECT source_listing_id FROM listings WHERE source_listing_id = ?')
        .get(listing.sourceListingId);
      if (existing) {
        db.prepare(
          'UPDATE listings SET last_seen_at = ?, current_observation_id = ? WHERE source_listing_id = ?',
        ).run(listing.lastSeenAt, listing.currentObservationId, listing.sourceListingId);
      } else {
        db.prepare(
          'INSERT INTO listings (source_listing_id, adapter_id, external_id, canonical_url, first_seen_at, last_seen_at, current_observation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          listing.sourceListingId,
          listing.adapterId,
          listing.externalId ?? null,
          listing.canonicalUrl ?? null,
          listing.firstSeenAt,
          listing.lastSeenAt,
          listing.currentObservationId,
        );
      }
    },

    insertObservation(observation) {
      const existing = db
        .prepare('SELECT observation_id FROM observations WHERE observation_id = ?')
        .get(observation.observationId);
      if (existing)
        throw new JobsStoreError(
          JobsStoreErrorCode.OBSERVATION_IMMUTABLE,
          'observation already exists',
        );
      db.prepare(
        'INSERT INTO observations (observation_id, source_listing_id, fetched_at, content_hash, payload_ref, extraction_version, adapter_version, fetch_outcome, source_confidence_json, immutable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        observation.observationId,
        observation.sourceListingId,
        observation.fetchedAt,
        observation.contentHash,
        observation.payloadRef ?? null,
        observation.extractionVersion,
        observation.adapterVersion,
        observation.fetchOutcome,
        JSON.stringify(observation.sourceConfidence),
        1,
      );
      const insRef = db.prepare(
        'INSERT INTO observation_evidence_refs (observation_id, evidence_id, ordinal) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < observation.evidenceRefs.length; i++)
        insRef.run(observation.observationId, observation.evidenceRefs[i], i);
    },

    getListing(id) {
      const row = db.prepare('SELECT * FROM listings WHERE source_listing_id = ?').get(id);
      return row ? (rowToListing(row) as SourceListing) : undefined;
    },

    getObservation(id) {
      const row = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(id);
      return row ? (rowToObservation(row, db) as SourceObservation) : undefined;
    },

    listObservations(listingId) {
      return db
        .prepare('SELECT * FROM observations WHERE source_listing_id = ? ORDER BY fetched_at ASC')
        .all(listingId)
        .map((r) => rowToObservation(r, db) as SourceObservation);
    },

    putPostingProjection(posting) {
      const p = posting as JobPosting;
      deletePostingChildren(db, p.postingId);
      db.prepare(
        `INSERT INTO postings (posting_id, schema_version, canonical_revision, title, normalized_title, organisation, organisation_unit, sector, industry, work_mode, employment_type, hours_fte, seniority, posted_at, closing_at, start_at, apply_url, description, vacancy_count, security_clearance, work_rights, targeted_position, verification_state, lifecycle_state, confidence, identity_decision_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(posting_id) DO UPDATE SET schema_version=excluded.schema_version, canonical_revision=excluded.canonical_revision, title=excluded.title, normalized_title=excluded.normalized_title, organisation=excluded.organisation, organisation_unit=excluded.organisation_unit, sector=excluded.sector, industry=excluded.industry, work_mode=excluded.work_mode, employment_type=excluded.employment_type, hours_fte=excluded.hours_fte, seniority=excluded.seniority, posted_at=excluded.posted_at, closing_at=excluded.closing_at, start_at=excluded.start_at, apply_url=excluded.apply_url, description=excluded.description, vacancy_count=excluded.vacancy_count, security_clearance=excluded.security_clearance, work_rights=excluded.work_rights, targeted_position=excluded.targeted_position, verification_state=excluded.verification_state, lifecycle_state=excluded.lifecycle_state, confidence=excluded.confidence, identity_decision_revision=excluded.identity_decision_revision`,
      ).run(
        p.postingId,
        p.schemaVersion,
        p.canonicalRevision,
        p.title,
        p.normalizedTitle,
        p.organisation,
        p.organisationUnit ?? null,
        p.sector ?? null,
        p.industry ?? null,
        p.workMode,
        p.employmentType,
        p.hoursFte ?? null,
        p.seniority ?? null,
        p.postedAt ?? null,
        p.closingAt ?? null,
        p.startAt ?? null,
        p.applyUrl ?? null,
        p.description,
        p.vacancyCount ?? null,
        p.securityClearance ?? null,
        p.workRights ?? null,
        p.targetedPosition === true ? 1 : p.targetedPosition === false ? 0 : null,
        p.verificationState,
        p.lifecycleState,
        p.confidence,
        p.identityDecisionRevision,
      );
      const insF = db.prepare(
        'INSERT INTO posting_role_families (posting_id, family, confidence) VALUES (?, ?, ?)',
      );
      for (const f of p.roleFamilies) insF.run(p.postingId, f.family, f.confidence);
      const insU = db.prepare('INSERT INTO posting_listing_urls (posting_id, url) VALUES (?, ?)');
      for (const url of p.listingUrls) insU.run(p.postingId, url);
      const insR = db.prepare(
        'INSERT INTO posting_responsibilities (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.responsibilities.length; i++)
        insR.run(p.postingId, i, p.responsibilities[i]);
      const insD = db.prepare(
        'INSERT INTO posting_desirable (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.desirableCriteria.length; i++)
        insD.run(p.postingId, i, p.desirableCriteria[i]);
      const insA = db.prepare(
        'INSERT INTO posting_application_requirements (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.applicationRequirements.length; i++)
        insA.run(p.postingId, i, p.applicationRequirements[i]);
      const insS = db.prepare(
        'INSERT INTO posting_selection_questions (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.selectionQuestions.length; i++)
        insS.run(p.postingId, i, p.selectionQuestions[i]);
      const insL = db.prepare(
        'INSERT INTO posting_licences (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.licencesChecksRegistration.length; i++)
        insL.run(p.postingId, i, p.licencesChecksRegistration[i]);
      const insFl = db.prepare('INSERT INTO posting_flags (posting_id, flag) VALUES (?, ?)');
      for (const flag of p.flags) insFl.run(p.postingId, flag);
      const insC = db.prepare(
        'INSERT INTO posting_caveats (posting_id, ordinal, text) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < p.caveats.length; i++) insC.run(p.postingId, i, p.caveats[i]);
      if (p.fieldEvidenceLinks) {
        const insFE = db.prepare(
          'INSERT INTO posting_field_evidence (posting_id, field_path, evidence_id) VALUES (?, ?, ?)',
        );
        for (const link of p.fieldEvidenceLinks)
          for (const evId of link.evidenceRefs) insFE.run(p.postingId, link.fieldPath, evId);
      }
      const insSal = db.prepare(
        'INSERT INTO posting_salaries (posting_id, ordinal, min, max, currency, unit, period, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < p.salaries.length; i++) {
        const s = p.salaries[i]!;
        insSal.run(
          p.postingId,
          i,
          s.min ?? null,
          s.max ?? null,
          s.currency,
          s.unit,
          s.period,
          s.raw,
        );
      }
      const insCl = db.prepare(
        'INSERT INTO posting_classifications (posting_id, ordinal, scheme, value, level) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < p.classifications.length; i++) {
        const c = p.classifications[i]!;
        insCl.run(p.postingId, i, c.scheme, c.value, c.level ?? null);
      }
    },

    getPosting(id) {
      const row = db.prepare('SELECT * FROM postings WHERE posting_id = ?').get(id);
      return row ? (rowToPosting(row, db) as Any) : undefined;
    },

    listPostingsByLifecycle(state) {
      return db
        .prepare('SELECT posting_id FROM postings WHERE lifecycle_state = ?')
        .all(state)
        .map((r) => (r as Record<string, unknown>)['posting_id'] as string);
    },

    setMemberships(postingId, listingIds, decisionId) {
      db.prepare('DELETE FROM memberships WHERE posting_id = ?').run(postingId);
      const ins = db.prepare(
        'INSERT INTO memberships (posting_id, source_listing_id, identity_decision_id) VALUES (?, ?, ?)',
      );
      for (const lid of listingIds) ins.run(postingId, lid, decisionId);
    },

    putEvidence(rows) {
      const ins = db.prepare(
        'INSERT INTO evidence (evidence_id, subject_type, subject_id, field_path, kind, observation_id, document_fingerprint, json_pointer, bounded_excerpt, source_url, captured_at, effective_at, extractor_version, confidence, retention_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        if (row.subjectType === 'profile')
          throw new JobsStoreError(
            JobsStoreErrorCode.PROFILE_EVIDENCE_FORBIDDEN,
            'profile evidence belongs in profiles.sqlite',
          );
        ins.run(
          row.evidenceId,
          row.subjectType,
          row.subjectId,
          row.fieldPath ?? null,
          row.kind,
          row.observationId ?? null,
          row.documentFingerprint ?? null,
          row.jsonPointer ?? null,
          row.boundedExcerpt ?? null,
          row.sourceUrl ?? null,
          row.capturedAt,
          row.effectiveAt ?? null,
          row.extractorVersion ?? null,
          row.confidence,
          row.retentionClass,
        );
      }
    },

    putClaimCandidates(postingId, fieldPath, candidates) {
      const insC = db.prepare(
        'INSERT INTO claim_candidates (candidate_id, posting_id, field_path, value_json, confidence, origin, method, provenance_component, provenance_version, provenance_model, provenance_prompt_version, produced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insE = db.prepare(
        'INSERT INTO claim_candidate_evidence (candidate_id, evidence_id) VALUES (?, ?)',
      );
      for (const c of candidates) {
        insC.run(
          c.candidateId,
          postingId,
          fieldPath,
          JSON.stringify(c.value),
          c.confidence,
          c.origin,
          c.method,
          c.provenance.component,
          c.provenance.version,
          c.provenance.model ?? null,
          c.provenance.promptVersion ?? null,
          c.provenance.producedAt,
        );
        for (const evId of c.evidenceRefs) insE.run(c.candidateId, evId);
      }
    },

    putClaimResolution(postingId, fieldPath, resolved) {
      if (resolved.state !== 'unresolved' && resolved.selected.origin === 'model_derived') {
        const observed = db
          .prepare(
            "SELECT value_json FROM claim_candidates WHERE posting_id = ? AND field_path = ? AND origin = 'observed'",
          )
          .all(postingId, fieldPath) as { value_json: string }[];
        if (observed.length > 0) {
          const sv = JSON.stringify(resolved.selected.value);
          if (observed.some((o) => o.value_json !== sv) && resolved.state !== 'conflicting')
            throw new JobsStoreError(
              JobsStoreErrorCode.OBSERVATION_IMMUTABLE,
              'model_derived cannot overwrite observed claim',
            );
        }
      }
      if (resolved.state !== 'unresolved') {
        this.putClaimCandidates(postingId, fieldPath, [resolved.selected]);
      }
      for (const alt of resolved.alternatives) this.putClaimCandidates(postingId, fieldPath, [alt]);
      db.prepare(
        'INSERT INTO claim_resolutions (posting_id, field_path, state, selected_candidate_id) VALUES (?, ?, ?, ?)',
      ).run(
        postingId,
        fieldPath,
        resolved.state,
        resolved.state === 'unresolved' ? null : resolved.selected.candidateId,
      );
      const insA = db.prepare(
        'INSERT INTO claim_resolution_alternatives (posting_id, field_path, candidate_id) VALUES (?, ?, ?)',
      );
      for (const alt of resolved.alternatives) insA.run(postingId, fieldPath, alt.candidateId);
    },

    putRequirements(postingId, requirements) {
      db.prepare('DELETE FROM requirement_evidence WHERE posting_id = ?').run(postingId);
      db.prepare('DELETE FROM requirements WHERE posting_id = ?').run(postingId);
      const ins = db.prepare(
        'INSERT INTO requirements (posting_id, ordinal, raw_text, category, force, semantic_capability, years_min, years_max, years_unit, qualification, licence, clearance, registration, confidence, interpretation_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insE = db.prepare(
        'INSERT INTO requirement_evidence (posting_id, ordinal, evidence_id) VALUES (?, ?, ?)',
      );
      for (let i = 0; i < requirements.length; i++) {
        const r = requirements[i]!;
        ins.run(
          postingId,
          i,
          r.rawText,
          r.category,
          r.force,
          r.semanticCapability ?? null,
          r.years?.min ?? null,
          r.years?.max ?? null,
          r.years?.unit ?? null,
          r.qualification ?? null,
          r.licence ?? null,
          r.clearance ?? null,
          r.registration ?? null,
          r.confidence,
          r.interpretationProvenance,
        );
        for (const evId of r.evidenceRefs) insE.run(postingId, i, evId);
      }
    },

    putLocations(postingId, locations) {
      db.prepare('DELETE FROM locations WHERE posting_id = ?').run(postingId);
      const ins = db.prepare(
        'INSERT INTO locations (posting_id, ordinal, country, region, city, postcode, latitude, longitude, remote_eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i]!;
        ins.run(
          postingId,
          i,
          loc.country ?? null,
          loc.region ?? null,
          loc.city ?? null,
          loc.postcode ?? null,
          loc.latitude ?? null,
          loc.longitude ?? null,
          loc.remoteEligible === true ? 1 : loc.remoteEligible === false ? 0 : null,
        );
      }
    },

    appendIdentityDecision(decision) {
      if (decision.outcome === 'same_posting' || decision.outcome === 'probable_cluster') {
        const names = decision.featureContributions.map((f) => f.feature);
        if (
          names.length > 0 &&
          names.every((n) => n === 'organisation_normalized' || n === 'title_normalized')
        )
          throw new JobsStoreError(
            JobsStoreErrorCode.IDENTITY_MERGE_FORBIDDEN,
            'same_posting/probable_cluster requires strong or corroborating features beyond org+title',
          );
      }
      db.prepare(
        'INSERT INTO identity_decisions (decision_id, outcome, confidence, resolver_version, created_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        decision.decisionId,
        decision.outcome,
        decision.confidence,
        decision.resolverVersion,
        decision.createdAt,
        decision.supersededBy ?? null,
      );
      const insO = db.prepare(
        'INSERT INTO identity_decision_observations (decision_id, observation_id) VALUES (?, ?)',
      );
      for (const obsId of decision.subjectObservationIds) insO.run(decision.decisionId, obsId);
      const insL = db.prepare(
        'INSERT INTO identity_decision_listings (decision_id, source_listing_id) VALUES (?, ?)',
      );
      for (const lid of decision.subjectListingIds) insL.run(decision.decisionId, lid);
      const insF = db.prepare(
        'INSERT INTO identity_decision_features (decision_id, feature, contribution) VALUES (?, ?, ?)',
      );
      const insFE = db.prepare(
        'INSERT INTO identity_decision_feature_evidence (decision_id, feature, evidence_id) VALUES (?, ?, ?)',
      );
      for (const fc of decision.featureContributions) {
        insF.run(decision.decisionId, fc.feature, fc.contribution);
        for (const evId of fc.evidenceRefs) insFE.run(decision.decisionId, fc.feature, evId);
      }
      const insC = db.prepare(
        'INSERT INTO identity_decision_contradictions (decision_id, evidence_id) VALUES (?, ?)',
      );
      for (const evId of decision.contradictoryEvidenceRefs) insC.run(decision.decisionId, evId);
    },

    supersedeIdentityDecision(priorId, next) {
      this.appendIdentityDecision(next);
      db.prepare('UPDATE identity_decisions SET superseded_by = ? WHERE decision_id = ?').run(
        next.decisionId,
        priorId,
      );
    },

    listIdentityHistory(opts) {
      if (opts.postingId)
        return db
          .prepare(
            'SELECT d.* FROM identity_decisions d JOIN identity_decision_listings dl ON dl.decision_id = d.decision_id JOIN memberships m ON m.source_listing_id = dl.source_listing_id AND m.posting_id = ? ORDER BY d.created_at ASC',
          )
          .all(opts.postingId)
          .map(rowToIdentityDecision) as Any;
      if (opts.observationId)
        return db
          .prepare(
            'SELECT d.* FROM identity_decisions d JOIN identity_decision_observations dio ON dio.decision_id = d.decision_id WHERE dio.observation_id = ? ORDER BY d.created_at ASC',
          )
          .all(opts.observationId)
          .map(rowToIdentityDecision) as Any;
      if (opts.listingId)
        return db
          .prepare(
            'SELECT d.* FROM identity_decisions d JOIN identity_decision_listings dl ON dl.decision_id = d.decision_id WHERE dl.source_listing_id = ? ORDER BY d.created_at ASC',
          )
          .all(opts.listingId)
          .map(rowToIdentityDecision) as Any;
      return [];
    },

    listActiveIdentityDecisions() {
      return db
        .prepare(
          'SELECT * FROM identity_decisions WHERE superseded_by IS NULL ORDER BY created_at ASC',
        )
        .all()
        .map(rowToIdentityDecision) as Any;
    },

    putIdentityClusterProjection(clusters) {
      db.exec('DELETE FROM identity_cluster_decisions');
      db.exec('DELETE FROM identity_cluster_members');
      db.exec('DELETE FROM identity_clusters');
      const insC = db.prepare(
        'INSERT INTO identity_clusters (cluster_id, kind, revision, posting_id) VALUES (?, ?, ?, ?)',
      );
      const insM = db.prepare(
        'INSERT INTO identity_cluster_members (cluster_id, observation_id, source_listing_id) VALUES (?, ?, ?)',
      );
      const insD = db.prepare(
        'INSERT INTO identity_cluster_decisions (cluster_id, decision_id) VALUES (?, ?)',
      );
      for (const cl of clusters) {
        insC.run(cl.clusterId, cl.kind, cl.revision, (cl as Any).postingId ?? null);
        for (const m of (cl as Any).members ?? [])
          insM.run(cl.clusterId, m.observationId, m.sourceListingId);
        for (const d of (cl as Any).decisionIds ?? []) insD.run(cl.clusterId, d);
      }
    },

    insertSnapshot(s) {
      db.prepare(
        'INSERT INTO snapshots (snapshot_id, posting_id, canonical_revision, identity_decision_revision, captured_at, projection_hash) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        s.snapshotId,
        s.postingId,
        s.canonicalRevision,
        s.identityDecisionRevision,
        s.capturedAt,
        s.projectionHash,
      );
    },
    insertDiff(d) {
      db.prepare(
        'INSERT INTO snapshot_diffs (diff_id, posting_id, from_snapshot_id, to_snapshot_id, field_path, change_kind, from_hash, to_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        d.diffId,
        d.postingId,
        d.fromSnapshotId,
        d.toSnapshotId,
        d.fieldPath,
        d.changeKind,
        d.fromHash ?? null,
        d.toHash ?? null,
      );
    },

    appendLifecycleEvent(event) {
      const parsed = LifecycleEventSchema.parse(event);
      db.prepare(
        'INSERT INTO lifecycle_events (event_id, posting_id, type, occurred_at, from_state, to_state, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        parsed.eventId,
        parsed.postingId,
        parsed.type,
        parsed.occurredAt,
        parsed.fromState ?? null,
        parsed.toState ?? null,
        parsed.source,
      );
      const insE = db.prepare(
        'INSERT INTO lifecycle_event_evidence (event_id, evidence_id) VALUES (?, ?)',
      );
      for (const evId of parsed.evidenceRefs) insE.run(parsed.eventId, evId);
      if (parsed.toState)
        db.prepare('UPDATE postings SET lifecycle_state = ? WHERE posting_id = ?').run(
          parsed.toState,
          parsed.postingId,
        );
    },

    getLifecycleHistory(postingId) {
      return db
        .prepare('SELECT * FROM lifecycle_events WHERE posting_id = ? ORDER BY occurred_at ASC')
        .all(postingId)
        .map((r) => {
          const row = r as Record<string, unknown>;
          return {
            eventId: row['event_id'] as string,
            postingId: row['posting_id'] as string,
            type: row['type'] as Any,
            occurredAt: row['occurred_at'] as string,
            fromState: row['from_state'] as Any,
            toState: row['to_state'] as Any,
            evidenceRefs: [] as string[],
            source: row['source'] as string,
          } as Any;
        });
    },

    insertRun(run) {
      db.prepare(
        'INSERT INTO runs (run_id, created_at, intent_hash, plan_id, plan_version, coverage_json, budget_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        run.runId,
        run.createdAt,
        run.intentHash,
        run.planId ?? null,
        run.planVersion ?? null,
        run.coverageJson,
        run.budgetJson,
        run.status,
      );
    },
    insertSlice(s) {
      db.prepare(
        'INSERT INTO slices (slice_id, run_id, adapter_id, acquisition_run_id, acquisition_slice_id, query_variant_hash, reason_code, coverage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        s.sliceId,
        s.runId,
        s.adapterId,
        s.acquisitionRunId ?? null,
        s.acquisitionSliceId ?? null,
        s.queryVariantHash,
        s.reasonCode,
        s.coverage,
      );
    },
    insertRunCandidate(r) {
      db.prepare(
        'INSERT INTO run_candidates (run_id, candidate_id, posting_id, slice_id, stage) VALUES (?, ?, ?, ?, ?)',
      ).run(r.runId, r.candidateId, r.postingId ?? null, r.sliceId ?? null, r.stage);
    },
    insertRunResult(r) {
      db.prepare(
        'INSERT INTO run_results (run_id, posting_id, rank, utility, coverage, confidence) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        r.runId,
        r.postingId,
        r.rank,
        r.utility ?? null,
        r.coverage ?? null,
        r.confidence ?? null,
      );
    },
    getRun(runId) {
      const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
      return row
        ? ({
            runId: row['run_id'] as string,
            createdAt: row['created_at'] as string,
            intentHash: row['intent_hash'] as string,
            planId: (row['plan_id'] as string) ?? undefined,
            planVersion: (row['plan_version'] as string) ?? undefined,
            coverageJson: row['coverage_json'] as string,
            budgetJson: row['budget_json'] as string,
            status: row['status'] as Any,
          } as Any)
        : undefined;
    },

    putEnrichmentCache(row) {
      db.prepare(
        'INSERT OR REPLACE INTO enrichment_cache (cache_key, kind, content_hash, enrichment_version, bounded_metadata_json, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        row.cacheKey,
        row.kind,
        row.contentHash,
        row.enrichmentVersion,
        row.boundedMetadataJson,
        row.createdAt,
        row.lastAccessedAt,
      );
    },
    getEnrichmentCache(key) {
      const row = db.prepare('SELECT * FROM enrichment_cache WHERE cache_key = ?').get(key);
      return row
        ? {
            cacheKey: row['cache_key'] as string,
            kind: row['kind'] as 'listing' | 'attachment' | 'framework' | 'employer',
            contentHash: row['content_hash'] as string,
            enrichmentVersion: row['enrichment_version'] as string,
            boundedMetadataJson: row['bounded_metadata_json'] as string,
            createdAt: row['created_at'] as string,
            lastAccessedAt: row['last_accessed_at'] as string,
          }
        : undefined;
    },

    recordSourceHealth(row) {
      db.prepare(
        'INSERT INTO source_health (sample_id, source_id, adapter_id, sampled_at, outcome, http_status, latency_ms, result_count, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        row.sampleId,
        row.sourceId,
        row.adapterId,
        row.sampledAt,
        row.outcome,
        row.httpStatus ?? null,
        row.latencyMs ?? null,
        row.resultCount ?? null,
        row.errorCode ?? null,
      );
    },
    insertPolicyRevision(row) {
      db.prepare(
        'INSERT INTO policy_revisions (source_id, revision, modes_json, reviewed_at, notes) VALUES (?, ?, ?, ?, ?)',
      ).run(row.sourceId, row.revision, row.modesJson, row.reviewedAt, row.notes ?? null);
    },
    getPolicyRevision(sourceId, revision) {
      const row = db
        .prepare('SELECT * FROM policy_revisions WHERE source_id = ? AND revision = ?')
        .get(sourceId, revision);
      return row
        ? ({
            sourceId: row['source_id'] as string,
            revision: row['revision'] as string,
            modesJson: row['modes_json'] as string,
            reviewedAt: row['reviewed_at'] as string,
            notes: (row['notes'] as string) ?? undefined,
          } as Any)
        : undefined;
    },

    applyMigrations() {
      return applyJobsMigrations(db);
    },
    integrityCheck() {
      const result = db.pragma('integrity_check', { simple: true });
      return result === 'ok'
        ? { ok: true as const }
        : { ok: false as const, errors: [String(result)] };
    },
    checkpointWal() {
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    close() {
      db.close();
    },
  };
}
