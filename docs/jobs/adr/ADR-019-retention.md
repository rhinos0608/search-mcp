# ADR-019: Retention policy

**Status:** Deferred

## Unresolved decisions

Set profile lifetime, raw observation payload, job lifecycle, run/debug trace, reasoning packet, backup, and secure-deletion policies. Review storage, privacy, licensing, replay, and operational needs.

## Conservative behavior

Do not persist sensitive profiles, raw payloads, reasoning packets, or debug traces before their gates settle; retain hashes/projections only where allowed.

## Boundaries

Settle before Wave 2B profile persistence, Wave 7 production persistence, Wave 10 packet persistence, and Wave 12 debug persistence. No default retention period is invented.
