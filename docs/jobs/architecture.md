# Jobs architecture

**Status:** Authoritative design. Wave 0, Wave 1, Wave 3, and bounded non-persistent Wave 2A authorized. Wave 2B, production persistence, and retention gates remain blocked. SQLCipher and OS keychain storage are selected but currently inactive. See [indexed-discovery amendment](indexed-discovery-amendment.md).

## Scope and invariants

The jobs domain is a new `src/jobs/` vertical. `src/rag/` remains generic retrieval infrastructure. Existing useful code evolves incrementally; no rewrite-for-rewrite's-sake. Generic mechanisms remain separate from versioned locale/domain packs. Candidate facts, inferences, explicit preferences, eligibility unknowns, and learned preferences remain distinct.

Core invariants:

- `SourceListing` is mutable lifecycle identity; `SourceObservation` is immutable fetch evidence.
- Relational hot fields remain queryable; claim candidates and field evidence links preserve alternatives and provenance. No generic EAV replacement.
- Observed claims are never overwritten by model-derived interpretations.
- Identity resolution is non-destructive and records versioned, reversible decisions.
- Acquisition is additive, independently budgeted, failure-isolated, and governed by source policy separate from adapters.
- Policy binds one acquisition edge: actor, operation, route, and target. It does not bind information or evidence objects.
- Evidence carries provenance, not inherited access restrictions. Legal, confidentiality, or safety handling propagation requires separate explicit classification with cited basis; no such subsystem is invented here.
- Standalone deterministic search is complete without an LLM. Host reasoning is optional, bounded, validated, and provenance-backed.
- Sensitive profiles are separate from jobs and minimized. Encryption mechanism and retention values are not settled.
- Filesystem access uses trusted MCP roots/configured grants; never `$HOME` by default.
- Missing evidence uses stable neutral priors with low coverage/confidence; it never receives redistributed weight.

## Destination flow

```text
MCP client → jobs_search / jobs family
semantic_jobs → compatibility mapper → jobs_search
profile or inline content → bounded intent planner
intent → locale/domain packs + independent SourcePolicy
policy → additive parallel adapters/manual import
adapters → SourceListing + immutable SourceObservation
observations → canonical extraction → relational projections + claim candidates/evidence
claims → reversible identity decisions → jobs.sqlite
identity → broad candidate generation → selective enrichment → deterministic assessment
assessment → grouped expected-utility ranking → transparent diversity → persisted run/lifecycle
results → evidence-backed output; optional bounded packet → host model → validated proposal
```

One source failure does not fail a run. Coverage reports `succeeded`, `partial`, `failed`, `disabled`, `policy_blocked`, or `not_supported`; no results differs from insufficient coverage. Manual URL import never implies fetch permission; blocked URL-only import returns `content_required`.

## Module boundaries

| Path                                    | Ownership                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `src/jobs/domain/`                      | IDs, canonical schemas, evidence, claims, flags, lifecycle, identity types |
| `src/jobs/packs/`                       | pack contracts, validation, registry, versioning                           |
| `src/jobs/packs/locales/au-nsw-sydney/` | geography, salary, classifications, terminology                            |
| `src/jobs/packs/domains/`               | role topology, transfer, requirement interpretation                        |
| `src/jobs/profile/`                     | secure ingestion, extraction, fingerprinting, minimization                 |
| `src/jobs/acquisition/`                 | adapters, registry, coordinator, budgets, outcomes                         |
| `src/jobs/acquisition/policy/`          | independent versioned SourcePolicy registry                                |
| `src/jobs/acquisition/sourceClass/`     | source-class registry, capability classification                           |
| `src/jobs/acquisition/adapters/`        | JobSpy, ATS, government, crawl/search implementations                      |
| `src/jobs/extraction/`                  | structured/unstructured extraction and projections                         |
| `src/jobs/enrichment/`                  | listing, attachment, framework, employer enrichment                        |
| `src/jobs/identity/`                    | features, clustering, reversible decisions                                 |
| `src/jobs/persistence/`                 | SQLite repositories, migrations, lifecycle/run/profile storage             |
| `src/jobs/retrieval/`                   | fielded BM25, role-family, semantic retrieval, candidate union             |
| `src/jobs/assessment/`                  | requirement matching, capability transfer, fit, flags                      |
| `src/jobs/ranking/`                     | transforms, grouped policy, utility, coverage, confidence, diversity       |
| `src/jobs/reasoning/`                   | packets, submissions, optional provider, fallback                          |
| `src/jobs/feedback/`                    | interactions and bounded learned residual                                  |
| `src/jobs/evaluation/`                  | frozen corpora, labels, metrics, manifests, gates                          |
| `src/jobs/orchestration/`               | run state machine and cost budgets                                         |
| `src/tools/standalone/jobsSearch.ts`    | high-level MCP tool                                                        |
| `src/tools/families/jobs.ts`            | compact composable family                                                  |
| `src/tools/standalone/semanticJobs.ts`  | compatibility wrapper                                                      |
| `docs/jobs/`                            | architecture, ADRs, schemas, source matrix, migration, evaluation          |

Dependency direction: domain is foundational; packs and domain services depend on it; orchestration depends on services; MCP tools depend on orchestration. Adapters depend on acquisition contracts and SourcePolicy, never define policy. Packs never import adapters. Domain never imports persistence, MCP, LLM, or locale data. Reasoners receive bounded redacted packets only.

## Canonical model

`SourceListing` contains source listing ID, adapter ID, optional external ID/URL, first/last seen, and current observation ID. `SourceObservation` contains observation ID, listing ID, fetch time, content hash, optional payload reference, evidence references, extraction/adapter versions, fetch outcome, field-specific confidence, and immutable marker. Listings can update; observations never mutate. Raw payload retention remains policy-controlled.

`ClaimCandidate<T>` contains value, evidence refs, confidence, origin (`observed`, `user_supplied`, `deterministic_derived`, `model_derived`), method, and versioned provenance. `ResolvedClaim<T>` exposes resolved/conflicting/unresolved state, selected candidate, and alternatives. Explicit false is valid. Missing evidence is absent/unresolved, not persisted null rows. Relational projections are the primary query surface.

Hot posting projections include title, normalized title, organisation/unit, sector, dates, lifecycle, work mode, employment type, salary interval/currency, classification, verification, revisions, and identity revision. Related tables hold locations, role families, salary alternatives, classifications, requirements, application questions, source memberships, evidence links, claims, and conflicts.

Requirements preserve raw text, category, force (mandatory/preferred/uncertain), capability, qualifications/licences/clearance/registration/work rights/checks/availability/materials, evidence, confidence, and interpretation provenance. Packs interpret stated requirements but cannot invent them. Identified positions default to `eligibility_unknown` plus `identified_position_requirement`; protected characteristics are never inferred.

Identity decisions preserve subject observations/listings, outcome (`same_posting`, `probable_cluster`, `distinct`, `unresolved`, `split`), confidence, feature contributions, contradictions, resolver version, timestamps, and supersession. Same company/title alone cannot merge. Presentation dedup uses active decisions without deleting evidence.

Lifecycle is `discovered → active → probably_closed → confirmed_closed | expired | superseded`. A source disappearance creates source-removed/disappeared evidence, never confirmed closure alone.

## Retrieval, assessment, and reasoning

Raw fielded BM25 drives retrieval. A stable versioned monotonic transform excludes within-run percentile effects; index/tokenizer/boost/transform versions are recorded. Fielded BM25, normalized title, role-family graph, capability overlap, geography, and embeddings form a candidate union; weighted RRF forms the union only and never enters final utility.

Grouped score dimensions: relevance; candidate fit (requirements, responsibility, transfer); preference fit (location, work mode, compensation, sector/role); market state (freshness, closing); evidence quality (source quality, verification); personal adaptation (bounded learned residual). Explicit preferences enter once. Outputs are expected utility (not eligibility probability), evidence coverage, confidence, grouped breakdown, flags, and evidence refs. Unknowns use stable neutral prior, low coverage/confidence, and optional flags; strict exclusion occurs only when requested. Diversity movements are transparent and preserve score-gap exemptions.

Reasoning packets contain bounded candidate summaries, ambiguous questions, evidence excerpts, hashes/versions, and allowed response schema. Submissions require optimistic revision, packet hash, idempotency, evidence-ID allowlist, and cannot mutate preferences, observations, or observed claims. Provider failures degrade deterministically.

## Persistence and migration

`jobs.sqlite` holds migrations, postings, listings, observations, memberships, evidence, claims/resolutions, requirements, locations, identity decisions/clusters, snapshots/diffs, lifecycle events, runs/slices/candidates/results, enrichment cache, source health, and policy revisions. `profiles.sqlite` must remain separate. SQLCipher whole-DB encryption and OS keychain storage are selected but currently inactive; activation is blocked by retention work (ADR-019) and production key-provider implementation.

Migration default: create schema → backfill legacy postings as low-confidence legacy listings/observations → shadow pipeline → compare → cut over → retain compatibility projection → legacy read-only → zero-read/mutation soak → delete only with explicit approval. No default dual-write. Dual-write requires concrete mutation-consumer proof, reconciliation/idempotency/conflict/monitoring/exit plan, and approval. SQLite requires WAL, foreign keys, busy timeout, bounded transactions, integrity checks, checksums, backup, resumable backfill, no destructive down migration, and `synchronous=FULL` until recovery evidence supports change.

## MCP surface and compatibility

Approved surfaces: high-level `jobs_search`, compact `jobs` family (`capabilities`, `describe_action`, profile actions, `import_listing`, planning/discovery/enrichment/reasoning/finalization/run/posting/feedback/saved actions), and retained `semantic_jobs` compatibility wrapper. Outer family schema is compact `action` plus bounded request; selected action validates strict internal schema. Existing compatibility output remains stable during documented migration; new metadata is additive; removal requires consumer notice and zero/accepted usage evidence.

## Security and policy

Profile file handling uses trusted roots, canonicalization, realpath containment, traversal/symlink checks, size and extension/MIME/magic validation, constrained disposable child-process parser (network isolation not enforced by application), resource limits, bomb defenses, byte/parser fingerprinting, minimized evidence, and no raw content/path logs. HTTP path ingestion is disabled unless explicitly configured. Safe fetch revalidates DNS/private addresses every hop and redirects.

Source policy is versioned per source and mode (`automatedSearch`, `automatedFetch`, `userSuppliedContent`, `manualImport`, `employerApi`) with permitted/blocked/configuration/review/not-supported states. Policy binds acquisition edges, not information objects. Direct SEEK search/fetch is blocked absent permission; permitted third-party indexed candidates remain visible as provider-attributed, caveated evidence. Discoverer, publisher, and content donor remain distinct. ATS hosts are configured tenants, never arbitrary caller hosts. Indexed evidence does not taint or inherit policy restrictions; separate legal/confidentiality/safety handling classification requires explicit cited basis and is out of scope.

Encryption property is approved (separate encrypted profile store, key separation, rotation, recovery, deletion, backup boundary). SQLCipher whole-DB encryption and OS keychain storage are selected but currently inactive; activation is blocked by retention work (ADR-019) and production key-provider implementation. Until activation: profile processing is memory-only, raw résumé and full extracted text are never persisted, and sensitive evidence/packets are ephemeral. Retention gates cover profiles, raw observations, lifecycle, reasoning packets, and debug traces.

## Authorization, waves, and checkpoints

Wave 0 (PII-safe telemetry, safe fetch, parser/network budgets, SourcePolicy skeleton), Wave 1 (IDs/evidence/claims, listing/observation, canonical posting/intent, reversible identity contract, pack contracts, legacy mapper), Wave 3 indexed discovery/acquisition, and bounded non-persistent Wave 2A are authorized. Wave 0 precedes source expansion. W2A and W3 may proceed concurrently. Wave 2B profile persistence is blocked by retention work (ADR-019) and inactive encryption activation (SQLCipher + OS keychain selected, production key-provider not implemented). Wave 7 production persistence, Wave 10 packet persistence, Wave 12 debug persistence, and ambiguous source enablement retain settlement gates. Existing persistence and `query_log` gates remain unchanged.

Checkpoints: A (Waves 0–4) verifies shared controls, canonical multi-source records, immutable observations, independent policy, manual import, and generic core. B (5–7) verifies evidence-backed extraction, queryable fields, conflicts, merge/split, lifecycle, and migration comparison. C (8–10) verifies fixed-budget recall, stable BM25, missing-data semantics, grouped scores, standalone parity, and bounded host changes. D (11–14) verifies learning precedence, MCP progressive actions, compatibility, settled retention/encryption, no unexplained machinery, and no unresolved P0/P1 findings.

## Disposition

| Component                                                   | Disposition                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/rag/adapters/job.ts`                                   | retain/refactor into projections, claims, evidence                         |
| document extraction/parsers                                 | retain; harden behind constrained worker                                   |
| `src/rag/bm25.ts`, `src/rag/embedding.ts`, generic pipeline | retain generic; job retrieval versions integration                         |
| JobSpy client/pipeline/ranking/dedup                        | refactor/replace incrementally behind compatibility                        |
| quality checks                                              | split: retain junk/bot/page intent; retire hardcoded locale/role rejection |
| graph DB                                                    | migrate, read-only after cutover                                           |
| semantic jobs tools                                         | retain as compatibility mapper/deprecation path                            |
| source metadata/instrumentation/http guards                 | refactor/extend; remove PII and harden before adapters                     |
| Python JobSpy sidecar                                       | delete candidate after deployment/package proof                            |
| fixtures/evaluation                                         | retain and freeze baseline before tuning                                   |

See [ADR index](adr/index.md) (includes ADR-021 source-class registry, ADR-022 MCP surface narrow supersede), [research ledger](research-ledger.md), [source coverage](source-coverage.md), and [implementation graph](implementation-graph.md).

Implementation and offline closure evidence: [Wave 3 acquisition closure evidence](wave-3-acquisition-closure-evidence.md).
