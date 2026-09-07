/**
 * DDL string constant for jobs.sqlite schema v1.
 * Frozen by Oracle contract B.5. Checksummed in migrations.
 */
export const JOBS_V1_DDL = `
-- Meta
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backfill_checkpoint (
  job_name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  checksum TEXT,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed'))
);

-- Listings and observations
CREATE TABLE IF NOT EXISTS listings (
  source_listing_id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  external_id TEXT,
  canonical_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_observation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  source_listing_id TEXT NOT NULL REFERENCES listings(source_listing_id),
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_ref TEXT,
  extraction_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  fetch_outcome TEXT NOT NULL CHECK(fetch_outcome IN ('success','partial','failed','not_supported')),
  source_confidence_json TEXT NOT NULL,
  immutable INTEGER NOT NULL CHECK(immutable = 1)
);

CREATE TABLE IF NOT EXISTS observation_evidence_refs (
  observation_id TEXT NOT NULL REFERENCES observations(observation_id),
  evidence_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (observation_id, evidence_id)
);

-- Evidence (before postings/memberships/identity which reference it)
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('posting','requirement','profile','identity','policy')),
  subject_id TEXT NOT NULL,
  field_path TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'structured_field','text_span','attachment','framework',
    'user_statement','interaction','source_policy'
  )),
  observation_id TEXT REFERENCES observations(observation_id),
  document_fingerprint TEXT,
  json_pointer TEXT,
  bounded_excerpt TEXT,
  source_url TEXT,
  captured_at TEXT NOT NULL,
  effective_at TEXT,
  extractor_version TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  retention_class TEXT NOT NULL
);

-- Postings (hot projection)
CREATE TABLE IF NOT EXISTS postings (
  posting_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  organisation TEXT NOT NULL,
  organisation_unit TEXT,
  sector TEXT,
  industry TEXT,
  work_mode TEXT NOT NULL CHECK(work_mode IN ('onsite','hybrid','remote','unknown')),
  employment_type TEXT NOT NULL CHECK(employment_type IN (
    'full_time','part_time','casual','contract','temporary','internship','unknown'
  )),
  hours_fte REAL,
  seniority TEXT CHECK(seniority IN ('entry','mid','senior','lead','executive','unknown') OR seniority IS NULL),
  posted_at TEXT,
  closing_at TEXT,
  start_at TEXT,
  apply_url TEXT,
  description TEXT NOT NULL,
  vacancy_count INTEGER,
  security_clearance TEXT,
  work_rights TEXT,
  targeted_position INTEGER CHECK(targeted_position IN (0,1) OR targeted_position IS NULL),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('unverified','partially_verified','verified')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN (
    'discovered','active','probably_closed','confirmed_closed','expired','superseded'
  )),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  identity_decision_revision TEXT NOT NULL,
  CHECK(canonical_revision >= 0)
);

CREATE TABLE IF NOT EXISTS posting_role_families (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  family TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (posting_id, family)
);

CREATE TABLE IF NOT EXISTS posting_listing_urls (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  url TEXT NOT NULL,
  PRIMARY KEY (posting_id, url)
);

CREATE TABLE IF NOT EXISTS posting_responsibilities (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_desirable (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_application_requirements (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_selection_questions (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_licences (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_flags (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  flag TEXT NOT NULL CHECK(flag IN (
    'conflicting_source_evidence','stale_fallback','partial_source_coverage',
    'identified_position_requirement','model_assessment_unverified',
    'manual_import_unverified','eligibility_unknown','registration_not_evidenced'
  )),
  PRIMARY KEY (posting_id, flag)
);

CREATE TABLE IF NOT EXISTS posting_caveats (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS posting_field_evidence (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  field_path TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (posting_id, field_path, evidence_id)
);

CREATE TABLE IF NOT EXISTS posting_salaries (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  min REAL,
  max REAL,
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  unit TEXT NOT NULL CHECK(unit IN ('hour','day','week','month','year')),
  period TEXT NOT NULL DEFAULT 'stated' CHECK(period IN ('annualized','stated')),
  raw TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal),
  CHECK(min IS NULL OR max IS NULL OR min <= max)
);

CREATE TABLE IF NOT EXISTS posting_classifications (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  level TEXT,
  PRIMARY KEY (posting_id, ordinal)
);

-- Identity decisions (before memberships which reference them)
CREATE TABLE IF NOT EXISTS identity_decisions (
  decision_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'same_posting','probable_cluster','distinct','unresolved','split'
  )),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  resolver_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES identity_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS identity_decision_observations (
  decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  observation_id TEXT NOT NULL REFERENCES observations(observation_id),
  PRIMARY KEY (decision_id, observation_id)
);

CREATE TABLE IF NOT EXISTS identity_decision_listings (
  decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  source_listing_id TEXT NOT NULL REFERENCES listings(source_listing_id),
  PRIMARY KEY (decision_id, source_listing_id)
);

CREATE TABLE IF NOT EXISTS identity_decision_features (
  decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  feature TEXT NOT NULL,
  contribution REAL NOT NULL,
  PRIMARY KEY (decision_id, feature)
);

CREATE TABLE IF NOT EXISTS identity_decision_feature_evidence (
  decision_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (decision_id, feature, evidence_id),
  FOREIGN KEY (decision_id, feature) REFERENCES identity_decision_features(decision_id, feature)
);

CREATE TABLE IF NOT EXISTS identity_decision_contradictions (
  decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (decision_id, evidence_id)
);

-- Memberships (after identity_decisions and postings)
CREATE TABLE IF NOT EXISTS memberships (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  source_listing_id TEXT NOT NULL REFERENCES listings(source_listing_id),
  identity_decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  PRIMARY KEY (posting_id, source_listing_id)
);

-- Claims / resolutions (after evidence, postings)
CREATE TABLE IF NOT EXISTS claim_candidates (
  candidate_id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  field_path TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  origin TEXT NOT NULL CHECK(origin IN ('observed','user_supplied','deterministic_derived','model_derived')),
  method TEXT NOT NULL,
  provenance_component TEXT NOT NULL,
  provenance_version TEXT NOT NULL,
  provenance_model TEXT,
  provenance_prompt_version TEXT,
  produced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (candidate_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS claim_resolutions (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  field_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('resolved','conflicting','unresolved')),
  selected_candidate_id TEXT REFERENCES claim_candidates(candidate_id),
  PRIMARY KEY (posting_id, field_path),
  CHECK(
    (state = 'unresolved' AND selected_candidate_id IS NULL) OR
    (state IN ('resolved','conflicting') AND selected_candidate_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS claim_resolution_alternatives (
  posting_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  PRIMARY KEY (posting_id, field_path, candidate_id),
  FOREIGN KEY (posting_id, field_path) REFERENCES claim_resolutions(posting_id, field_path)
);

-- Requirements / locations
CREATE TABLE IF NOT EXISTS requirements (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'skill','experience','qualification','licence','clearance','registration',
    'work_rights','employment_check','availability','application_material','other'
  )),
  force TEXT NOT NULL CHECK(force IN ('mandatory','preferred','uncertain')),
  semantic_capability TEXT,
  years_min REAL,
  years_max REAL,
  years_unit TEXT CHECK(years_unit IN ('month','year') OR years_unit IS NULL),
  qualification TEXT,
  licence TEXT,
  clearance TEXT,
  registration TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  interpretation_provenance TEXT NOT NULL,
  PRIMARY KEY (posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS requirement_evidence (
  posting_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (posting_id, ordinal, evidence_id),
  FOREIGN KEY (posting_id, ordinal) REFERENCES requirements(posting_id, ordinal)
);

CREATE TABLE IF NOT EXISTS locations (
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  ordinal INTEGER NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  postcode TEXT,
  latitude REAL,
  longitude REAL,
  remote_eligible INTEGER CHECK(remote_eligible IN (0,1) OR remote_eligible IS NULL),
  PRIMARY KEY (posting_id, ordinal)
);

-- Identity clusters (rebuildable projection)
CREATE TABLE IF NOT EXISTS identity_clusters (
  cluster_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('same_posting','probable_cluster')),
  revision TEXT NOT NULL,
  posting_id TEXT REFERENCES postings(posting_id)
);

CREATE TABLE IF NOT EXISTS identity_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES identity_clusters(cluster_id),
  observation_id TEXT NOT NULL REFERENCES observations(observation_id),
  source_listing_id TEXT NOT NULL REFERENCES listings(source_listing_id),
  PRIMARY KEY (cluster_id, observation_id)
);

CREATE TABLE IF NOT EXISTS identity_cluster_decisions (
  cluster_id TEXT NOT NULL REFERENCES identity_clusters(cluster_id),
  decision_id TEXT NOT NULL REFERENCES identity_decisions(decision_id),
  PRIMARY KEY (cluster_id, decision_id)
);

-- Snapshots / diffs
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  canonical_revision INTEGER NOT NULL,
  identity_decision_revision TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  projection_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_diffs (
  diff_id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  from_snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),
  to_snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),
  field_path TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK(change_kind IN ('added','removed','replaced')),
  from_hash TEXT,
  to_hash TEXT
);

-- Lifecycle events
CREATE TABLE IF NOT EXISTS lifecycle_events (
  event_id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  type TEXT NOT NULL CHECK(type IN (
    'first_seen','observed','verified','changed','source_added','source_removed',
    'disappeared','reposted','superseded','identity_merged','identity_split'
  )),
  occurred_at TEXT NOT NULL,
  from_state TEXT CHECK(from_state IN (
    'discovered','active','probably_closed','confirmed_closed','expired','superseded'
  ) OR from_state IS NULL),
  to_state TEXT CHECK(to_state IN (
    'discovered','active','probably_closed','confirmed_closed','expired','superseded'
  ) OR to_state IS NULL),
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_event_evidence (
  event_id TEXT NOT NULL REFERENCES lifecycle_events(event_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (event_id, evidence_id)
);

-- Runs / slices / candidates / results
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  plan_id TEXT,
  plan_version TEXT,
  coverage_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS slices (
  slice_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  adapter_id TEXT NOT NULL,
  acquisition_run_id TEXT,
  acquisition_slice_id TEXT,
  query_variant_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN (
    'succeeded','partial','failed','disabled','policy_blocked','not_supported'
  ))
);

CREATE TABLE IF NOT EXISTS run_candidates (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  candidate_id TEXT NOT NULL,
  posting_id TEXT REFERENCES postings(posting_id),
  slice_id TEXT REFERENCES slices(slice_id),
  stage TEXT NOT NULL CHECK(stage IN ('retrieved','enriched','assessed','ranked','dropped')),
  PRIMARY KEY (run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS run_results (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  posting_id TEXT NOT NULL REFERENCES postings(posting_id),
  rank INTEGER NOT NULL,
  utility REAL,
  coverage REAL,
  confidence REAL,
  PRIMARY KEY (run_id, posting_id)
);

-- Enrichment cache
CREATE TABLE IF NOT EXISTS enrichment_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('listing','attachment','framework','employer')),
  content_hash TEXT NOT NULL,
  enrichment_version TEXT NOT NULL,
  bounded_metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Source health
CREATE TABLE IF NOT EXISTS source_health (
  sample_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'succeeded','partial','failed','disabled','policy_blocked','not_supported'
  )),
  http_status INTEGER,
  latency_ms INTEGER,
  result_count INTEGER,
  error_code TEXT
);

-- Policy revisions
CREATE TABLE IF NOT EXISTS policy_revisions (
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  modes_json TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (source_id, revision)
);

CREATE TABLE IF NOT EXISTS policy_revision_evidence (
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (source_id, revision, evidence_id),
  FOREIGN KEY (source_id, revision) REFERENCES policy_revisions(source_id, revision)
);

-- Indexes (minimum query surface)
CREATE INDEX IF NOT EXISTS idx_obs_listing_fetched ON observations(source_listing_id, fetched_at);
CREATE INDEX IF NOT EXISTS idx_postings_lifecycle ON postings(lifecycle_state, posted_at);
CREATE INDEX IF NOT EXISTS idx_postings_org_title ON postings(organisation, normalized_title);
CREATE INDEX IF NOT EXISTS idx_memberships_listing ON memberships(source_listing_id);
CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_claim_candidates_posting ON claim_candidates(posting_id, field_path);
CREATE INDEX IF NOT EXISTS idx_identity_dec_obs ON identity_decision_observations(observation_id);
CREATE INDEX IF NOT EXISTS idx_identity_dec_superseded ON identity_decisions(superseded_by);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events ON lifecycle_events(posting_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_run_candidates_posting ON run_candidates(posting_id);
CREATE INDEX IF NOT EXISTS idx_source_health_source ON source_health(source_id, sampled_at);
`;
