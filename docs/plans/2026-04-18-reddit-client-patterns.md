# Reddit Client Implementation Patterns — Reference

Captured during implementation of `reddit_comments`. May be deleted once the tool ships.
Distilled from PRAW/prawcore (Python) and snoowrap (Node.js) source code.

## 1. Comment tree shape

**Recommendation:** surface `more` placeholders as first-class output (PRAW's pattern, not snoowrap's).
LLM consumers benefit from knowing "47 more replies hidden here" rather than getting a silently truncated tree.

Build the tree with the **flat-map-keyed-on-`name`** trick used by both libraries:

```ts
function buildTree(things: Thing[]): RedditComment[] {
  const byName = new Map(things.map((t) => [t.data.name, t]));
  const roots: RedditComment[] = [];
  for (const t of things) {
    const parent = byName.get(t.data.parent_id);
    if (parent) parent.data.replies.push(t.data);
    else roots.push(t.data);
  }
  return roots;
}
```

## 2. `more` expansion edge cases

1. `count > 0` with `id !== "_"` → expandable via `POST /api/morechildren` (max 100 ids per call).
2. `count === 0` with `id === "_"` → "continue this thread", re-fetch focused URL `/comments/{article}/_/{parent_id_36}.json`. Do NOT use `/api/morechildren`.
3. `/api/morechildren` responses can themselves contain new `more` nodes (Reddit silently truncates batches). Recurse.

(v1 of `reddit_comments` does not implement `/api/morechildren` per plan — it surfaces `more` placeholders only.)

## 3. OAuth grant matrix

| Configured                                              | Grant                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| nothing                                                 | Public unauthenticated JSON (`https://www.reddit.com/.../.json`)        |
| `client_id` + `client_secret`                           | `client_credentials` (confidential app-only) — **default for our case** |
| `client_id` + `client_secret` + `username` + `password` | `password` (script app) — out of scope for v1                           |
| `client_id` + `refresh_token`                           | `refresh_token` — out of scope for v1                                   |

For our MCP server with `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`: **default to `client_credentials`**.

snoowrap's `fromApplicationOnlyAuth` defaults to `installed_client`, but that path expects you to
have registered an installed/public app. A confidential client should use `client_credentials`.

## 4. Token caching

In-memory only. No disk, no cross-process sharing.

```ts
interface TokenCache {
  accessToken: string | null;
  expiresAt: number; // ms since epoch
}
```

- Capture `issuedAt = clock.now()` BEFORE the POST.
- Set `expiresAt = issuedAt + (expires_in * 1000) - SAFETY_MARGIN_MS`.
- Recommended `SAFETY_MARGIN_MS = 60_000` (60s) — safer than snoowrap's 10s.
- Proactive refresh: if `accessToken === null || clock.now() > expiresAt`, refresh first.
- Reactive refresh: on 401, clear token, refresh once, retry once.

prawcore lesson: capture timestamp BEFORE the network call so latency doesn't push perceived
expiry past actual expiry. prawcore's `+10` margin is the WRONG direction; do NOT copy it.

## 5. User-Agent

Required at construction time. Reddit format:

```
<platform>:<app-id>:<version> (by /u/<username>)
```

Example: `node:search-mcp:0.1.0 (by /u/your-username)`

For unauth-only mode, allow a default but warn. For OAuth, require it via env (`REDDIT_USER_AGENT`).
Reddit's policy is enforced: generic UAs get rate-limited regardless of auth state.

## 6. Error handling

| Status                                  | Action                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| 200                                     | Success                                                                                     |
| 400                                     | Throw, no retry                                                                             |
| 401                                     | If retry budget allows: clear token, refresh, retry once. Else throw.                       |
| 403                                     | Throw, no retry (private/quarantined/banned subreddit, suspended user)                      |
| 404                                     | Throw, no retry                                                                             |
| 429                                     | Throw with reset time attached. Do NOT auto-retry (rate limiter should prevent this)        |
| 5xx / 502 / 503 / 504 / 520 / 522 / 408 | Retry with jittered exponential backoff, idempotent verbs only (GET/HEAD), max 2-3 attempts |

**Do NOT fall back from OAuth → unauth on failure.** PRAW and snoowrap both refuse to do this.
Configuration errors should surface, not be masked.

Public unauth is fine as the **default** when no credentials are configured. OAuth is the optional
upgrade. But if OAuth is configured and fails, raise — do not silently degrade.

## 7. Rate limiting (proactive)

Parse every response's headers:

```
x-ratelimit-remaining (float)
x-ratelimit-used      (float)
x-ratelimit-reset     (seconds-from-now)
```

Maintain `nextRequestTimestamp`. Sleep before each request if needed.

Simple Node version (spreads remaining requests evenly across the reset window):

```ts
update(headers: Headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining") ?? NaN);
  const resetSec = Number(headers.get("x-ratelimit-reset") ?? NaN);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return;
  if (remaining <= 0) {
    this.nextRequestMs = clock.now() + Math.max(1000, resetSec * 1000);
  } else {
    const spacing = (resetSec * 1000) / Math.max(1, remaining);
    this.nextRequestMs = clock.now() + Math.min(spacing, 10_000);
  }
}
```

(Existing project already has `src/rateLimit.ts` with `parseRedditHeaders` and a `getTracker('reddit')`.
The new client should reuse it.)

## 8. Testability — dependency injection

Inject `fetch` and `clock` so tests don't touch the network or real time:

```ts
export interface HttpFetcher {
  (req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers: Headers; body: string }>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class RedditClient {
  constructor(
    private config: RedditClientConfig,
    private fetcher: HttpFetcher = defaultFetcher,
    private clock: Clock = systemClock,
  ) {}
}
```

This enables:

- No-network tests (full determinism)
- Token-expiry tests (advance `mockTime`, assert refresh)
- Rate-limit tests (assert `clock.sleep` called with right duration)
- Retry tests (queue 401 then 200, assert refresh between)

(Existing `redditClient.ts` already accepts `fetchImpl` — extend with `clock` for OAuth.)

## 9. Permalink canonicalization

Reddit returns relative paths. Neither PRAW nor snoowrap canonicalize them. We canonicalize to
`https://www.reddit.com/...` for stable output:

```ts
function canonicalizePermalink(path: string): string {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) {
    return path.replace(/^https?:\/\/(?:old|new|i|m|www)\.reddit\.com/, 'https://www.reddit.com');
  }
  return `https://www.reddit.com${path.startsWith('/') ? path : '/' + path}`;
}
```

(Existing `redditPermalink.ts` does this.)

## 10. Citations

1. [PRAW CommentForest](https://github.com/praw-dev/praw/blob/master/praw/models/comment_forest.py)
2. [PRAW MoreComments](https://github.com/praw-dev/praw/blob/master/praw/models/reddit/more.py)
3. [prawcore auth.py](https://github.com/praw-dev/prawcore/blob/main/prawcore/auth.py) — Authenticator/Authorizer split
4. [prawcore sessions.py](https://github.com/praw-dev/prawcore/blob/main/prawcore/sessions.py) — retry strategy
5. [prawcore rate_limit.py](https://github.com/praw-dev/prawcore/blob/main/prawcore/rate_limit.py)
6. [snoowrap snoowrap.js](https://github.com/not-an-aardvark/snoowrap/blob/master/src/snoowrap.js) — `fromApplicationOnlyAuth`, `grantType`
7. [snoowrap request_handler.js](https://github.com/not-an-aardvark/snoowrap/blob/master/src/request_handler.js) — retry/refresh, rawRequest hook
8. [snoowrap More.js](https://github.com/not-an-aardvark/snoowrap/blob/master/src/objects/More.js) — nested-more recursion
9. [snoowrap helpers.js](https://github.com/not-an-aardvark/snoowrap/blob/master/src/helpers.js) — `buildRepliesTree`
10. [Reddit OAuth2 wiki](https://github.com/reddit-archive/reddit/wiki/OAuth2)
