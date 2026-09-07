# Wave 0 review evidence

**Scope:** Implementation truth at Wave 0 close. Complements `security-boundaries.md`, `threat-model.md`, and `contracts.md`.

## safeFetch guarantees (pinned)

- Method: `GET`/`HEAD` only.
- URL credentials rejected; `assertSafeUrl` checks scheme and blocked hostnames per hop.
- DNS re-resolution every redirect; `reserved: mixed answers` rejected; private/reserved/multicast/unspecified rejected for `public` policy.
- `operator_internal` requires `internalAllowlist` exact hostname match; still rejects unspecified/link-local/multicast addresses.
- Validates resolver answer family matches `net.isIP(address)`.
- Pins transport via `lookup` override; `Host`/`servername` preserve original hostname; `lookup` pins selected address.
- Deadline shared across hops; abort propagated via bounded wrapper; body cap enforced after transport.
- Redirects bounded (default 5); cross-origin strips to `accept`, `accept-language`, `cache-control`, `user-agent`; `accept-encoding: identity` re-applied each hop; encoded responses rejected.

## Covered callers

`src/crawl/spiders.ts`, `src/tools/families/agenticBrowse.ts`, `src/tools/semanticCrawl.ts`, `src/tools/standalone/rss.ts`, `src/tools/webRead.ts`, `src/tools/webSearchDocEnrich.ts`, `src/utils/documentExtraction.ts`, `src/utils/externalRecovery.ts`.

## Excluded principals

Browser/CDP, Crawl4AI, embedding sidecar, JobSpy sidecar are separate network principals. Not covered by `safeFetch`.

## Parser capability (exact values)

| Field              | Value          |
| ------------------ | -------------- |
| `processIsolation` | `enforced`     |
| `networkIsolation` | `not_enforced` |
| `memoryIsolation`  | `v8_heap_only` |

Portable guarantees: disposable child, `--max-old-space-size=256` in both runners, timeout/abort, input/output caps, UTF-8-safe truncation, bounded JSON/image envelope, malformed-protocol rejection. Promise settlement occurs only after child `close`, including bounded spawn-error rejection. No OS sandbox, no network denial, no native-memory cap.

## Process telemetry privacy

Process logs and traces exclude raw query text, hashes, URLs, paths, identifiers, and error payloads. User-visible results, warnings, structured warnings, and provenance remain outside this logging guarantee. Local corpus `query_log` persists raw query text plus its hash and is explicitly outside Wave 0; this named privacy/retention risk requires a gate before broader production persistence.

## Binary profile parsing

Disabled by default; Wave 2 hardening required.

## Deployment sandbox (required, not provided by app)

- `egress_denied` default for parser/profile workers; explicit operator exceptions only.
- CPU/wall-clock limits; native/container memory, process, fd limits.
- Read-only minimal filesystem mounts; no broad `$HOME`; dedicated browser and dedicated Crawl4AI principals.
- Negative tests: blocked egress, CPU timeout, native-memory limit, traversal/symlink escape, oversized input/output, child termination.

## Source policy (skeleton)

`SourcePolicyRegistry` clones/freezes ingress/egress, preserves `revision`/`evidenceRefs`/`reviewedAt`/`notes`, returns `not_supported` for unknown source/mode, `runIfPermitted` invokes zero operations for blocked/non-permitted. Not wired to legacy JobSpy coordinator; Wave 3 owns coordination. No policy defaults injected into JobSpy.

## Test evidence matrix (exact commands)

| Command                                                                                                                                     | Coverage                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- test/httpGuards.safeFetch.test.ts test/safeFetchCallers.test.ts test/wave0Safety.test.ts`                                      | safe-fetch encodings/DNS/redirect/deadline/size/header controls, caller inventory, Wave 0 safety integration                                               |
| `npm test -- test/documentParsers/boundary.test.ts`                                                                                         | child launch, pre-abort, timeout, abort, overflow, UTF-8 cap, JSON/image envelope cap, malformed protocol, spawn error after close, exact capability tuple |
| `npm test -- test/jobs/sourcePolicy.test.ts`                                                                                                | clone/freeze, immutable decisions, fail-closed unknowns, zero calls for blocked decision                                                                   |
| `npm test -- test/jobs/compat.test.ts`                                                                                                      | legacy mapper additive projection, provenance/loss reporting, stable identity                                                                              |
| `npm test -- test/jobTelemetryPrivacy.test.ts test/spiderTelemetryPrivacy.test.ts test/semanticCrawl.test.ts test/safeFetchCallers.test.ts` | process telemetry privacy, semantic-crawl behavior, and safe-fetch caller inventory                                                                        |
| `npm run typecheck`                                                                                                                         | TypeScript safety                                                                                                                                          |
| `npx prettier --check docs/jobs`                                                                                                            | docs formatting                                                                                                                                            |
| `git diff --check`                                                                                                                          | whitespace                                                                                                                                                 |

Tests do not prove OS sandboxing, deployment egress, browser/Crawl4AI isolation, or native-memory limits.

## Residual risks

| Risk                           | Owner                | Gate                               |
| ------------------------------ | -------------------- | ---------------------------------- |
| Parser native memory/network   | Deployment / Wave 2  | container limits + hardened parser |
| Browser/Crawl4AI escape/egress | Deployment/security  | separate principals                |
| Profile encryption/retention   | Jobs architecture    | ADR settlement                     |
| Source policy wiring to legacy | Acquisition / Wave 3 | coordinator                        |
