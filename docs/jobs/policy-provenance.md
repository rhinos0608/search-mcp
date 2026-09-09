# Policy provenance

Live jobs MCP composition (`buildJobsMcpDeps`) requires reviewed authorization evidence on SEEK, indexed-provider, and manual-import policies. Empty `evidenceRefs` remain allowed in **test factories** only.

## Contract

- `SOURCE_CLASS_CONTRACT_VERSION` stays `1.0.0`. Additive optional fields on `AuthorizationEvidence`: `documentTitle`, `effectiveAt`, `reviewedAt`, `reviewerId`, `conclusion`, `appliesTo`.
- `conclusion` is an operator encoding (`direct_automated_access_blocked` | `indexed_provider_operator_authorized` | `insufficient_public_basis` | `operator_configured_board_search` | `manual_import_user_supplied`), not a legal holding.
- `operator_configured_board_search` records an operator-listed board for indexed-provider `automatedSearch`. It is not a legal holding and never permits SEEK direct access.
- `manual_import_user_supplied` records operator-reviewed user-supplied manual import (route `user_supplied`) through the manual-import adapter. It is not a legal holding and never permits automated access.
- `citationRef` is the authority URL/document. `contentHash` is omitted until a real capture exists. Do not invent hashes, reviewers, or TOS clauses.
- SEEK terms/robots dates are cited document publication metadata (SEEK Website Terms last updated 20 July 2026), not a byte-capture claim.
- SEEK direct `automatedFetch` blocking is cited by a dedicated evidence record with its own citation anchor (`https://au.seek.com/terms/en#automated-access`) and distinct `sourceEvidenceId`; it is part of `SEEK_POLICY_EVIDENCE` and is cited on the blocked fetch edge. Anchors are section references in the cited document, not capture claims.
- Registry entry `reviewedAt` is the max evidence timestamp (`reviewedAt` falling back to `capturedAt`); empty test-factory evidence falls back to the test-path date.
- Indexed provider authorization means the operator-configured API backend may run indexed `automatedSearch`. It never permits SEEK direct access.
- No public MCP evidence payload.

## Migration

Internal only. Live empty SEEK/provider/manual evidence now throws at MCP composition. Wave-3 non-claim that SEEK is uninstalled is stale: SEEK source-class is installed and blocked for direct search/fetch.
