# ADR-008: Optional bounded agent reasoning

**Status:** Approved

## Context

Mandatory LLM dependence harms privacy, resilience, and protocol independence.

## Decision

Standalone deterministic search is complete. Optional reasoners receive bounded redacted packets and return schema-versioned proposals with provenance. Validate packet hash, revisions, idempotency, evidence IDs, and permissions; failures fall back deterministically.

## Alternatives

Mandatory internal LLM and MCP Sampling dependency were rejected.

## Verification

Unknown evidence IDs, preference mutation, and raw-profile exposure must fail.
