# ADR-026: Remove unpublished legacy jobs pipeline

**Status:** Accepted

## Context

The legacy `semantic_jobs` RAG pipeline, compatibility mapper, graph helpers, quality gates, Python JobSpy sidecar, and related unpublished tests had no supported external consumer. The replacement `jobs_search` and `jobs` surfaces provide current acquisition through policy-gated in-process JobSpy and indexed providers.

## Decision

Delete the unpublished legacy jobs implementation and remove its registration, configuration, health entry, RAG job adapter type, and legacy-only tests. Preserve the new acquisition adapter and useful W3-J acquisition coverage. Defer standalone legacy-vs-new comparison benchmarks; they are not acceptance criteria for current product completion.

Historical plans and ADRs remain records. ADR-017 is updated for current MCP surfaces; ADR-022 is superseded; ADR-024 is updated for the retained in-process JobSpy boundary.

## Consequences

`semantic_jobs` is no longer registered or documented. `jobs_search` and `jobs` are sole jobs MCP surfaces. Future benchmark work requires a separately approved design and independent fixtures.
