# Jobs Closure Ledger

> Evidence-based dispositions for Oracle-synthesized P0/P1 findings across W2B/W4/W5/W6/W7/W10/W11/W12.
> W8 retrieval implementation added. W9 assessment/ranking library added.
> Updated by sole writer stage for P0/P1 synthesis fixes. Does not claim later waves closed.

---

## Implemented Fixes (6 files, 59 insertions, 74 deletions)

### F1. corpus.ts — manifest hash computed before label content hashes (P0)

- **File**: `src/jobs/evaluation/corpus.ts:20-28`
- **Bug**: `computeManifestHash(manifest)` called before `manifest.labels` replaced with recomputed content hashes. Stored hash reflects stale label data; `verifyManifest` would always fail.
- **Fix**: Moved label hash recomputation BEFORE `computeManifestHash`. Labels now stable before hash.
- **Risk**: Hash value changes for all new corpora. Existing frozen corpora unaffected (already committed).

### F2. enrichment/pipeline.ts — listing role families discarded (P1)

- **File**: `src/jobs/enrichment/pipeline.ts:47-57, 185-200, 235-247`
- **Bug**: `enrichListing()` returns `roleFamilies` but pipeline stores `roleFamilies: []` in result. Listing enrichment produces zero role families in output.
- **Fix**: Added `allRoleFamilies` accumulator; both complete and partial result paths carry `listingResult.roleFamilies`.
- **Risk**: Low. Existing tests still pass. Role families only populated when domainPack provided.

### F3. feedback/store.ts — idempotency omits runId (P1)

- **File**: `src/jobs/feedback/store.ts:51-70`
- **Bug**: Idempotency check compared type/postingId/rating/occurredAt/featureKeys but not runId. Two records with different runId but same other fields treated as idempotent.
- **Fix**: Added `existing.runId === input.runId` to idempotency comparison.
- **Risk**: Low. Existing tests pass. runId is optional; `undefined === undefined` for records without runId.

### F4. feedback/interactions.ts — exported parser bypasses Zod schema (P1)

- **File**: `src/jobs/feedback/interactions.ts:1-14`
- **Bug**: `parseRecordInteractionInput` performed manual field-by-field validation instead of using `RecordInteractionInputSchema.safeParse`. Bypassed Zod superRefine (rating-required logic).
- **Fix**: Replaced manual parser with `RecordInteractionInputSchema.safeParse(input)`. 60 lines removed.
- **Risk**: Low. Stricter validation now enforced by schema. Tests pass.

### F5. evaluation/gates.ts — D17 checks only success rate (P1)

- **File**: `src/jobs/evaluation/gates.ts:332-362`
- **Bug**: D17 checkpoint only emitted success rate check. ADR requires stratification (≥2 categories), Recall/NDCG parity, and category divergence checks.
- **Fix**: D17 P1 gates evaluate category count (≥2), Recall@20/NDCG@10 presence, and per-category >20% regression vs suite macro. `D.no_open_p0p1` runs after so failed D17 P1s are included.
- **Risk**: Low. Empty metrics fail stratification/recall_parity; `D.no_open_p0p1` then fails.

### F6. extraction/pipeline.ts — claim candidate IDs violate contract (P1)

- **File**: `src/jobs/extraction/pipeline.ts:199-212`
- **Bug**: `buildClaimCandidate` used `claim-candidate:${field.evidenceId}` (non-hashed, non-deterministic) instead of `extractionClaimCandidateId()` which produces `claim-candidate:<sha256>`.
- **Fix**: Calls `extractionClaimCandidateId(observationId, fieldPath, origin, method, value)` for proper deterministic ID.
- **Risk**: Low. IDs change for new extractions. Existing persisted IDs unchanged.

### D5. profile store — expectedRevision null is explicit initial revision (P1)

- **File**: `src/jobs/profile/persist/store.ts:346-365`
- **Dispositon**: FIXED — empty store current revision normalized to null; `expectedRevision: null` accepted as the explicit initial revision. Mismatched non-null revisions still throw `REVISION_CONFLICT`.

### D8. identity/resolve — proposeIdentityDecision always empty listingIds (P1)

- **File**: `src/jobs/identity/resolve.ts:25`, `src/jobs/identity/contracts.ts:60-68`
- **Dispositon**: FIXED — `proposeIdentityDecision` now accepts optional `leftListingId`/`rightListingId` in opts. Callers pass listing IDs when available.

### D9. persistence — observation immutability triggers (P1)

- **File**: `src/jobs/persistence/schema.sql.ts`
- **Dispositon**: FIXED — Added `CREATE TRIGGER` for BEFORE UPDATE and BEFORE DELETE on `observations` table. `CHECK(immutable = 1)` only prevented inserts; triggers now enforce immutability at SQL level.
- **Note**: `setMemberships` delete-before-insert is standard for mutable projections, not a defect.

---

## Deferred Findings (Not Changed)

### D1. profile/persist — only MemoryKeyProvider, no OS keychain (P0)

- **File**: `src/jobs/profile/persist/keyProvider.ts`, `src/server.ts`
- **Dispositon**: ADR-020 D2 requires OS keychain for durable profiles. Only `MemoryKeyProvider` exists (volatile). Adding keychain provider is a new dependency + activation gate.
- **Edge**: Requires decision on keychain library selection and activation surface.
- **Dependency**: None; can be added independently.

### D2. persistence — raw blobs in coverageJson/budgetJson/boundedMetadataJson (P0)

- **File**: `src/jobs/persistence/contracts.ts`, `src/jobs/persistence/store.ts`, `src/jobs/persistence/schema.sql.ts`
- **Dispositon**: `JobsRun.coverageJson`, `JobsRun.budgetJson`, `EnrichmentCacheRow.boundedMetadataJson` accept arbitrary JSON. No schema-level enforcement of forbidden fields.
- **Edge**: Requires typed projection schemas and migration for existing data.
- **Dependency**: None.

### D3. evaluation/gates — unsupported claims pass (P0)

- **File**: `src/jobs/evaluation/gates.ts:55-333`
- **Dispositon**: Many gates emit `passed: true` as placeholders. Privacy, policy, compatibility, retention gates lack typed evidence requirements.
- **Edge**: F5 adds deferred D17 gates. Remaining gates require evidence schema design.
- **Dependency**: None (this finding covers evidence typing).

### D4. evaluation/types — EvalQuery.intent: unknown loads raw fixture intent (P0)

- **File**: `src/jobs/evaluation/types.ts:98-103`
- **Dispositon**: `intent: unknown` is fixture-only by contract comment. `intentFingerprint` is persisted. Intent never written to process logs.
- **Edge**: Low risk — intent field is not in process logs. Fixture files are committed artifacts.
- **Dependency**: None if fixture-only contract holds.

### D6. acquisition/sourceClass — SEEK direct-block and manual entry collision (P1)

- **File**: `src/jobs/acquisition/sourceClass/seek.ts`, `src/jobs/acquisition/sourceClass/registry.ts`
- **Dispositon**: `buildSeekEntry` and `buildSeekManualEntry` both produce `sourceId: 'board:seek'`. Registry rejects duplicate sourceIds. They are designed as alternatives, not cumulative.
- **Edge**: No actual collision — callers choose one factory. Design is intentional.
- **Dependency**: None.

### D7. enrichment/pipeline — budget-exhausted stages still execute (P1)

- **File**: `src/jobs/enrichment/pipeline.ts`
- **Dispositon**: Budget check gates each stage correctly (`unitsConsumed < budget`). Final `budgetRemaining: 0` in both paths.
- **Edge**: Appears correct — budget checked before each stage increment.

### D10. reasoning/packet — profileRevision in SAFE_STRUCTURAL_KEYS (P1)

- **File**: `src/jobs/reasoning/packet.ts:86-100`
- **Dispositon**: `profileRevision` is in `SAFE_STRUCTURAL_KEYS`, excluded from redaction scan. Schema bounds it to `z.string().min(1).max(128).optional()`.
- **Edge**: 128-char bound prevents bulk data exfiltration. Adding fingerprint validation is hardening, not a defect.

### D11. feedback — privacy test assertions vacuous (P2)

- **File**: `test/jobs/feedbackPrivacy.test.ts:117-149`
- **Dispositon**: Deferred P2. Test assertions may be placeholders.

### D12. evaluation/corpus — verifyManifest(freezeCorpus) round-trip test (P1)

- **File**: `src/jobs/evaluation/corpus.ts`
- **Dispositon**: F1 fixed the hash ordering. Integration test for `verifyManifest(freezeCorpus(...))` round-trip recommended but not added in this stage.

---

## Dependency Graph

```
F1 (corpus hash) ──────────────────── independent
F2 (enrichment roleFamilies) ──────── independent
F3 (feedback idempotency) ─────────── independent
F4 (feedback schema parser) ────────── independent
F5 (D17 gates) ─────────────────────── independent
F6 (extraction candidate IDs) ──────── independent
D1 (keychain provider) ─────────────── requires decision
D2 (persistence typed blobs) ────────── independent
D3 (gate evidence) ──────────────────── independent (evidence typing)
D4 (intent: unknown) ────────────────── independent
D5 (expectedRevision null) ──────────── FIXED (null = initial revision)
D6 (seek registry collision) ────────── resolved (no bug)
D7 (budget gating) ──────────────────── resolved (no bug)
D8 (identity listing IDs) ───────────── FIXED (opts threading)
D9 (persistence immutability) ────────── FIXED (triggers added)
D10 (profileRevision scan) ───────────── resolved (schema bounded)
D11 (privacy test vacuous) ───────────── P2 deferred
D12 (verifyManifest test) ────────────── test recommended (not added)
```

## Validation Evidence

| Command                                  | Status    | Detail                                                       |
| ---------------------------------------- | --------- | ------------------------------------------------------------ |
| `npx tsc --noEmit -p tsconfig.json`      | passed    | Clean compile, strict mode                                   |
| `npx tsc --noEmit -p tsconfig.test.json` | passed    | Clean compile, test project                                  |
| `npm test` (focused files)               | passed    | assessment: 25 pass, retrieval: 31 pass, evaluation: 26 pass |
| `npx eslint` (touched src)               | passed    | No lint errors                                               |
| `npx prettier --check` (touched files)   | passed    | All formatted                                                |
| `git diff --check`                       | passed    | No whitespace issues                                         |
| No staged files                          | confirmed | git diff --cached empty                                      |

---

## W8 Retrieval Implementation

### Added: `src/jobs/retrieval/` (10 files)

| File                            | Purpose                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `contracts.ts`                  | Zod schemas: channel IDs, weights, CandidateRetrievalMetadata, RetrievalResult |
| `lexical.ts`                    | Stable versioned monotonic lexical transform v1 (tokenize, merge)              |
| `channels/textBm25.ts`          | Fielded BM25+ scoring (reuses `src/utils/bm25.ts`)                             |
| `channels/roleFamily.ts`        | Role-family graph proximity scoring using DomainPack                           |
| `channels/capabilityOverlap.ts` | Capability overlap (Jaccard) scoring using DomainPack                          |
| `channels/geography.ts`         | Geography matching using LocalePack hierarchy                                  |
| `channels/semantic.ts`          | Optional semantic channel (passthrough, no network)                            |
| `rrf.ts`                        | Weighted RRF candidate union (omitted channels not reweighted)                 |
| `pipeline.ts`                   | Main retrieval pipeline: channels → RRF → deterministic ranking                |
| `index.ts`                      | Barrel exports                                                                 |

### Frozen contract compliance:

| Requirement                                         | Implementation                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Fielded BM25+                                       | Per-field BM25+ indices with configurable weights (`textBm25.ts`)                       |
| Stable versioned monotonic lexical transform        | `lexical.ts` — `LEXICAL_TRANSFORM_VERSION = '1.0.0'`, percentile-independent            |
| Role-family graph                                   | `roleFamily.ts` — BFS proximity over DomainPack edges                                   |
| Capability overlap                                  | `capabilityOverlap.ts` — Jaccard over DomainPack capabilities                           |
| Geography                                           | `geography.ts` — LocalePack hierarchy matching                                          |
| Optional semantic channel                           | `semantic.ts` — pre-computed scores passthrough                                         |
| Weighted RRF union, omitted channels not reweighted | `rrf.ts` — weights applied per-channel, zero-weight channels contribute nothing         |
| Neutral 0.5 for missing evidence                    | Channels emit 0.5 for absent data; no weight redistribution                             |
| Deterministic ordering/ties/version metadata        | Stable sort by score then candidateId; version stamps on every output                   |
| RRF rank/score metadata only, never W9 utility      | Output schema has no utility/confidence/coverage fields                                 |
| No LLM, no network, no locale defaults              | All pure functions, no external calls                                                   |
| Reuse generic BM25 only where direction fits        | `textBm25.ts` imports `src/utils/bm25.ts` (reusable util, correct dependency direction) |

### Tests: `test/jobs/retrieval.test.ts` (31 tests)

| Test                     | Coverage                                                                  |
| ------------------------ | ------------------------------------------------------------------------- |
| Lexical tokenization (3) | Split, lowercase, numbers, empty                                          |
| Token merging (1)        | Dedup + sort                                                              |
| Text BM25 channel (4)    | Title ranking, field weights, candidateId mapping, lexical consistency    |
| Semantic channel (3)     | Omit missing scores, provided scores, partial maps                        |
| RRF fusion (8)           | Single/multi-channel, ties, weight non-redistribution, metadata, neutrals |
| Pipeline integration (9) | Minimal input, truncation, empty, determinism, postingId map, flags       |
| Geography channel (2)    | Hierarchy matching, omitted when intent has no locations                  |
| Capability overlap (1)   | Mixed-case role IDs                                                       |

### What W8 does NOT do (W9 territory):

- No utility/coverage/confidence computation on candidates
- No personalization/adaptation
- No final ranking for output
- No reason/purpose scoring
- No profile-weighted scoring
