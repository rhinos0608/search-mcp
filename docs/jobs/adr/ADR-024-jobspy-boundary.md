# ADR-024: JobSpy acquisition boundary

## Status

Accepted

## Decision

In-process `jobspy-js` is used only behind injected `scrapeJobs`. Python JobSpy sidecar is removed. Default authorized JobSpy boards are empty. A board may execute only with explicit operator enablement and exact independently reviewed policy evidence; capability does not authorize work. Unknown, blocked, review, missing-policy, missing-capability, and credential-bearing configurations make zero scraper calls. SEEK direct automation remains impossible. Response timeout bounds coverage only; Promise timeout cannot terminate underlying scraper work. Indexed-only discovery remains usable.

## Consequences

JobSpy direct acquisition is fail-closed by default. Python sidecar and unpublished semantic_jobs pipeline are removed; in-process acquisition remains policy-gated.
