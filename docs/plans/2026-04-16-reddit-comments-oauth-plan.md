# Reddit Comments + OAuth Plan

## Goal

Add a new Reddit comment-section tool end to end, then add an OAuth-backed request path while preserving the current unauthenticated public JSON path as a fallback.

## Requirements

- Add a full new tool rather than extending `reddit_search`.
- Support fetching a Reddit post plus its comment section.
- Support practical thread controls such as sort, depth, limit, and focused subthread retrieval.
- Add an OAuth-backed path for Reddit requests.
- Keep the tool usable without OAuth credentials when possible.
- Follow TDD.
- After every implementation round, run a review round.
- If a review finds issues, fix them and re-run review before proceeding.
- Complete the task end to end, including documentation and verification.
- Preserve `reddit_search` behavior and output compatibility while moving it onto shared Reddit transport.

## Assumptions

- OAuth support means server-to-Reddit authenticated requests using app credentials from config/env, not an interactive per-user login flow.
- Public read-only `.json` endpoints remain available and should still be used as fallback when OAuth is not configured.
- A lightweight token cache in memory is sufficient.
- No existing test harness exists, so test infrastructure must be introduced first.

## Design

### New Tool

Add `reddit_comments` with inputs:

- `url?: string` - full Reddit post URL
- `permalink?: string` - relative Reddit permalink beginning with `/r/`
- `subreddit?: string` - subreddit name, only valid with `article`
- `article?: string` - post id without fullname prefix, only valid with `subreddit`
- `comment?: string` - comment id without fullname prefix; focuses retrieval on a subthread when provided
- `context?: number` - number of parent/child context comments Reddit should include around `comment`; only valid when `comment` is provided; range `0..8`
- `sort?: "confidence" | "top" | "new" | "controversial" | "old" | "qa"`
- `depth?: number` - range `1..10`
- `limit?: number` - range `1..100`
- `showMore?: boolean` - if true, include Reddit `more` placeholders in the normalized response; if false, omit them from `comments` and surface only summary metadata

Resolution rules:

- Exactly one locator form is allowed:
  - `url`
  - `permalink`
  - `subreddit + article`
- Reject mixed locator forms.
- `url` and `permalink` may optionally include a trailing comment id; explicit `comment` overrides that parsed comment id.
- `comment` without `context` means focused subthread with Reddit default context.
- Return a single normalized payload containing post metadata and a nested comment tree.
- v1 will not call `/api/morechildren`; `showMore` only controls whether existing `more` placeholders are preserved in the returned shape.

### Output Shape

- `post`: normalized post object
- `comments`: nested normalized comments
- `more`: top-level list of normalized `more` placeholder metadata that were omitted from `comments` when `showMore=false`
- `request`: normalized request metadata describing locator resolution and effective parameters

Each normalized comment should include:

- `id`
- `fullname`
- `author`
- `body`
- `score`
- `createdUtc`
- `permalink`
- `parentId`
- `depth`
- `replies`
- `distinguished`
- `stickied`
- `collapsed`

Each normalized `more` entry should include:

- `id`
- `parentId`
- `depth`
- `count`
- `children`

`post` must include:

- `id`
- `fullname`
- `title`
- `selftext`
- `author`
- `subreddit`
- `score`
- `numComments`
- `createdUtc`
- `permalink`
- `url`
- `isVideo`

`request` must include:

- `source` - one of `url`, `permalink`, `subreddit_article`
- `sort`
- `depth`
- `limit`
- `comment`
- `context`
- `showMore`
- `usedOAuth`

### OAuth Path

Add Reddit config fields:

- `reddit.clientId`
- `reddit.clientSecret`
- optional `reddit.userAgent`

Add matching env vars:

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- optional `REDDIT_USER_AGENT`

Behavior:

- Build a shared Reddit client first, then use it from both `reddit_search` and `reddit_comments`.
- If Reddit OAuth credentials are not configured, use `https://www.reddit.com/... .json`.
- If both Reddit OAuth credentials are configured, fetch and cache an app token and call `https://oauth.reddit.com/...`.
- If exactly one of `clientId` or `clientSecret` is configured, treat that as invalid configuration and fail fast with a validation/config error. Do not fall back silently.
- If credentials are configured but token acquisition fails due to invalid credentials or Reddit auth rejection, fail fast and surface an auth/config error. Do not silently fall back.
- If credentials are configured and token acquisition succeeds, but a subsequent content request fails with a non-auth transport error, return that error. Do not silently retry the same request on the public path.
- Public fallback is only for the `not configured` case, not the `partially configured` or `configured but broken` case.
- Invalid or broken Reddit OAuth configuration must never crash server startup. The server still starts and registers the Reddit tools; the failure is surfaced as tool-local runtime errors plus degraded `health_check` status with remediation text.
- Keep a shared request helper so both `reddit_search` and `reddit_comments` can use the same transport logic.
- Preserve existing `reddit_search` request parameters, heuristics, result shape, error mapping, and Reddit rate-limit tracker side effects.

### Testability Seams

- Introduce a Reddit transport/client module that accepts injected `fetch`, clock, and config readers.
- Keep token cache resettable for tests.
- Keep config cache resettable in tests through existing `resetConfig()`.
- Use fixture-based parser tests for Reddit post/comment listing responses.

### Non-Goals

- No cross-Reddit comment search.
- No `/api/morechildren` expansion in v1.
- No interactive auth flow.

## Execution Rounds

## Subagent Workflow

Each round is executed by fresh subagents with explicit ownership:

1. Implementer subagent makes only the code changes for that round and runs its own tests.
2. Independent spec reviewer subagent checks the round against this plan and the user’s requirements.
3. If spec review finds issues, the same implementer subagent fixes them.
4. The spec reviewer re-reviews until approved.
5. Independent code quality reviewer subagent reviews the accepted round.
6. If code review finds issues, the same implementer subagent fixes them.
7. The code quality reviewer re-reviews until approved.
8. Only then does the next round start.

Each implementer prompt will include:

- Exact file ownership for the round
- A requirement to follow red-green-refactor
- A requirement to report which failing test was written first
- A warning that they are not alone in the codebase and must preserve unrelated changes

### Round 1: Test Harness and Shared Reddit Client Skeleton

- Add a test runner and test scripts.
- Update TypeScript/test config so tests are part of normal verification.
- Add first failing tests for:
  - request locator parsing
  - comment tree normalization
  - public Reddit request URL construction through a shared client boundary
  - baseline `reddit_search` output compatibility fixtures covering existing result shape and key heuristics
- Verify those tests fail before any production implementation.
- Implement only the minimum shared Reddit client/parser seams needed to make those tests pass.

### Round 2: Public `reddit_comments` Tool via TDD

Red-green order for this round:

1. Write failing validation tests for accepted/rejected locator combinations and `comment/context` rules.
   - Include failing tests for numeric bounds on `context`, `depth`, and `limit`.
2. Implement minimum validation and locator resolution to pass.
3. Write failing tool/service tests for normalized post + comments output from public `.json` responses.
4. Implement minimum `reddit_comments` behavior to pass.
5. Write failing server registration tests for tool exposure and input schema invariants.
6. Implement minimum registration code to pass.

### Round 3: OAuth-Backed Shared Transport via TDD

Red-green order for this round:

1. Write failing config tests for env/config merge behavior and reset behavior.
   - Include failing tests for partial OAuth configuration (`clientId` without `clientSecret`, and vice versa).
2. Implement minimum config changes to pass without disturbing existing local changes.
3. Write failing client tests for:
   - OAuth chosen when configured
   - public path chosen when not configured
   - token caching
   - expiry-aware token refresh when a cached token is stale
   - configured-but-bad-credentials failure
   - no-regression request behavior for `reddit_search`
   - no-regression output compatibility for `reddit_search` against the baseline fixtures created in Round 1
   - no-regression `reddit_search` error semantics for 429, 403, and timeout paths
   - no-regression Reddit rate-limit tracker updates used by `health_check`
4. Implement minimum OAuth token and shared transport logic to pass.
5. Re-run the `reddit_search` baseline compatibility tests to verify output stability.

### Round 4: Docs and Health Wiring

- Update tool docs, quickstart docs, architecture docs, and health/config surfaces.
- Document new env/config fields and fallback behavior.
- Add `reddit_comments` to `health_check` inventories and map it to the shared Reddit rate-limit state.
- Add health semantics for:
  - no Reddit OAuth configured: healthy for public use
  - partially configured Reddit OAuth: degraded or invalid configuration with remediation text
  - Reddit OAuth configured: healthy at config layer if credentials are present
  - runtime OAuth failures: surfaced as tool/runtime errors rather than startup gating or startup crashes
- Write failing tests for health/config reporting semantics and implement the minimum code to pass.

## Review Gates

After each round:

1. Spec compliance review
2. Fix any spec issues
3. Re-run spec review until approved
4. Code quality review
5. Fix any quality issues
6. Re-run code quality review until approved

After all rounds:

- Final whole-change review
- Fix any final review issues
- Re-run final whole-change review until approved
- Full verification run: tests, typecheck, lint, build

## Risks

- Reddit response shapes vary between post listings, comment listings, and `more` nodes.
- OAuth token handling can introduce brittle test setup if transport boundaries are not isolated early.
- Existing user changes in `src/config.ts` must be preserved.

## Success Criteria

- `reddit_comments` is registered and documented.
- The tool returns normalized thread data from Reddit URLs/permalinks/article ids.
- OAuth is supported via config/env and used when configured.
- Public fallback still works.
- Tests exist and are exercised in a real red-green cycle.
- Final verification passes.
