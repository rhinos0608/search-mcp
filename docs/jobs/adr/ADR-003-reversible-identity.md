# ADR-003: Non-destructive reversible identity

**Status:** Approved

## Context

Source copies and reposts can be falsely merged; later evidence can split a cluster.

## Decision

Preserve all observations and append versioned `IdentityDecision` records. Merge, split, and supersession retain prior memberships and contradictory evidence. Presentation dedup uses active revision only.

## Alternatives

Destructive company/title dedup was rejected as irrecoverable.

## Consequences and verification

History grows and projections reference active revisions. Verify merge-then-split recovery and same company/title non-merge.
