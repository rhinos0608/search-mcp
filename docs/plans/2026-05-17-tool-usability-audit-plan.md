# Tool Usability Audit and Ergonomics Improvement Plan

Date: 2026-05-17

## Executive summary

The server has strong coverage, but many tools still expose implementation detail too early. The main usability issue is not that clients cannot discover tools. Most MCP clients already provide tool discovery, ranking, filtering, and UI-level affordances at a higher abstraction. The real issue is that, once a client chooses a tool, the call shape often requires too much knowledge of backend internals, lifecycle protocols, naming conventions, and expert options.

The goal should be to make the existing tool surface easier to call correctly, easier to recover from, and easier for different clients to integrate consistently.

Recommended north star:

1. Keep existing specialist tools and action families for compatibility and power users.
2. Improve high-traffic tools first: smaller happy-path schemas, safer defaults, common aliases, and clearer recovery metadata.
3. Normalize common fields such as `query`, `url`, `repo`, `limit`, `language`, `sort`, `depth`, and `options`.
4. Move expert knobs behind progressive disclosure so minimal calls stay small.
5. Treat validation, fallback, partial success, and retry guidance as part of the public tool contract.
6. Add new top-level tools only when existing tools cannot be made ergonomic without breaking compatibility.

## Current tool surface inventory

Registered visible tools in a typical configured server:

| Tool | Shape | Audit note |
|---|---:|---|
| `web_search` | standalone | Good first step, but overlaps with research, semantic crawl, packages, Reddit, GitHub, and deep research workflows. |
| `web_read` | standalone | Clear, but callers must know when a plain page read is enough and when focused extraction, crawl, or browser extraction is better. |
| `web_crawl` | standalone | Low-level Crawl4AI wrapper; many crawler implementation knobs leak into the public schema. |
| `semantic_crawl` | standalone | Powerful but cognitively heavy: source union, crawl options, RAG options, reranking, output budgeting, and corpus persistence are all visible. |
| `semantic_crawl_list_corpora` / `semantic_crawl_inspect_corpus` | standalone | Useful cache utilities, but require understanding corpus workflow. |
| `fetch_focus` | standalone | Strong workflow concept; overlaps with `web_read`, `semantic_crawl`, and browser extraction. |
| `deep_research` | action family in one tool | Powerful but the `start` / `poll` / `save` job protocol is friction for common one-shot use. |
| `semantic_jobs` | standalone | Strong vertical workflow; many provider/config options exposed. |
| `github` | action family | Useful consolidation; callers still need to know action names and repo locator shapes. |
| `youtube` | action family | Good grouping; could be easier with URL-first transcript/search defaults. |
| `reddit` | action family | Good grouping; comments ergonomics improved, but URL/post/subreddit variants still need tolerant input handling. |
| `research` | large action family | Most confusing non-browser family: many source names compete with generic web/research intent. |
| `packages` | action family | Simple; good candidate for field normalization and cross-tool output consistency. |
| `browser` | very large action family | Most complex visible tool. Low-level automation and high-level extraction live in one schema. |
| `knowledge_graph` | action family | Mixes user workflows and operational/admin actions; should be made clearer through action naming, descriptions, and safety metadata. |
| `health_check` | standalone | Useful for operators, but not a user workflow. |

## Main usability problems

### 1. Common calls require implementation knowledge

Even after a client has selected a relevant tool, the caller often still needs to know backend-specific modes, action names, lifecycle steps, or parameter conventions before the first useful result.

Examples:

- “Find what people are saying about X” may require choosing between generic web, Reddit search, Reddit semantic search, Hacker News, research, or deep research.
- “Read this URL and answer a question” may require deciding between page read, focused extraction, crawl, semantic crawl, or browser extraction.
- “Research this topic” may require selecting source family, depth, output mode, job lifecycle behavior, and save behavior up front.
- “Look in this GitHub repo” may require knowing whether to pass `repo`, `repository`, `owner` + `repo`, URL, branch, path, or search query.

This is less a discovery problem than a call-shape problem. Happy-path calls should accept obvious inputs, apply safe defaults, and expose backend choices as metadata rather than requiring the caller to decide everything up front.

### 2. Expert knobs appear before the happy path

Several tools expose powerful advanced controls directly in the primary schema.

Examples:

- `semantic_crawl`: source types, crawl strategy, depth/page budgets, reranker, contextual embeddings, output modes, byte budgets.
- `browser`: session lifecycle, network interception, dialogs, iframe switching, download interception, pagination, resource timing, diffing.
- `deep_research`: job lifecycle actions before a simple “run this research” path.
- `research`: many source actions before a simple “search relevant research sources” path.

These controls are valuable, but they should be progressively disclosed. The minimum successful call should remain small.

### 3. Similar concepts use inconsistent field names

Observed variants:

- Count: `limit`, `maxResults`, `maxVideos`, `maxPosts`, `topK`, `commentLimit`.
- Target: `url`, `target`, `post`, `videoId`, `repository`, `owner` / `repo`, `repo`, `source`.
- Sort/time: `sort`, `order`, `sortBy`, `since`, `timeframe`, `timespan`.
- Language: `language`, `transcriptLanguage`.
- Depth/budget: `depth`, `crawlDepth`, `maxPages`, `pageLimit`, `outputBudget`, `maxBytes`.

This increases call errors and makes learned behavior less portable across tool families.

### 4. Consolidation reduced tool count but increased per-tool schema complexity

The action-family pattern is good for avoiding dozens of top-level tools, but large families make each tool schema harder for clients and models to inspect.

The clearest examples are:

- `browser`, where common page capture and advanced browser debugging live in the same large action surface.
- `research`, where source-specific actions compete with generic research intent.
- `knowledge_graph`, where user-facing memory/query operations live beside administrative operations.

The fix is not necessarily more top-level tools. The fix is clearer common-case action shapes, better grouping, better descriptions, and progressive disclosure.

### 5. Recovery depends too much on client-specific retry behavior

`health_check` helps operators understand configuration, but ordinary tool calls should also return actionable recovery information.

When a backend is unavailable, validation fails, a fallback is used, or a result is low-confidence, the server should expose structured metadata that clients can use without bespoke logic.

Examples of useful recovery metadata:

- What backend was used.
- Whether fallback occurred.
- Why fallback occurred.
- Whether retry is recommended.
- A corrected minimal call.
- Which fields were ignored, defaulted, or normalized.
- Whether output is partial.
- Whether a timeout occurred.
- Whether a result came from cache.

This makes the tool surface easier for lightweight clients, not just sophisticated agent harnesses.

## High-leverage plan

### Phase 1 — Fix high-frequency call ergonomics

Start by making the tools clients already call easier to invoke correctly. Add new wrappers only as a last resort when an existing shape cannot be made ergonomic without breaking compatibility.

The default strategy should be:

- Shared schema normalization.
- Compatibility aliases.
- Safe defaulting.
- Empty-string/null handling.
- Stable response metadata.
- Lifecycle shortcuts inside existing action families.
- Progressive disclosure of advanced knobs.

### 1. Search ergonomics

Purpose: make search-like tools easy to call with minimal, predictable arguments.

Recommended minimal shape for new or revised search-like actions:

```ts
{
  query: string,
  scope?: 'auto' | 'web' | 'academic' | 'social' | 'code' | 'packages' | 'jobs' | 'news',
  depth?: 'quick' | 'standard' | 'deep',
  limit?: number,
  options?: {}
}

This shape does not have to become a new top-level gateway. It can be applied to existing tools or actions where appropriate.

Expected behavior:

* query is always the primary natural-language input.
* scope defaults to auto where backend routing is safe.
* depth controls effort, not implementation details.
* limit uses one canonical count field.
* Advanced backend-specific options live under options.
* Existing fields remain accepted as aliases during migration.

Examples of deterministic routing/defaulting:

* Query mentions “paper”, “doi”, “arxiv”, “citation” → prefer academic/research backend when configured.
* Query mentions Reddit URL, subreddit, “comments”, or r/... → prefer Reddit backend.
* Query mentions npm, PyPI, package, dependency → prefer packages backend.
* Query mentions jobs, hiring, role, location → prefer jobs backend.
* Otherwise use generic web search.

Return metadata should be operational and consistent:
{
  "tool": "web_search",
  "action": "search",
  "usedBackend": "web_search",
  "usedFallback": false,
  "warnings": [],
  "retry": {
    "recommended": false
  }
}
If fallback occurs:
{
  "tool": "research",
  "action": "search",
  "usedBackend": "web_search",
  "usedFallback": true,
  "warnings": ["academic backend unavailable; used web search instead"],
  "retry": {
    "recommended": true,
    "reason": "backend_unavailable",
    "minimalCall": {
      "query": "recent papers on contextual embeddings",
      "scope": "web",
      "limit": 10
    }
  }
}

2. Read and extraction ergonomics

Purpose: make URL/content ingestion predictable without forcing callers to understand crawler, browser, semantic, and focused-read internals.

Guidelines:

* Prefer url for URL-only fields.
* Use target only when the input may be a URL, raw text, ID, or other locator.
* Treat question as a focused extraction hint.
* Default mode to auto where safe.
* Use depth: "page" by default.
* Escalate to crawl/browser only when the lightweight path fails or the mode explicitly asks for it.

Recommended behavior:

* URL + question → focused extraction first.
* URL with no question → lightweight read first.
* JS-heavy page or extraction failure → browser extraction fallback if configured.
* Site-wide question → semantic crawl or crawl path.
* Raw content + question → focused extraction without network fetch.

This should improve web_read, fetch_focus, semantic_crawl, and browser extraction without requiring a separate discovery layer.

3. Research lifecycle ergonomics

Purpose: reduce lifecycle friction for common research calls without removing explicit job control for advanced clients.

Current issue:

deep_research has an appropriate explicit job protocol for long-running tasks, but many callers want a simple “run this and give me the best available result” path.

Recommended behavior:

* Keep start, poll, list, cancel, and save for clients that want explicit lifecycle control.
* Add a run action or equivalent convenience path on the existing deep_research family if feasible.
* Accept query, depth, timeoutMs, and save.
* Internally start and poll until completion or timeout.
* Return complete output when available.
* Return partial output plus jobId when timeout occurs.
* Treat partial/timeout output as a first-class result, not a hard failure.

Recommended shape:
{
  action: 'run',
  query: string,
  depth?: 'quick' | 'standard' | 'deep',
  timeoutMs?: number,
  save?: boolean,
  options?: {}
}
Partial response metadata:
{
  "tool": "deep_research",
  "action": "run",
  "status": "partial",
  "jobId": "dr_...",
  "usedFallback": false,
  "warnings": ["research did not finish before timeout; returning partial result"],
  "retry": {
    "recommended": true,
    "reason": "timeout",
    "minimalCall": {
      "action": "poll",
      "jobId": "dr_..."
    }
  }
}

4. Inline recovery metadata for high-traffic tools

Purpose: make tool calls easier for clients to repair without adding a separate chooser or discovery surface.

High-traffic tools should return a shared metadata envelope where practical:
{
  "tool": "web_search",
  "action": "search",
  "usedBackend": "web_search",
  "usedFallback": true,
  "warnings": ["primary provider unavailable; used fallback provider"],
  "normalized": {
    "limit": 10,
    "ignoredFields": [],
    "aliases": {
      "maxResults": "limit"
    }
  },
  "retry": {
    "recommended": false
  }
}

For validation failures, return machine-readable errors plus a corrected minimal call:
{

  "error": {

    "code": "invalid_limit",

    "message": "limit must be between 1 and 50",

    "field": "limit"

  },

  "retry": {

    "recommended": true,

    "minimalCall": {

      "query": "MCP streamable HTTP TypeScript implementation",

      "limit": 10

    }

  }

}

Phase 2 — Normalize schema vocabulary across tools

Keep existing names as aliases, but standardize public descriptions, examples, and revised schemas around canonical names.
Concept

Canonical

Aliases to keep

Natural-language query

query

q, search, prompt where currently accepted

Result count

limit

maxResults, maxVideos, maxPosts, topK, commentLimit

URL-only target

url

link, href if currently accepted

General target

target

post, videoId, permalink, source where needed

Repository

repo as owner/name

owner + repo, repository, GitHub URL

Sort

sort

order, sortBy

Time filter

timeframe or since

timespan, dateRange

Language

language

transcriptLanguage

Effort

depth

mode, level, crawlDepth where applicable

Advanced flags

options

existing flat fields during migration

Implementation pattern:

* Add shared Zod helpers for null, empty-string, default, and alias handling.
* Add shared resolver utilities:
    * resolveLimit
    * resolveRepoLocator
    * resolveUrlOrTarget
    * resolveSort
    * resolveLanguage
    * resolveDepth
* Treat empty strings like omitted optional fields.
* Prefer defaulting over failing when a safe default exists.
* Report normalized fields in metadata when useful.
* Advertise canonical fields first in descriptions.
* Mention aliases only as compatibility behavior, not as the primary interface.

Phase 3 — Progressive disclosure for complex families

Browser

Current issue: the browser tool exposes common page capture, extraction, low-level automation, debugging, network inspection, and session control in one large schema.

Recommended move:

* Keep the existing browser family for compatibility.
* Reorganize descriptions and action groups around capability tiers.
* Make common actions smaller and easier to call.
* Keep advanced/debug actions available but visually and semantically separated.

Suggested capability groups:

1. Page capture:
    * navigate
    * snapshot
    * screenshot
    * pdf
    * extract
2. Interaction:
    * click
    * type
    * wait_for
    * paginate
    * scroll_to_load
3. Session/state:
    * session
    * tabs
    * storage
    * network
4. Advanced/debug:
    * network interception
    * dialog handling
    * iframe switching
    * resource timing
    * DOM diffing
    * console/network diagnostics

Do not make browser easier by adding a discovery tool. Make it easier by making the obvious actions obvious, small, and tolerant.

Research

Current issue: the research family has many source actions, so callers need to know source names before getting started.

Recommended move:

* Keep source-specific actions for direct calls.
* Add source: "auto" where feasible inside the existing research search path.
* Use deterministic routing based on query hints and configured backends.
* Return provenance explaining which backends were used, skipped, unavailable, or fallback-selected.
* Normalize result shape across source-specific actions.

Knowledge graph

Current issue: user-facing knowledge workflows and administrative operations are mixed.

Recommended move:

* Keep current family available.
* Improve action names, descriptions, and annotations.
* Treat rebuild, merge, rollback, clear, and migration operations as advanced/admin in descriptions and examples.
* Add ergonomic aliases or action names inside the existing family where feasible:
    * remember → ingest text or URL.
    * recall → query.
    * inspect → explain stored evidence/provenance.
* Add destructive annotations and stronger validation around admin actions.

The goal is not to hide the graph. The goal is to keep simple memory/query workflows separate from maintenance operations.

Semantic crawl

Current issue: semantic_crawl combines fetching, crawling, chunking, embedding, reranking, corpus persistence, and output budgeting into one powerful but heavy surface.

Recommended move:

* Keep advanced controls.
* Make the minimum useful call small:
    * query
    * url or source
    * depth
    * limit
* Move reranking, contextual embeddings, corpus persistence, and byte budgets under options.
* Return clear metadata about:
    * pages fetched
    * chunks produced
    * corpus used/created
    * cache hit/miss
    * embedding fallback
    * reranker fallback
    * output truncation

Prioritized implementation tickets

P0 — Immediate ergonomics fixes

1. Add shared alias/default helpers and apply them to high-traffic fields.
2. Treat empty optional strings as omitted.
3. Normalize common locators:
    * GitHub URLs → owner/name.
    * Reddit URLs → post/comment/subreddit locators.
    * YouTube URLs → video/channel/playlist locators.
4. Add consistent warning/fallback/retry metadata helpers.
5. Add minimal examples to descriptions for:
    * web_search
    * web_read
    * fetch_focus
    * semantic_crawl
    * deep_research
    * research
    * browser
    * github
    * reddit
    * youtube
    * packages

P1 — Ergonomic common paths

1. Add or revise common-case search call shapes with:
    * query
    * scope
    * depth
    * limit
    * options
2. Add or revise common-case read/extract call shapes with:
    * url
    * target
    * question
    * mode
    * depth
    * limit
    * options
3. Add a run convenience action or equivalent lifecycle shortcut for deep_research.
4. Reorganize browser common-case actions around:
    * page capture
    * extraction
    * interaction
    * session/state
    * advanced/debug
5. Add source: "auto" or equivalent auto mode inside the existing research family where feasible.
6. Add shared response metadata helpers for:
    * warnings
    * fallbacks
    * retry hints
    * corrected minimal calls
    * partial result status
    * normalized aliases/defaults

P2 — Schema cleanup and progressive disclosure

1. Move advanced flat fields under options in new or revised common-case surfaces.
2. Keep existing flat fields as compatibility aliases during migration.
3. Add structured output schemas for high-traffic tools and revised common-case actions.
4. Consider splitting browser advanced operations into a separate advanced/admin-visible surface only if client schema quality materially suffers.
5. Mark destructive/admin operations clearly in knowledge_graph and browser state tools.
6. Add result provenance consistency across search, research, crawl, social, GitHub, and packages.

P3 — Measurement and docs

1. Add call-ergonomics eval harness.
2. Add docs/tool-calling-guide.md focused on:
    * minimal calls
    * defaults
    * aliases
    * validation recovery
    * output metadata
    * fallback behavior
    * advanced option escalation
3. Track validation-error telemetry by tool/action/field.
4. Track fallback usage and backend-unavailable cases.
5. Update quickstart to show minimal happy-path calls first, then advanced options.
6. Add examples showing partial success and recovery flows.

Suggested first PR sequence

1. feat(tools): add shared schema normalization helpers

Scope:

* Empty-string handling.
* Alias resolution.
* Defaulting.
* Limit normalization.
* Repo locator normalization.
* URL/target normalization.
* Language normalization.
* Sort/time normalization.

Why first:

This improves existing tools without changing the public tool surface or forcing clients to learn anything new.

2. feat(tools): add shared response metadata helpers

Scope:

* Warnings.
* Fallback status.
* Retry hints.
* Corrected minimal calls.
* Partial result status.
* Normalized aliases/defaults.
* Cache/corpus metadata where relevant.

Why second:

This makes every later change easier to integrate and test.

3. feat(research): add run convenience path for deep_research

Scope:

* Add action: "run" or equivalent.
* Internally start and poll.
* Return final or partial result.
* Preserve explicit job lifecycle actions.

Why third:

deep_research is powerful, but lifecycle friction is one of the clearest usability problems.

4. feat(browser): simplify common browser action shapes

Scope:

* Make page capture/extract/interact paths easier to call.
* Separate common fields from advanced debugging controls.
* Add clearer action descriptions and examples.
* Return consistent fallback/timeout metadata.

Why fourth:

Browser has the heaviest schema and likely the biggest client-inspection cost.

5. feat(research): add source auto mode and backend provenance

Scope:

* Add source: "auto" where feasible.
* Deterministically route to configured backends.
* Return used/skipped backend metadata.
* Keep source-specific actions.

Why fifth:

This improves research ergonomics without creating a separate discovery layer.

6. docs(tools): add tool calling ergonomics guide

Scope:

* Minimal calls.
* Aliases.
* Defaults.
* Validation recovery.
* Fallback behavior.
* Advanced option escalation.
* Partial success handling.

Why sixth:

Docs should reflect the new contract after the primitives exist.

Design guardrails

* Do not remove existing tools/actions until clients have had a migration window.
* Do not hide specialist tools from advanced users.
* Ergonomic paths should coexist with precise specialist controls.
* Prefer improving existing tool/action ergonomics before adding new top-level tools.
* Do not add server-side discovery tools unless they provide runtime capability state or recovery data that clients cannot infer from the MCP tool list.
* Prefer deterministic routing rules first; LLM-based routing can be optional later.
* Every high-level or auto-routed response should disclose:
    * backend used
    * fallback status
    * warnings
    * retry hints
    * partial result status where applicable
* Keep read-only common paths read-only.
* Clearly annotate destructive, stateful, or admin operations.
* Continue returning actionable validation/config errors with suggested corrected calls.
* Do not make the happy path pay the complexity cost of advanced options.
* Prefer compatibility aliases over breaking schema changes.
* Prefer partial success with clear metadata over hard failure when useful output exists.

Non-goals

This plan is not primarily about reducing the number of visible tools.

It is not primarily about adding a tool chooser.

It is not primarily about teaching models which tool to call.

It is not about hiding advanced functionality.

It is about making the tools easier to call once selected, easier to recover from when imperfectly called, and easier for multiple MCP clients to integrate consistently.

Success criteria

The plan is successful if:

* A minimal natural call succeeds more often.
* Common alias guesses work.
* Advanced options are still available but no longer dominate the happy path.
* Fewer calls fail validation.
* Validation failures include corrected minimal calls.
* Backend fallback produces usable output instead of opaque failure.
* deep_research can be used without manually managing jobs.
* Browser common actions are easier to inspect and call.
* Research source routing is easier without removing direct source control.
* Client integrations need less bespoke retry/recovery logic.