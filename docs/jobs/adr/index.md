# Jobs ADR index

Authoritative decisions are summarized in [architecture](../architecture.md). Full records:

- [ADR-001 Relational projections and claims](ADR-001-relational-projections.md)
- [ADR-002 Listing and observation](ADR-002-listing-observation.md)
- [ADR-003 Reversible identity](ADR-003-reversible-identity.md)
- [ADR-004 Core and packs](ADR-004-core-and-packs.md)
- [ADR-005 Candidate union and utility](ADR-005-candidate-union-utility.md)
- [ADR-006 Stable lexical transform](ADR-006-stable-lexical.md)
- [ADR-007 Missing data](ADR-007-missing-data.md)
- [ADR-008 Optional reasoning](ADR-008-optional-reasoning.md)
- [ADR-009 Profile encryption](ADR-009-profile-encryption.md)
- [ADR-010 Filesystem capability](ADR-010-filesystem-capability.md)
- [ADR-011 Source policy](ADR-011-source-policy.md)
- [ADR-012 SEEK and manual import](ADR-012-seek-manual-import.md)
- [ADR-013 ATS tenants](ADR-013-ats-tenants.md)
- [ADR-014 Migration](ADR-014-migration.md)
- [ADR-015 Data minimization](ADR-015-data-minimization.md)
- [ADR-016 Health interpretation](ADR-016-health-interpretation.md)
- [ADR-017 MCP family](ADR-017-mcp-family.md)
- [ADR-018 Evaluation](ADR-018-evaluation.md)
- [ADR-019 Retention](ADR-019-retention.md)
- [ADR-020 Gate decisions](ADR-020-gate-decisions.md)
- [ADR-021 Source-class registry](ADR-021-source-class-registry.md)
- [ADR-022 MCP surface narrow supersede](ADR-022-mcp-surface-supersede.md)

Status convention: Approved decisions are frozen; ADR-009 property is approved but mechanism is chosen-but-unactivated (only `MemoryKeyProvider`, no production profile persist until ADR-019 activation); ADR-019 is deferred. ADR-022 narrowly supersedes ADR-020 D16 for additive jobs MCP tools only. Source-access gates remain unresolved where noted in `source-coverage.md`.
