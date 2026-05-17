# Slice B — Shared response recovery metadata

Date: 2026-05-17

## Goal

Expose consistent, optional recovery and provenance metadata in tool responses without changing existing result payloads.

## Current-state notes

- `src/tools/response.ts` already centralizes `makeResult`, `successResponse`, and `errorResponse`.
- Existing metadata includes warnings, rate-limit, correction, and intent-filter data.
- `web_search` performs backend fallback, but callers cannot reliably see which backend served the result or why fallback occurred.

## Implementation

1. - [x] Extend `MakeResultOpts` in `src/tools/response.ts` with optional fields:
   - `provenance?: { usedBackend?: string; usedFallback?: boolean; fallbackReason?: string }`
   - `retry?: { recommended: boolean; reason?: string; minimalCall?: Record<string, unknown> }`
   - `normalized?: { aliases?: Record<string, string>; defaults?: Record<string, unknown>; ignoredFields?: string[] }`
   - `partial?: boolean`
2. - [x] Emit these fields under the existing response `meta` object only when provided.
3. - [x] Extend `ToolWrappedResponse`/family dispatch plumbing in `src/tools/registry.ts` only if needed for family handlers to pass the same metadata shape.
4. - [x] Wire `web_search` so responses include served backend and fallback status.
5. - [x] Keep the metadata additive. Do not wrap or rename existing data fields.

## Tests

- [x] Add `test/responseMetadata.test.ts` for `makeResult` meta output.
- [x] Add a `web_search` fallback/provenance unit test using mocked backends where practical.

## Validation

```bash
npm run typecheck
npm run lint
npm test test/responseMetadata.test.ts
```
