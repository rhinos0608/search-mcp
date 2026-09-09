# ADR-012: SEEK direct access blocked, indexed discovery and manual import supported

**Status:** Approved

## Context

Captured robots/terms evidence blocks intended automated direct SEEK acquisition. This restriction governs direct acquisition edges, not information objects returned by independently authorized providers.

## Decision

Do not directly automate SEEK search or destination fetch absent authorization. Permit provider-attributed indexed candidates returned by an independently authorized third-party search provider. Keep those candidates visible as `indexed_only` with explicit caveats; they are not publisher facts and do not create `SourceObservation` records.

Accept lawful user-supplied URL metadata, inline text, files, or structured content through normal extraction and assessment. URL-only import fetches only when its destination-fetch edge is permitted; otherwise returns `content_required`. Manual supplied content remains unverified solely because user supplied it.

Installed default policy:

```text
automatedSearch (direct SEEK): blocked
automatedFetch (SEEK destination): blocked
userSuppliedContent: permitted
manualImport: permitted
employerApi: not_supported
```

## Consequences and verification

Third-party provider authorization never grants direct SEEK search or fetch. Verify permitted provider + blocked SEEK yields provider calls and caveated indexed candidates, zero SEEK adapter calls, and zero destination fetch calls. Verify blocked direct modes produce zero direct network calls. Indexed snippets and provider-generated summaries remain provenance-bearing donor evidence, not publisher facts.

Policy binds actor, operation, route, and target; it does not taint information objects. Any legal, confidentiality, or safety handling propagation requires separate explicit classification with cited basis, out of scope here.

Live SEEK/provider/manual MCP composition requires non-empty reviewed evidence refs; empty live evidence is invalid at `buildJobsMcpDeps`. Internal only; no MCP evidence payload. `SOURCE_CLASS_CONTRACT_VERSION` remains `1.0.0`.
