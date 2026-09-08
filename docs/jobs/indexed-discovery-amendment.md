# Indexed discovery and edge-scoped policy amendment

**Status:** Approved architecture amendment. Wave 3 and bounded, non-persistent Wave 2A authorized. This document records contracts and closure requirements; it does not claim implementation.

## Governing rule

Source policy binds a specific acquisition edge: **actor, operation, route, target**. It binds neither an information object nor an evidence object. Evidence carries provenance. Restrictions do not propagate merely because evidence mentions a restricted publisher.

Legal, confidentiality, or safety handling may propagate only through a separate explicit handling classification with cited basis. No such subsystem is invented in these packages.

## Three identities

- **Discoverer:** provider or adapter reporting a URL or candidate (for example `search-provider:exa`).
- **Publisher:** authority responsible for listing (for example `board:seek`, `publisher-host:...`, configured ATS tenant).
- **Content donor:** provider of current representation (indexed snippet, provider summary, destination fetch, adapter record, or user content).

Never collapse these into one `source` field. Snippets and summaries are donor evidence, not publisher facts.

## Indexed discovery contract

An independently authorized provider search may produce a candidate with provider-attributed indexed evidence. Provider authorization is sufficient for indexed candidate admission when query handling, result retention, bounded representation, and provider attribution are permitted. Publisher direct-access state is recorded separately and is informational during admission.

Candidate states:

```text
indexed_only | fetch_eligible | destination_fetched | adapter_acquired | manual_content
```

Provenance variants (discriminated by `kind`): `indexed_discovery` (indexed_only/fetch_eligible/destination_fetched), `direct_adapter` (adapter_acquired), `manual_content` (manual_content). Indexed provenance carries `discoverers[]` + provider donor + mandatory destination; direct adapter carries single `discoverer` (adapterId/operation) + adapter donor + required publisher + optional destination (all-or-valid); manual carries user donor + optional publisher/destination (all-or-valid). State-local refs and envelope `acquisition` are discriminated by `captureKind` (destination_fetch/adapter_listing/manual_content); no synthetic provider `discovererProviderIds`.

`policy_blocked` is not a candidate state: blocked provider calls produce no candidates. `indexed_only` requires indexed snippet, provider metadata, or URL-attributable provider-generated summary. It cannot create `SourceObservation` or publisher-observed claims. Provider publication dates remain hints. Tavily query-level answers are excluded; per-result summaries remain provider-generated evidence and require URL attribution.

Candidate access coverage distinguishes:

```text
indexedDiscovery: permitted
 directSearch: SourcePolicyState
 destinationFetch: SourcePolicyState
```

Provider calls use `automatedSearch` on the provider target. Direct board search and destination fetch each resolve their own edge. Provider permission never grants destination permission. Blocked/unknown direct edges preserve valid indexed candidates, mark caveats such as `provider_index_only`, `publisher_not_fetched`, `direct_search_blocked`, `destination_fetch_blocked`, or `stale_index_possible`, and make zero direct calls.

## SEEK rule

Default direct SEEK policy remains:

```text
automatedSearch: blocked
automatedFetch: blocked
userSuppliedContent: permitted
manualImport: permitted
employerApi: not_supported
```

Thus permitted Exa/Tavily indexed discovery may return a SEEK-targeted candidate, retained as `indexed_only` with caveats. Direct SEEK adapter search and destination fetch remain forbidden and zero-call. URL-only manual import returns `content_required` when destination fetch is blocked; inline/file user content remains supported and unverified.

## Wave authorization and preserved gates

W3 acquisition contracts, edge policy coordination, indexed adapters, JobSpy/manual import, additive scheduling, and destination enrichment are authorized. W2A profile contracts, trusted-root reader, minimizer, and request-scoped non-persistent orchestration may proceed concurrently. W2B profile persistence remains blocked by encryption and retention ADRs. Production persistence, packet/debug persistence, and `query_log` retention/data-minimization decisions remain gated. No public compatibility cutover or mandatory dual-write is implied.

## Exact dependency matrix

| Package                                         | Dependencies       | Closure output                                        |
| ----------------------------------------------- | ------------------ | ----------------------------------------------------- |
| W3-A contracts                                  | W0, W1             | versioned acquisition/provenance contracts            |
| W3-B policy coordinator                         | W3-A, SourcePolicy | edge decisions; zero-call direct gating               |
| W3-C adapter registry                           | W3-A               | deterministic capability lookup                       |
| W3-D indexed providers                          | W3-A–C             | bounded provider-attributed candidates                |
| W3-E JobSpy                                     | W3-A–C             | explicit-board structured acquisition                 |
| W3-F manual import                              | W3-A, W3-B         | zero-network content import unless fetch edge permits |
| W3-G additive coordinator                       | W3-B–F             | independent slices, budgets, failure isolation        |
| W3-H destination fetch                          | W3-G, safeFetch    | separately captured destination evidence              |
| W3-I semantic_jobs shadow (historical; deleted) | W3-G               | superseded comparison evidence; no live path          |
| W3-J evaluation/docs                            | W3-G–I             | offline closure evidence                              |
| W2A-P1 contracts                                | W0, W1             | minimized request input                               |
| W2A-P2/P3 reader/minimizer                      | W2A-P1             | bounded in-memory profile data                        |
| W2A-P4 service                                  | W2A-P1–P3          | request-scoped orchestration; zero persistence        |

## Closure matrix

| Priority | Required evidence                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| P0       | Blocked direct publisher search/fetch causes zero direct calls.                                                             |
| P0       | Provider authorization cannot grant direct publisher access; credentials never cross into destination requests.             |
| P1       | Permitted third-party indexed candidates survive blocked publisher access and remain visibly caveated.                      |
| P1       | Provider and publisher states are separate; publisher decisions during admission are informational, not authorizing.        |
| P1       | Discoverer/publisher/content donor stay distinct; provider summaries/snippets never become publisher facts.                 |
| P1       | Indexed-only candidates create no observation or observed claim; upgrade requires separate destination or manual evidence.  |
| P1       | Exact direct-source block overrides direct-family permission; composite calls require each concrete provider authorization. |
| P1       | SEEK indexed candidates survive while direct SEEK search/fetch remain zero-call.                                            |
| P1       | Wave 2A has zero persistence and no reusable profile handle; W2B/persistence/`query_log` gates remain closed.               |

## Non-claims

This amendment does not claim implementation, provider terms compliance beyond recorded policy evidence, freshness, publisher identity from hostname alone, or a legal/confidentiality/safety classification system.

See [ADR-011](adr/ADR-011-source-policy.md), [ADR-012](adr/ADR-012-seek-manual-import.md), [source coverage](source-coverage.md), and [implementation graph](implementation-graph.md).

Implementation and offline closure evidence: [Wave 3 acquisition closure evidence](wave-3-acquisition-closure-evidence.md).
