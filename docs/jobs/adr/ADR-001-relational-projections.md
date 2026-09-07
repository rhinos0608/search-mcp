# ADR-001: Relational projections with evidence-backed claims

**Status:** Approved, amended

## Context

Hot job fields need queryable indexes without losing alternatives, conflicts, or provenance.

## Decision

Keep relational canonical projections. Represent alternatives with `ClaimCandidate<T>` and `ResolvedClaim<T>`. Do not persist unknown rows for absence; preserve field evidence links. Observed claims cannot be overwritten by derived/model claims.

## Alternatives

Generic EAV for every field was rejected for poorer query clarity/performance and drift risk.

## Consequences and verification

Projection resolution/versioning must be explicit. Verify false, unknown, conflict, and provenance cases.
