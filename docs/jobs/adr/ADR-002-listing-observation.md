# ADR-002: Mutable listings and immutable observations

**Status:** Approved

## Context

Lifecycle timestamps and historical fetch evidence have different mutation semantics.

## Decision

`SourceListing` owns first/last seen and current observation. `SourceObservation` is immutable historical evidence; repeated content may deduplicate payload bytes but not observation identity.

## Alternatives

One mutating observation row was rejected because it conflates lifecycle and provenance.

## Consequences and verification

Listings can point to many observations; observations retain hashes, versions, outcomes, and evidence. Verify round-trip immutability and lifecycle updates.
