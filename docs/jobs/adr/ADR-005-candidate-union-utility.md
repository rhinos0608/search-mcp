# ADR-005: Candidate union separate from utility ranking

**Status:** Approved, amended

## Context

BM25, semantic, family, and graph methods produce incompatible score scales.

## Decision

Use weighted RRF only to form candidate union. Rank candidates with grouped expected utility, separately exposing evidence coverage and confidence.

## Alternatives

Mixing raw RRF with feature scores was rejected due to incompatible scales.

## Consequences and verification

Utility is not eligibility probability. Verify union recall and grouped-score behavior independently.
