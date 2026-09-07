# Wave 3 acquisition closure evidence (W3-J)

**Status:** Offline closure evidence for the closed W3-A..I packages, produced by the frozen W3-J contract. Every claim below is backed by source in this repository plus the recorded command results at the time of closure. No live-network evaluation was performed.

## Scope

W3-J adds only:

- `test/jobs/w3jAcquisitionClosure.test.ts` — single table-driven offline cross-package closure suite (14 aggregate cases, injected policy/capability registries, indexed ports, JobSpy functions, and safe fetch; no network, keys, environment reads, disk, timers, or persistence).
- This evidence document.
- Evidence-link additions (one sentence each) to `docs/jobs/indexed-discovery-amendment.md`, `docs/jobs/implementation-graph.md`, and `docs/jobs/architecture.md`.

W3-J implements no runtime code. The closed packages it evidences are unchanged by W3-J except for one supervisor-authorized, formatting-only exception recorded under [Command matrix](#command-matrix).

## Closed packages and exact versions

| Package                           | Implemented files (source / test)                                                                                            | Version constant                       | Value   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------- |
| W3-A contracts                    | `src/jobs/acquisition/contracts.ts`, `src/jobs/acquisition/ids.ts` / `test/jobs/acquisitionContracts.test.ts`                | `ACQUISITION_CONTRACT_VERSION`         | `1.0.0` |
| Shared IDs/URL support            | `src/jobs/acquisition/adapterSupport.ts` / `test/jobs/acquisitionAdapterSupport.test.ts`                                     | `ACQUISITION_ADAPTER_SUPPORT_VERSION`  | `1.0.0` |
| W3-B edge policy coordinator      | `src/jobs/acquisition/policy/*` / `test/jobs/edgePolicyCoordinator.test.ts`, `test/jobs/sourcePolicy.test.ts`                | `SOURCE_POLICY_VERSION`                | `0.1.0` |
| W3-C adapter registry             | `src/jobs/acquisition/adapterRegistry.ts`, `src/jobs/acquisition/adapterCapability.ts` / `test/jobs/adapterRegistry.test.ts` | `ADAPTER_CAPABILITY_CONTRACT_VERSION`  | `1.0.0` |
| W3-D indexed providers            | `src/jobs/acquisition/providers/*` / `test/jobs/indexedProviderAdapter.test.ts`                                              | `INDEXED_PROVIDER_ADAPTER_VERSION`     | `1.0.0` |
| W3-E JobSpy adapter               | `src/jobs/acquisition/adapters/jobspy.ts` / `test/jobs/jobspyAdapter.test.ts`                                                | `JOBSPY_ADAPTER_VERSION`               | `1.7.0` |
| W3-F manual import                | `src/jobs/acquisition/adapters/manualImport.ts` / `test/jobs/manualImportAdapter.test.ts`                                    | `MANUAL_IMPORT_ADAPTER_VERSION`        | `1.0.0` |
| W3-G additive coordinator         | `src/jobs/acquisition/coordinator.ts` / `test/jobs/acquisitionCoordinator.test.ts`                                           | `ACQUISITION_COORDINATOR_VERSION`      | `1.0.0` |
| W3-H destination fetch enrichment | `src/jobs/acquisition/destinationFetch.ts` / `test/jobs/destinationFetchEnrichment.test.ts`                                  | `DESTINATION_FETCH_ENRICHMENT_VERSION` | `1.0.0` |
| W3-I semantic_jobs shadow         | `src/jobs/compat/semanticJobsShadow.ts` / `test/jobs/semanticJobsShadow.test.ts`                                             | `SEMANTIC_JOBS_SHADOW_VERSION`         | `1.0.0` |
| W3-J closure evidence (this doc)  | `test/jobs/w3jAcquisitionClosure.test.ts`                                                                                    | —                                      | —       |

W3-H additive exports are registered in `src/jobs/acquisition/index.ts` with smoke checks in `test/jobs/acquisitionExports.test.ts`. W3-I is intentionally not exported through the acquisition barrel; it is imported directly by module path.

## Command matrix (frozen W3-J contract, recorded results)

| Command                                                                                                                                                                                                                                                                                                                                                                                                | Result                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `npm test -- test/jobs/destinationFetchEnrichment.test.ts`                                                                                                                                                                                                                                                                                                                                             | pass — 42 tests, 0 failures                      |
| `npm test -- test/jobs/semanticJobsShadow.test.ts`                                                                                                                                                                                                                                                                                                                                                     | pass — 16 tests, 0 failures                      |
| `npm test -- test/jobs/w3jAcquisitionClosure.test.ts`                                                                                                                                                                                                                                                                                                                                                  | pass — 14 tests, 0 failures                      |
| `npm test -- test/jobs/acquisitionContracts.test.ts test/jobs/acquisitionAdapterSupport.test.ts test/jobs/edgePolicyCoordinator.test.ts test/jobs/sourcePolicy.test.ts test/jobs/adapterRegistry.test.ts test/jobs/indexedProviderAdapter.test.ts test/jobs/jobspyAdapter.test.ts test/jobs/manualImportAdapter.test.ts test/jobs/acquisitionCoordinator.test.ts test/jobs/acquisitionExports.test.ts` | pass — 313 tests, 0 failures                     |
| `npm run typecheck`                                                                                                                                                                                                                                                                                                                                                                                    | pass — production and test projects, exit 0      |
| `npm run lint`                                                                                                                                                                                                                                                                                                                                                                                         | pass — `eslint src`, exit 0                      |
| `npx prettier --check src/jobs test/jobs docs/jobs`                                                                                                                                                                                                                                                                                                                                                    | pass — all matched files use Prettier code style |
| `git diff --check`                                                                                                                                                                                                                                                                                                                                                                                     | pass — exit 0                                    |

**Supervisor-authorized formatting-only exception.** The exact `npx prettier --check src/jobs test/jobs docs/jobs` command initially failed on two pre-existing files outside the frozen W3-J ownership set: `test/jobs/acquisitionContracts.test.ts` and `test/jobs/domain.test.ts` (over-long single-line object literals; violations predate W3-J and W3-J never modified those files). The supervisor authorized a narrow formatting-only exception: `npx prettier --write` on exactly those two files. Behavior was verified unchanged — both files pass 124/124 tests before and after formatting, with zero content or assertion changes. No other file outside W3-J ownership was touched.

`scripts/eval-retrieval.ts` and live `runLiveEval` were not run, per the frozen contract.

## P0/P1 closure mapping (amendment closure matrix → W3-J test names)

W3-J test names are `W3-J <n>. <name>` in `test/jobs/w3jAcquisitionClosure.test.ts`.

| Priority | Required evidence (docs/jobs/indexed-discovery-amendment.md closure matrix)                                                 | W3-J evidence test names                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Blocked direct publisher search/fetch causes zero direct calls.                                                             | `W3-J 2. exact blocked SEEK direct search/fetch causes zero direct calls`; `W3-J 9. W3-H blocked destination edge causes zero safeFetch`                                             |
| P0       | Provider authorization cannot grant direct publisher access; credentials never cross into destination requests.             | `W3-J 1. provider permission remains separate from publisher search/fetch`; `W3-J 10. W3-H permitted destination call carries no credentials and creates valid destination evidence` |
| P1       | Permitted third-party indexed candidates survive blocked publisher access and remain visibly caveated.                      | `W3-J 3. permitted indexed SEEK candidate survives as caveated indexed_only`                                                                                                         |
| P1       | Provider and publisher states are separate; publisher decisions during admission are informational, not authorizing.        | `W3-J 1. provider permission remains separate from publisher search/fetch`; `W3-J 5. informational edge never authorizes execution`                                                  |
| P1       | Discoverer/publisher/content donor stay distinct; provider summaries/snippets never become publisher facts.                 | `W3-J 4. indexed-only candidate has zero observation envelopes`; `W3-J 10. W3-H permitted destination call carries no credentials and creates valid destination evidence`            |
| P1       | Indexed-only candidates create no observation or observed claim; upgrade requires separate destination or manual evidence.  | `W3-J 4. indexed-only candidate has zero observation envelopes`; `W3-J 10. W3-H permitted destination call carries no credentials and creates valid destination evidence`            |
| P1       | Exact direct-source block overrides direct-family permission; composite calls require each concrete provider authorization. | `W3-J 2. exact blocked SEEK direct search/fetch causes zero direct calls`; `W3-J 1. provider permission remains separate from publisher search/fetch`                                |
| P1       | SEEK indexed candidates survive while direct SEEK search/fetch remain zero-call.                                            | `W3-J 2. exact blocked SEEK direct search/fetch causes zero direct calls`; `W3-J 3. permitted indexed SEEK candidate survives as caveated indexed_only`                              |
| P1       | Wave 2A zero persistence / no reusable profile handle.                                                                      | Out of W3-J scope; covered by the W2A package suites and the amendment's non-claim on implementation.                                                                                |
| P1       | Wave 2B, persistence, and `query_log` gates remain closed.                                                                  | Recorded below as residual gates; no test claims them open or closed by implementation.                                                                                              |

The remaining frozen W3-J aggregate cases map one-to-one to their names: W3-G budget skipping, failure isolation, and annotation-only dedup (`W3-J 7`); W3-F `destination_fetch_required` review-only in W3-G (`W3-J 8`); W3-H refusals of publisher-less and manual URL candidates (`W3-J 11`); W3-I one legacy multi-site call, aggregate-only, non-persistent, no cutover (`W3-J 12`); H/I abort and work budgets bounded (`W3-J 13`); full H and I outputs passing exported schemas (`W3-J 14`); fail-closed unknown policy (`W3-J 6`).

## Additive compatibility and no cutover

- No MCP tool, server, barrel (outside the explicit W3-H acquisition exports), or tool schema was changed by W3-H, W3-I, or W3-J. `src/tools/semanticJobs.ts`, standalone registration, `src/server.ts`, and MCP schemas were not modified by these packages.
- W3-H exports are additive re-exports in `src/jobs/acquisition/index.ts`; `ACQUISITION_CONTRACT_VERSION` remains `1.0.0` with no schema version change.
- W3-I is a read-only shadow comparison (`src/jobs/compat/semanticJobsShadow.ts`): exactly one legacy multi-site `searchJobSpy` call plus one coordinator run per invocation; it returns aggregate counts only and performs no cutover, dual-write, or flag flip.
- W3-J adds tests and documentation only; no runtime behavior changes.

## Zero persistence and zero `query_log` writes

- The W3-J suite injects every dependency (registries, ports, JobSpy functions, safe fetch, clocks); it performs no disk access, no network access, and no persistence of any kind.
- W3-H and W3-I modules import no persistence, graph DB, SQLite, corpus cache, logger, or `query_log` modules; this is enforced by import-boundary tests (`destinationFetchEnrichment.test.ts` import-boundary test; `semanticJobsShadow.test.ts` static-import allowlist test) and the coordinator import-allowlist test in `acquisitionCoordinator.test.ts`.
- W3-H writes nothing: enrichment results are returned in memory and the input run object is not mutated (asserted in the W3-H suite and exercised in the W3-J suite).
- No test in the recorded command matrix writes to any database, cache, or log sink.

## Non-claims

1. No provider terms or legal compliance conclusion is made or implied.
2. No freshness guarantee for indexed candidates, destination captures, or shadow comparisons.
3. No hostname-derived publisher identity: publisher identity is only the configured registry entry (for example `board:seek`); no policy or code path synthesizes a publisher from a hostname.
4. No default SEEK policy installation: the frozen default SEEK policy (`automatedSearch: blocked`, `automatedFetch: blocked`) is a test fixture, not installed into any production registry or composition root.
5. No JobSpy internal-request `safeFetch` claim: JobSpy board scraping goes through the injected `scrapeJobs` sidecar path; `safeFetch` is exercised only by W3-H destination fetches.
6. No production persistence readiness: persistence, encryption, and retention remain gated (see residual gates).
7. No Wave 12 retrieval-quality evaluation: `scripts/eval-retrieval.ts`, the golden-query harness, and any retrieval scoring were not run.
8. No live-network evaluation: every recorded command runs offline with injected dependencies; no external service was contacted.
9. No manual URL destination fetching: W3-F manual URL handoffs remain review-only (`unsupported_v1_manual_handoff` in W3-H, zero HTTP), proven by `W3-J 8`.
10. No full Wave 3 roadmap completion beyond W3-A..I package evidence: this document evidences only the W3-A..I packages plus W3-J tests/docs; later waves (extraction/enrichment over destination text, production wiring, persistence, retrieval integration) are not claimed.

## Residual gates and known risks

Gates that remain closed (unchanged by W3-A..J):

- Production persistence (Wave 7), packet persistence (Wave 10), and debug persistence (Wave 12) remain gated.
- W2B profile persistence remains blocked by the encryption and retention ADRs.
- `query_log` retention/data-minimization decisions remain gated.
- Public compatibility cutover and mandatory dual-write remain out of scope; nothing in W3-H/I/J flips a flag or migrates traffic.
- ATS tenant authorization remains a future, separately authorized target kind; the destination-fetch capability declares the edge but no production composition root registers the `destination-fetch` capability yet (explicit later wiring required).

Known risks carried from the frozen contract:

- `safeFetch` transport deadlines use internal `Date.now`; the W3-H injected monotonic clock does not control the transport deadline.
- The legacy JobSpy wrapper can collapse upstream failures into empty result arrays, limiting shadow failure attribution.
- W3-H raw textual destination capture is evidence, not extraction; HTML semantics remain future work.
- Strict final-host equality in W3-H rejects legitimate cross-host redirects; a safe, reversible default.
- W3-G duplicate annotations are recomputed after W3-H state upgrades (asserted by `W3-J 7` and the W3-H suite); ranking mirrors the frozen W3-G ordering.
