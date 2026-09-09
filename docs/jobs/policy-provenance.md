# Policy provenance

Live jobs MCP composition (`buildJobsMcpDeps`) requires reviewed authorization evidence on SEEK, indexed-provider, and manual-import policies. Empty `evidenceRefs` remain allowed in **test factories** only.

## Contract

- `SOURCE_CLASS_CONTRACT_VERSION` stays `1.0.0`. Additive optional fields on `AuthorizationEvidence`: `documentTitle`, `effectiveAt`, `reviewedAt`, `reviewerId`, `conclusion`, `appliesTo`.
- `conclusion` is an operator encoding (`direct_automated_access_blocked` | `indexed_provider_operator_authorized` | `insufficient_public_basis`), not a legal holding.
- `citationRef` is the authority URL/document. `contentHash` is omitted until a real capture exists. Do not invent hashes, reviewers, or TOS clauses.
- SEEK terms/robots dates are cited document publication metadata (SEEK Website Terms last updated 20 July 2026), not a byte-capture claim.
- Indexed provider authorization means the operator-configured API backend may run indexed `automatedSearch`. It never permits SEEK direct access.
- No public MCP evidence payload.

## Migration

Internal only. Live empty SEEK/provider/manual evidence now throws at MCP composition. Wave-3 non-claim that SEEK is uninstalled is stale: SEEK source-class is installed and blocked for direct search/fetch.
