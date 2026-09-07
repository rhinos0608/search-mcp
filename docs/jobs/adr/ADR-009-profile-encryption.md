# ADR-009: Separate encrypted profile store

**Status:** Security property approved; mechanism chosen but unactivated

## Decision

Sensitive profiles require separate encrypted persistence, key separation, rotation, recovery, deletion semantics, and matching backup controls. Store profiles separately from jobs.

## Mechanism status

ADR-020 D1 approves SQLCipher whole-DB encryption. ADR-020 D2 approves OS keychain for key storage. However, only `MemoryKeyProvider` exists today (volatile, no persistence). No production profile persistence is wired — ADR-019 (retention) remains deferred.

## Conservative behavior

Process profiles in memory only. Persist no raw résumé, full extracted text, sensitive excerpts, reusable handles, or reasoning packets. Durable profile persistence activates only when ADR-019 is resolved and OS keychain provider is implemented.
