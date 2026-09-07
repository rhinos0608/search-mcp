# ADR-007: Missing-data semantics

**Status:** Approved

## Context

Absent evidence must not reward or silently penalize a candidate.

## Decision

Use stable documented neutral priors, low evidence coverage, reduced confidence, and user-facing uncertainty flags where relevant. Never redistribute missing weight. Unknown excludes only when caller requests `unknownPolicy=exclude`.

## Alternatives

Redistributing missing component weight was rejected because ignorance becomes reward.

## Verification

Test absent, explicit false, uncertain, and contradicted claims separately.
