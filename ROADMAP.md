# Roadmap

## Current State (2026-05-04)

> Canonical plan status lives in `docs/plans/index.md`; this file is a legacy high-level summary.

| Release          | Status        | Notes                                                                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **V3.0.0**       | ✅ Done       | RAG pipeline extraction, YouTube/Reddit adapters                                                                          |
| **V3.0.5**       | ✅ Done       | Job adapter MVP, `semantic_jobs` tool                                                                                     |
| **V3.1 Phase 1** | ✅ Done       | SQLite corpus cache, Exa neural search                                                                                    |
| **V3.1.0 Code**  | ✅ Done       | Tree-sitter adapter, GitHub guardrails, `semantic_github_code`                                                            |
| **V3.1.1**       | ✅ Done       | Crawl reliability patch: HTML threading for `semantic_jobs`, timeout scaling for `web_crawl`, `semantic_crawl` size guard |
| **V3.1.5**       | ✅ Done       | RAG-Anything integration, code review fixes across RAG pipeline                                                           |
| **V3.2.0**       | ✅ In progress | Domain adapters (Stack Overflow, HN, academic, news), full job pipeline, `semantic_search`, constraint ranking, dedup, distribution packaging *(parallel track)* |
| **V3.3.0**       | ✅ Done       | Kill chain extraction, contextual embeddings, render recovery                                                              |
| **V3.3.1**       | ✅ Planned    | DuckDuckGo zero-key fallback, opt-in Ollama web search, availability-aware selection + merge                               |
| **V3.4.0**       | 🟡 Planned    | Integration: resolver pattern, output budget, structured errors, diagnostics                                               |
| **V3.5.0**       | 🔲 Pending    | Competitive integration                                                                                                    |
| **V4.0.0**       | ✅ Done       | **Deep Research Orchestration Engine** — LLM control loop, 3D confidence, multi-backend discovery, gap analysis, audit, synthesis |
| **V5.0.0**       | 🔲 Planned    | Persistent corpus indexes (was V4.0.0) — from ephemeral cache to durable research memory                                   |

## Roadmap Summary

- **V3.2.0** — domain adapters + structured retrieval; includes the distribution packaging work that used to sit in V3.4.0.
- **V3.3.0** — extraction resilience and search recall hardening.
- **V3.3.1** — search-backend expansion: DuckDuckGo plus opt-in Ollama web search.
- **V3.4.0** — integration work: resolver pattern, output budget, structured errors, diagnostics.
- **V3.5.0** — competitive integration.
- **V4.0.0** — Deep Research Orchestration Engine (replaces original V4 "persistent corpus indexes" → pushed to V5.0.0).

## Canonical Docs

- `docs/plans/index.md`
- `docs/plans/v3.3.0/SPEC.md`
- `docs/plans/v3.3.0/IMPLEMENTATION.md`
- `docs/plans/v3.3.1/SPEC.md`
- `docs/plans/v3.3.1/IMPLEMENTATION.md`
- `docs/plans/v4.0.0/SPEC.md`
- `docs/plans/v4.0.0/IMPLEMENTATION.md`

---

_Generated: 2026-05-04 · Last updated: 2026-05-04 (V4.0.0 Deep Research Orchestration)_
