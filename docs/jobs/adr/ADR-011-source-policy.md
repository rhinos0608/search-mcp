# ADR-011: SourcePolicy independent from adapters

**Status:** Approved

## Decision

Versioned policy governs each acquisition edge independently from adapter capability. An edge is the tuple **actor, operation, route, target**. Policy binds that edge, not an information or evidence object. Adapters advertise capability only; the coordinator combines capability and policy and records revision, evidence, date, and notes.

Discoverer (provider reporting a URL), publisher (authority responsible for a listing), and content donor (provider of the representation) are separate provenance identities. Provider authorization may admit valid, caveated indexed candidates even when publisher direct search or fetch is blocked. Publisher policy does not taint or retroactively restrict indexed evidence.

## Policy states

`permitted`, `blocked`, `requires_configuration`, `requires_review`, `not_supported`; review never silently permits. Provider authorization permits provider search only. Direct publisher search and destination fetch require separate edge decisions; exact blocks override direct-access family permissions.

## Handling boundary

Evidence carries provenance, not inherited access restrictions. Legal, confidentiality, or safety handling may propagate only through a separate explicit classification with cited basis. This ADR does not invent that subsystem.

## Consequences and verification

Policy changes need no adapter rewrite. Blocked direct edges prevent their network calls without discarding permitted third-party indexed candidates. Provider snippets and summaries remain provider-attributed evidence, never publisher facts. Verify blocked provider calls produce zero provider calls; blocked direct publisher search/fetch produce zero direct calls while permitted indexed candidates remain visible with caveats. Keep Wave 2B, persistence, and `query_log` gates unchanged.
