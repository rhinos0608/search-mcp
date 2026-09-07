# ADR-015: Data minimization and protected attributes

**Status:** Approved

## Decision

Retain only retrieval, fit, requested eligibility, and auditable provenance data. Names, contacts, addresses, photographs, and general identity are not ranking features. Never infer protected attributes; explicit protected data participates only in user-requested eligibility assessment.

## Consequences and verification

Identified positions default to unknown plus a requirement flag; listing text remains authority. Verify PII fixtures do not reach ranking inputs.
