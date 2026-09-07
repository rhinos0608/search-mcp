# ADR-006: Stable lexical transform

**Status:** Approved

## Context

Within-run rank percentiles change when unrelated sources add results.

## Decision

Raw fielded BM25 drives retrieval; final lexical relevance uses a stable, monotonic, versioned transform with fixed parameters. Record index, tokenizer, boosts, and transform versions.

## Alternatives

Result-set-relative normalization was rejected as non-reproducible.

## Consequences and verification

Later calibration requires frozen-corpus migration. Verify same query/document/index yields same score regardless of result count.
