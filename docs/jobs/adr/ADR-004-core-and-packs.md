# ADR-004: Generic core plus locale/domain packs

**Status:** Approved

## Context

Job mechanisms should operate generically while Sydney/NSW and role knowledge evolve independently.

## Decision

Keep country, locale, role, salary, and seeker assumptions out of core. Install versioned locale and domain packs with validation, citations, licensing metadata, and fixtures.

## Alternatives

Global flags in generic classifiers were rejected.

## Consequences and verification

Packs add specialization without adapter coupling. Verify invalid packs reject and generic core has no AU defaults.
