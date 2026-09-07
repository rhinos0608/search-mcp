# ADR-014: Shadow/backfill migration

**Status:** Approved

## Decision

Create schema, backfill legacy postings as low-confidence legacy listings/observations, shadow and compare, cut over, retain compatibility projection, make legacy read-only, soak with zero-read/mutation telemetry, then delete only with explicit approval.

## Rejected

Mandatory dual-write. It creates two mutable truths and reconciliation debt.

## Exception and verification

Dual-write requires concrete mutation-consumer proof, reconciliation/idempotency/conflict/monitoring/exit plan, and approval. Verify interrupted resumable backfill and checksums.
