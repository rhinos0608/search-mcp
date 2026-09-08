# ADR-025: Bounded contact metadata persistence

## Status

Accepted

## Decision

Schema version 2 adds nullable `postings.contact_metadata TEXT` through ordered transactional migration. `JOBS_V1_DDL` and its checksum remain byte-identical. Undefined metadata persists as SQL NULL; `{}` persists as `{}`. Reads parse and validate bounded keys/strings; malformed values raise sanitized `SCHEMA_INCOMPATIBLE`. Replacement writes clear absent metadata. No down migration or backfill. Metadata is provenance/display data only and is excluded from ranking, reasoning, logs, profiles, and caches.

## Consequences

Existing v1 databases migrate forward without destructive changes. Contact metadata remains optional and cannot influence eligibility or ranking.
