# Jobs security boundaries

**Status:** Wave 0 implementation truth. This document describes controls present in this repository and controls required from deployment; it does not imply an OS sandbox that the application does not provide.

## Network fetch boundary

All model- or caller-selected HTTP fetches in the covered TypeScript paths use `safeFetch` or an injected safe-fetch-compatible function. Current direct callers are:

- `src/crawl/spiders.ts` (sitemap fetches)
- `src/tools/families/agenticBrowse.ts` (page fetch)
- `src/tools/semanticCrawl.ts` (sitemap fetches)
- `src/tools/standalone/rss.ts` (feed fetches)
- `src/tools/webRead.ts` (readability fetch)
- `src/tools/webSearchDocEnrich.ts` (doc enrichment fetch)
- `src/utils/documentExtraction.ts` (HTML and document bytes)
- `src/utils/externalRecovery.ts` (Wayback and Google Cache recovery)

`safeFetch` accepts only `GET` and `HEAD`. It validates URL and DNS answers on every redirect hop, rejects private/reserved or mixed DNS answers for public requests, rejects URL credentials, caps redirects (default 5), enforces one deadline (default 30 seconds), caps response bytes (default `MAX_RESPONSE_BYTES`), requires identity encoding, and strips sensitive headers on cross-origin redirects. It pins each request to the validated DNS address. `operator_internal` is an explicit operator-configured exception: endpoint hostname must be in `internalAllowlist`; this is not caller permission and is not a public-network bypass.

`safeFetch` does not provide content trust, malware scanning, browser isolation, process isolation, or egress control outside requests routed through it. Raw native `fetch` is prohibited by the caller regression test, but operator sidecars and browser/Crawl4AI processes remain separate boundaries described below.

## Process telemetry boundary

Process logs and traces exclude raw query text, hashes, URLs, paths, identifiers, and error payloads. User-visible results, warnings, structured warnings, and provenance are outside this logging guarantee. Local corpus `query_log` persists raw query text plus its hash through a separate SQLite path; it is outside the Wave 0 guarantee. This named privacy/retention risk requires a retention/data-minimization gate before broader production persistence.

## Parser boundary

Portable PDF and Office parsing runs in a disposable child process with timeout, abort, input-size, output-size, protocol, and bounded JSON/image-envelope checks. Promise settlement occurs only after child `close`, including bounded spawn-error rejection. Capability is pinned by `parserCapability`:

| Capability         | Actual guarantee                                                                  |
| ------------------ | --------------------------------------------------------------------------------- |
| `processIsolation` | `enforced` — parser runs in child process                                         |
| `networkIsolation` | `not_enforced` — application does not claim network denial                        |
| `memoryIsolation`  | `v8_heap_only` — V8 heap cap is passed; native memory is not independently capped |

This is not an OS sandbox. Child-process termination is a resource and failure boundary, not a guarantee against native-library escape or host access. Binary profile parsing remains disabled by default until a hardened capability exists in Wave 2. Do not describe portable parser execution as network-isolated or native-memory-isolated.

## Deployment boundary

Deployment must supply controls absent from portable application code:

- run server, browser automation, Crawl4AI, and embedding integrations as separate principals/containers where possible; in-process jobspy-js shares the server process and is governed by SourcePolicy and adapter controls;
- deny egress by default (`egress_denied`) for parser/profile workers, then allow only required operator endpoints;
- apply CPU and wall-clock limits, native-memory/container memory limits, process and file-descriptor limits;
- mount only required filesystem paths read-only where possible; keep profiles and credentials outside the server's default `$HOME` capability;
- use a dedicated browser principal and dedicated Crawl4AI principal; do not run either with server credentials or unrestricted host mounts;
- test negative cases: blocked egress, CPU timeout, native-memory limit, filesystem traversal/symlink escape, oversized input/output, and parser termination.

These are deployment requirements, not claims that Node.js currently enforces them. Browser and Crawl4AI network behavior must not be inferred from `safeFetch`; each has its own principal and sidecar policy.

## Residual risks and owners

| Risk                                    | Current position                                                                               | Owner / settlement                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Parser native memory and network access | Not isolated by application                                                                    | Deployment owner; hardened parser capability in Wave 2 |
| Browser or Crawl4AI escape/egress       | Separate process boundary required; not covered by `safeFetch`                                 | Deployment/security owner                              |
| Profile encryption and retention        | Mechanism and values unresolved                                                                | Jobs architecture owner; encryption/retention ADR      |
| JobSpy third-party client cancellation  | `jobspy-js` receives composed AbortSignal where supported; client compliance is not guaranteed | Acquisition owner; monitor upstream behavior           |
| Historical acquisition paths            | Deleted Python JobSpy sidecar and legacy RAG JobSpy modules are not runtime paths              | Documentation/archive only                             |
