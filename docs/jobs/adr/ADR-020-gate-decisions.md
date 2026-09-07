# ADR-020: Gate decisions

**Status:** Approved

## Summary

Record all D1–D17 gate decisions made during the jobs subsystem design. Each decision is recorded exactly once; implementation details live in the relevant Wave ADRs.

## D1 — Profile store encryption

SQLCipher whole-DB encryption approved for the profile store. The database file is encrypted at rest; no row-level or column-level granularity is required.

## D2 — Database key management

A random 32-byte key is generated on first run and stored exclusively in the OS keychain. Irrecoverable keychain loss resets the database — no pseudo-recovery, no backup passphrase, no escrow. The keychain entry is namespaced to the application.

## D3 — Persistence semantic boundary

Source material (raw crawl output, search results, scraped pages) is ephemeral. User-owned knowledge (normalized facts, preferences, corrections, provenance metadata, user-elected saved packets) is durable. Intermediate drafts are never auto-persisted. Raw resume text is never persisted.

## D4 — Raw resume scope

Raw resume text is request-scoped forever. It lives in memory for the duration of a single request and is not written to any durable store.

## D5 — Source registry design

A capability-based extensible source registry replaces a permanent government-plus-JobSpy allowlist. Sources escalate through tiers: indexed → public → registered → authenticated. New sources join at the appropriate tier without code changes to the registry itself.

## D6 — Access control triad

Three orthogonal concepts govern source access:

- **Evidence** — what the source has returned or what can be inferred from its data.
- **Local authorization** — whether the local installation is permitted to use the source.
- **External access status** — whether the source grants access to the caller.

Publisher "direct" restriction constrains the direct adapter only; third-party indexed views remain unaffected.

## D7 — SEEK access policy

SEEK direct access is blocked. Third-party indexed views of SEEK listings are visible. No SEEK credentials are stored or used by the subsystem.

## D8 — ATS registry

A static, operator-configured ATS registry defines which applicant tracking systems the subsystem can interact with. Credentials for registered ATS systems are stored in the OS keychain only.

## D9 — Destination fetch

Destination fetch (follow-through to the employer's actual application page) is opt-in via configuration. Default is off. When off, only metadata and third-party cached content are used.

## D10–D12 — Extractor contract, isolation, projections

D10: A formal extractor contract defines the boundary between raw source data and normalized profile data. All extractors implement this contract.

D11: Extraction reuses the Wave-0 isolation model — extractors run in a bounded context with no side effects outside their declared outputs.

D12: SQLite canonical projections provide the stable query surface over extracted data. Projections are derived from the extractor contract, not written by hand.

## D13 — Decision history

Complete logical decision history is maintained for reversibility. History is subject to user deletion cascades (deleting a user removes their decision history) and semantics-preserving compaction (merging equivalent decisions does not destroy the logical record).

## D14 — Destination evidence

Metadata is the primary data model for destinations. Destination evidence (what was scraped from the employer page) is bounded text only — no binary blobs, no rendered DOM snapshots, no screenshots.

## D15 — Query persistence

Raw query text persistence is off by default. Cache identity uses a canonicalized hash of the query, not the raw text. Optional diagnostics (for debugging) are opt-in and carry a maximum 7-day TTL.

## D16 — MCP surface

The MCP tool surface is unchanged by the jobs subsystem. No new MCP tools are introduced; existing tools gain internal capabilities that are invisible to MCP consumers.

## D17 — Cutover criteria

Cutover from the legacy pipeline to the new subsystem requires all of the following:

- 200+ stratified test queries covering all tiers and source types.
- Zero policy or integrity failures.
- 99%+ overall success rate.
- Recall@20 and NDCG@10 within 2 percentage points of the legacy pipeline.
- Any divergence of 30%+ on individual query categories triggers investigation before cutover.

## Consequences

- These decisions are binding on all subsequent Wave ADRs.
- Changes to any decision require a new ADR superseding this one.
- ADR-019 (retention) remains deferred until its specific gates are addressed.
