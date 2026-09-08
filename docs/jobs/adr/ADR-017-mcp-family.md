# ADR-017: Compact progressive MCP family

**Status:** Approved

## Decision

Provide strongly typed `jobs_search` plus one compact `jobs` family with outer `action` and bounded request. `capabilities` returns action cards; `describe_action` returns one strict schema, effects, limits, and examples. Internal Zod schemas validate after action selection.

## Consequences and verification

Descriptions stay out of base schema; `jobs_search` and `jobs` are sole jobs MCP surfaces. Generated docs/tests must match schemas. ADR-026 records removal of unpublished legacy semantic jobs.
