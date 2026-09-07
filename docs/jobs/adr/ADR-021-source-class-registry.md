# ADR-021: Source-Class Registry

## Status

Accepted (Wave 4 frozen contract)

## Context

The acquisition system needs a way to classify sources by their external access posture, local authorization state, and capability bindings. Prior to W4, source policies were flat per-sourceId lookups (`SourcePolicyRegistry.decide()`) that could not express the full edge tuple (actor kind/namespace/id, operation, route, target kind).

This creates a gap: the system cannot distinguish between the same source accessed through different actors, routes, or target kinds. A source that is `permitted` for an indexed provider search may be `blocked` for direct fetch, but the flat lookup cannot express this.

## Decision

Introduce a source-class architecture with:

1. **SourceClassRegistry**: stores source entries, authorization evidence, and produces materialized `SourceEdgePolicy[]`.

2. **SourceEdgePolicy**: materialized per 7-tuple (sourceId, actor kind/namespace/id, operation, route, target kind) with resolved state, revision, evidence refs, and review timestamp.

3. **Exact edge-scoped decide()**: `SourcePolicyRegistry.decideEdge()` keyed by full 7-tuple. Exact match first; mismatched actor/route/target returns fail-closed sentinel; legacy fallback only when no exact rules exist.

4. **Deterministic IDs**: `source-evidence:sha256(...)`, `source-policy:sha256(...)`, `ats-tenant:<platform>:<key>`.

5. **SEEK factory**: `buildSeekEntry()` produces the frozen SEEK source-class entry with correct modeOverrides.

6. **ATS tenant config**: `AtsTenantRegistry` validates request contexts, prevents host-based tenant selection.

7. **Destination fetch consultation**: `destinationFetchCapabilities()` returns `[]` when global flag is false; capability never authorizes work alone.

## Consequences

- Additive only: existing `decide()` behavior preserved as legacy fallback.
- No W3 contract version change.
- No live adapter additions.
- No persistence, MCP, or dashboard changes.
- Evidence never changes policy state.
- Capability never grants permission.
- Operator enablement is local authority only.

## References

- ADR-011: Source Policy
- ADR-012: SEEK Manual Import
- ADR-013: ATS Tenants
- W4 frozen contract (session 2a1eccec)
