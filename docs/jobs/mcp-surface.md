# Jobs MCP surface (live)

Current product surface over `executeJobsSearch` seam. Legacy semantic jobs surface is removed; no compatibility wrapper is registered.

## Tools

| Tool          | Kind              | Actions                                     | Behavior                                                                                                                                                                                                                                                                      |
| ------------- | ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs_search` | standalone        | — (single search)                           | Full seam run: indexed providers plus JobSpy only when explicitly enabled with independently reviewed policy evidence; default board set is empty. `sydney:true` opts in to versioned Sydney/NSW packs; default is assumption-free generic core.                              |
| `jobs`        | family (`action`) | `search`, `capabilities`, `describe_action` | Composable form of the same runtime. `search` mirrors `jobs_search` (single location string). `capabilities` returns action cards with availability/remediation. `describe_action` returns one strict schema, effects, limits, examples. Unknown actions → actionable errors. |

## Guarantees (live, tested)

- Policy-gated acquisition: SEEK direct search/fetch blocked; indexed
  SEEK views remain provider-attributed and caveated.
- ATS tenants and destination fetch flow only through
  policy/registry authorization against configured tenants — never
  arbitrary caller hosts.
- Sydney packs (`au-nsw-sydney` 1.0.0, `nsw-public-admin` 1.0.0) apply
  only when explicitly selected; generic core asserts no AU defaults.
- No-provider/degraded state returns actionable
  `capability-unavailable` errors (missing backend + JobSpy disabled),
  never stubs or silent empty results.
- Profile input is request-scoped and never persisted.
- `D.mcp_progressive` evidence: compact action + bounded request per
  registered action. `D.retention_encryption` remains deferred/blocked; legacy cutover remains blocked
  per ADR-019 (durable sensitive persistence stays off).

## Non-goals (not in this checkpoint)

Durable sensitive-profile persistence and standalone legacy comparison benchmarks.
