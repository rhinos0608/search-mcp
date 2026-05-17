# Slice A — Shared schema normalization

Date: 2026-05-17

## Goal

Make common tool inputs more tolerant without changing existing public fields. This slice is additive and compatibility-preserving.

## Current-state notes

- `src/tools/registry.ts` already treats top-level `null` as omitted for family tools.
- Empty strings are not uniformly treated as omitted.
- `src/tools/families/reddit.ts` has local empty-string/null handling that should become shared.
- GitHub family actions accept `owner` + `repo` and some `repository` forms, but not GitHub URLs consistently.

## Implementation

1. Add `src/tools/normalize.ts` with small shared helpers:
   - `emptyStringToUndefined(value)`
   - `optionalTrimmedString(schema?)`
   - `resolveLimit(input, aliases, defaults)`
   - `resolveGitHubRepoLocator(input)` supporting `owner/repo`, `owner + repo`, and `https://github.com/owner/repo`.
2. Update `src/tools/registry.ts` merged family preprocessing so optional top-level empty strings are omitted like `null`.
3. Replace local Reddit empty-string handling with the shared helper.
4. Apply GitHub repo locator resolution in `src/tools/families/github.ts` for repo and code-search paths that currently require repo-shaped fields.
5. Keep all existing field names accepted. Do not remove or move fields under `options`.

## Tests

- Add `test/toolNormalize.test.ts` for helper behavior.
- Extend `test/familyRegistryNullDefaults.test.ts` with optional empty-string cases.
- Add/extend GitHub family registration tests for GitHub URL locators.

## Validation

```bash
npm run typecheck
npm run lint
npm test test/toolNormalize.test.ts test/familyRegistryNullDefaults.test.ts
```
