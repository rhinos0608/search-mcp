# Jobs threat model

**Scope:** Wave 0 safety controls around URL acquisition, document parsing, browser/sidecar boundaries, and source-policy scaffolding. This is not evidence of an OS sandbox.

## Assets and trust boundaries

| Asset                                   | Threat actor / path                                  | Boundary and required control                                                                                               |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Internal network and metadata endpoints | Caller-controlled URL, redirect, DNS rebinding       | `safeFetch` validates URL and resolved addresses on every hop; public mode rejects private/reserved and mixed answers       |
| Server credentials and host filesystem  | Profile path, parser input, extracted content        | Trusted roots/configured grants, canonicalization, containment, symlink checks, size/type checks; no default `$HOME` access |
| Parser process and host resources       | Malformed PDF/Office input, parser/native dependency | Disposable child, V8 heap cap, timeout, abort, bounded input/output, malformed-protocol rejection                           |
| Browser session and cookies             | Arbitrary web page or browser automation action      | Dedicated browser principal, restricted mounts/credentials, deployment egress and resource limits                           |
| Crawl4AI and embedding/JobSpy sidecars  | Compromised or malformed sidecar traffic             | Separate principals, explicit operator endpoint configuration, deployment network policy                                    |
| Source acquisition legality/policy      | Adapter bypass or accidental automation              | Versioned SourcePolicy coordinator; unknown/blocked states fail closed                                                      |

## Implemented controls

### `safeFetch`

Covered callers are `src/crawl/spiders.ts`, `src/tools/families/agenticBrowse.ts`, `src/tools/semanticCrawl.ts`, `src/tools/standalone/rss.ts`, `src/tools/webRead.ts`, `src/tools/webSearchDocEnrich.ts`, `src/utils/documentExtraction.ts`, and `src/utils/externalRecovery.ts`. It supports only `GET`/`HEAD`; enforces URL credentials rejection, DNS validation per hop, private/reserved-address blocking, redirect limit, deadline, byte cap, identity encoding, and cross-origin header reduction. `operator_internal` requires an operator allowlist and is never caller-provided authorization.

Excluded from this guarantee: browser/CDP traffic, Crawl4AI traffic, embedding and JobSpy sidecar traffic, content safety, malware scanning, and OS-level egress controls. These require separate principals and deployment controls.

### Portable parser capability

The declared contract is exact:

```text
processIsolation=enforced
networkIsolation=not_enforced
memoryIsolation=v8_heap_only
```

Child-process isolation and V8 heap limits do not claim OS sandboxing, network denial, or native-memory limits. Deployment must enforce `egress_denied`, CPU/wall-clock limits, native/container memory limits, filesystem gates, and process/resource quotas. Binary profile parsing is disabled by default until Wave 2 hardening.

### Source policy

`SourcePolicyRegistry` clones/freezes policies, preserves revision/evidence/date metadata, returns `not_supported` for unknown source or mode, and `runIfPermitted` makes zero operation calls for blocked or non-permitted decisions. This is a skeleton only. It is **not wired to the legacy JobSpy path**. Source-policy coordination and enforcement belong to Wave 3; no current documentation should imply that legacy JobSpy is policy-gated.

### Process telemetry privacy

Process logs and traces exclude raw query text, hashes, URLs, paths, identifiers, and error payloads. User-visible results and warnings remain outside this logging guarantee. Local corpus `query_log` persists raw query text plus its hash and is explicitly outside the Wave 0 guarantee; this privacy/retention risk is gated before broader production persistence.

### Parser settlement

Parser promises settle only after child `close`; spawn errors reject after close rather than relying on `exit`.

## Deployment abuse cases

- **DNS rebinding / SSRF:** safe-fetch re-resolution and pinned lookup reduce public URL SSRF; sidecars and browser traffic remain deployment responsibility.
- **Parser bomb or hang:** input/output caps, timeout, abort, and child termination limit application exposure; native memory still needs container limits.
- **Parser network exfiltration:** not blocked by portable code; use `egress_denied` worker deployment.
- **Credential or filesystem disclosure:** trusted-root and narrow-grant handling is required; do not mount broad home directories.
- **Browser/Crawl4AI compromise:** run each under separate principals with no server credentials and minimal mounts.
- **Policy bypass:** do not treat adapter capability as permission; wire coordinator before enabling automated source expansion.

## Residual risk owners

| Residual risk                                         | Owner               | Gate                                               |
| ----------------------------------------------------- | ------------------- | -------------------------------------------------- |
| OS egress, CPU, native-memory, filesystem enforcement | Deployment/security | Required before hostile document/profile workloads |
| Parser hardening and binary profile enablement        | Jobs platform       | Wave 2                                             |
| Legacy JobSpy policy wiring                           | Acquisition         | Wave 3                                             |
| Profile encryption and retention                      | Jobs architecture   | Pending ADR settlement                             |
| Corpus `query_log` raw query retention                | Jobs architecture   | Privacy/retention gate before broader persistence  |
