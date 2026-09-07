# ADR-022: Narrow supersession of ADR-020 D16 for jobs MCP surface

**Status:** Approved

## Context

ADR-020 D16 states "The MCP tool surface is unchanged by the jobs subsystem. No new MCP tools are introduced."

The jobs subsystem introduces an additive `jobs_search` tool and a compact `jobs` family tool. These are strictly additive — no existing tools are modified, removed, or replaced.

## Decision

The mission supersedes ADR-020 D16 **only** for:

- The additive `jobs_search` standalone tool
- The compact `jobs` family tool

D16 remains in force for all non-jobs subsystem surfaces. No other MCP tools are introduced or modified by the jobs subsystem.

## Scope

- **In scope:** `jobs_search` tool, `jobs` family tool
- **Out of scope:** All other MCP tools (web_search, rss, github, youtube, reddit, research, packages, browser, agentic_browse, web_crawl, semantic_crawl, health_check, fetch_focus)

## Notes

ADR-017 already defines the jobs MCP family surface. This ADR narrows D16 to avoid conflict with ADR-017 while preserving D16's protective intent for all other surfaces.

Implementation of `jobsSearch.ts` and `families/jobs.ts` is not part of this stage. Docs were written ahead of code.
