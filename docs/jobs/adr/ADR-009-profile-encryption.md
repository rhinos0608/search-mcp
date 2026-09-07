# ADR-009: Separate encrypted profile store

**Status:** Security property approved; mechanism deferred

## Decision

Sensitive profiles require separate encrypted persistence, key separation, rotation, recovery, deletion semantics, and matching backup controls. Store profiles separately from jobs.

## Unresolved gate

Choose and test SQLCipher, encrypted blobs, OS credential-store key, or generated key-file fallback before Wave 2B. No package may claim encrypted persistence before approval and tests.

## Conservative behavior

Until then, process profiles in memory; persist no raw résumé, full extracted text, sensitive excerpts, reusable handles, or reasoning packets.
