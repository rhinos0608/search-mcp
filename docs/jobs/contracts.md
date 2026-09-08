# Jobs Wave 0 contracts

## Safe fetch contract

`safeFetch(url, init, options)` returns `{ finalUrl, status, statusText, headers, body, redirectCount }`. It is a bounded `GET`/`HEAD` fetch primitive, not a general HTTP client.

Guarantees:

- URL credentials rejected.
- URL and DNS answers checked on every redirect hop.
- Public mode rejects private/reserved and mixed DNS answers.
- Requests use validated DNS address; redirects are bounded (default 5).
- Deadline defaults to 30 seconds and is shared across hops.
- Response body is bounded (`maxBytes`, default `MAX_RESPONSE_BYTES`); encoded responses are rejected.
- Cross-origin redirects retain only safe headers.
- Caller abort propagates as a bounded failure.

`operator_internal` is allowed only for operator-configured hostnames in `internalAllowlist`. It is not user permission. Browser/CDP, Crawl4AI, embedding, and JobSpy traffic are outside this contract.

## Portable parser contract

`runDocumentParser('pdf' | 'office', data, ext, limits, signal)` launches disposable parser child process and bounds input, output, timeout, abort, protocol, and returned document envelope. Promise settlement occurs only after child `close`; spawn errors therefore have bounded, close-confirmed rejection. Exact capability declaration:

| Field              | Value          |
| ------------------ | -------------- |
| `processIsolation` | `enforced`     |
| `networkIsolation` | `not_enforced` |
| `memoryIsolation`  | `v8_heap_only` |

`v8_heap_only` means `--max-old-space-size=256` is passed where supported. It does not cap native allocations. No OS sandbox, network denial, or native-memory isolation is claimed. Binary profile parsing stays disabled by default pending Wave 2 hardening.

## Source policy contract

Policy modes: `automatedSearch`, `automatedFetch`, `userSuppliedContent`, `manualImport`, `employerApi`.

Policy states: `permitted`, `blocked`, `requires_configuration`, `requires_review`, `not_supported`.

Unknown sources/modes resolve to `not_supported`; non-`permitted` decisions do not invoke the supplied operation. Policy snapshots and decisions preserve revision, evidence references, review date, and optional notes. Source policy is independent from adapter capability.

JobSpy direct acquisition is in-process behind injected `scrapeJobs`; default boards are empty and execution requires independently reviewed policy evidence. Python sidecar is removed.

## Process telemetry privacy boundary

Process logs and traces exclude raw query text, query hashes, URLs, paths, identifiers, and raw error payloads. They may contain bounded counts, lengths, booleans, status codes, fixed stage/source/action values, trust tiers, and stable error codes. User-visible results, warnings, structured warnings, and provenance are API/product output and remain outside this logging guarantee.

Local corpus `query_log` is a separate persistence path: it stores raw query text plus its hash and is explicitly outside the Wave 0 process-telemetry guarantee. This named privacy and retention risk must be gated by a retention/data-minimization decision before broader production persistence.

## Deployment contract

Deployment, not portable Node code, must provide:

- `egress_denied` parser/profile worker default, with narrow explicit exceptions;
- CPU and wall-clock limits;
- native/container memory, process, and file-descriptor limits;
- narrow read-only filesystem mounts and no broad `$HOME` mount;
- separate principals for server, browser, Crawl4AI, and embedding sidecars;
- negative tests proving blocked egress, resource termination, filesystem traversal/symlink rejection, and oversized parser input/output.

Browser and Crawl4AI are separate principals and separate network boundaries. `safeFetch` semantics do not cover them.

## Wave 0 evidence matrix

Commands below are exact focused checks. `npm test -- ...` compiles source/tests in a temporary output directory before running Node tests.

| Command                                                                                                                                     | Coverage                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test -- test/httpGuards.safeFetch.test.ts test/safeFetchCallers.test.ts test/wave0Safety.test.ts`                                      | safe-fetch methods, DNS/redirect/deadline/size/header controls, caller inventory, Wave 0 safety integration                                      |
| `npm test -- test/documentParsers/boundary.test.ts`                                                                                         | child-process launch, pre-abort, timeout, abort, output overflow, UTF-8 cap, JSON/image envelope cap, malformed protocol, exact capability tuple |
| `npm test -- test/jobs/sourcePolicy.test.ts`                                                                                                | policy clone/freeze, immutable decisions, fail-closed unknowns, zero calls for blocked decision                                                  |
| `npm run typecheck`                                                                                                                         | TypeScript production and test type safety                                                                                                       |
| `npm test -- test/jobTelemetryPrivacy.test.ts test/spiderTelemetryPrivacy.test.ts test/semanticCrawl.test.ts test/safeFetchCallers.test.ts` | process telemetry privacy, semantic-crawl behavior, and safe-fetch caller inventory                                                              |
| `npx prettier --check docs/jobs`                                                                                                            | documentation formatting                                                                                                                         |
| `git diff --check`                                                                                                                          | whitespace and patch integrity                                                                                                                   |

These tests do not prove OS sandboxing, deployment egress denial, browser isolation, Crawl4AI isolation, or native-memory limits. Those require deployment-level negative tests.
