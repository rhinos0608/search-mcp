# Reddit `/comments/{article}` JSON API — Implementer Reference

This document is research output captured during implementation of the `reddit_comments` tool.
It is intended as a reference for implementer subagents and reviewers and may be deleted once
the tool is fully shipped and tested.

## 1. Endpoint Patterns

### 1.1 Public (unauthenticated) — `www.reddit.com`

```
https://www.reddit.com/comments/{article}.json
https://www.reddit.com/r/{subreddit}/comments/{article}.json
https://www.reddit.com/r/{subreddit}/comments/{article}/{slug}.json
https://www.reddit.com/r/{subreddit}/comments/{article}/{slug}/{comment_id}.json
```

- `{slug}` is not required for correctness — `_` is the canonical placeholder.
- The `.json` suffix must come at the end of the path before the query string.
- A trailing slash before `.json` (e.g. `/slug/.json`) is malformed; use `slug.json` or `_.json`.

### 1.2 OAuth — `oauth.reddit.com`

```
https://oauth.reddit.com/r/{subreddit}/comments/{article}
https://oauth.reddit.com/r/{subreddit}/comments/{article}/_/{comment_id}
```

- The `.json` suffix is **not required** on `oauth.reddit.com` (it returns JSON by default).
  It is tolerated, but idiomatic OAuth requests omit it.
- Required headers: `Authorization: bearer <token>` and a unique `User-Agent`.

### 1.3 Focused-comment URL variants

```
# Path-based (underscore placeholder for slug)
/r/{sub}/comments/{article}/_/{comment_id}

# Query-parameter based
/r/{sub}/comments/{article}?comment={comment_id}&context=3
```

## 2. Query Parameters

| Param       | Type        | Range                                                                      | Default                          | Notes                                                                                                                         |
| ----------- | ----------- | -------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `comment`   | string ID36 | any                                                                        | none                             | Focus on a comment subtree. Overrides path-based comment id.                                                                  |
| `context`   | integer     | `0`–`8`                                                                    | unspecified                      | Number of parent comments to include above focused `comment`. Ignored without `comment`.                                      |
| `depth`     | integer     | `1`–`10`                                                                   | `10`                             | Max tree depth. `depth=1` returns top-level only.                                                                             |
| `limit`     | integer     | `1`–`500`                                                                  | `~200`                           | Total comment nodes returned. (Plan caps at 100 — safe.)                                                                      |
| `sort`      | string      | `confidence`, `top`, `new`, `controversial`, `old`, `qa`, `random`, `live` | `confidence` (anonymous default) | `confidence` is the canonical "best" value.                                                                                   |
| `showmore`  | boolean     | `true`/`false`                                                             | `true`                           | When falsy, suppresses `more` placeholder children in the response.                                                           |
| `threaded`  | boolean     | `true`/`false`                                                             | `true`                           | When `false`, returns flat list with `replies = ""` everywhere; reconstruct via `parent_id`.                                  |
| `raw_json`  | integer     | `1`                                                                        | off                              | **Always set `raw_json=1`** for JSON consumers — disables HTML-entity escaping of `&`, `<`, `>` in `body`/`selftext`/`title`. |
| `truncate`  | integer     | `0`–`50`                                                                   | unspecified                      | Suppresses top-level `more` placeholder.                                                                                      |
| `sr_detail` | boolean     | `true`/`false`                                                             | `false`                          | Embeds subreddit metadata.                                                                                                    |

## 3. Response Shape

The body is a **JSON array of exactly two `Listing` objects**:

```
response[0] — post Listing — single child kind: "t3" (the submission)
response[1] — comment Listing — children of kind "t1" (comment) or "more" (placeholder)
```

### 3.1 `t3` post fields (most-used subset)

```
id, name, title, author, subreddit, subreddit_id, selftext, selftext_html,
is_self, url, permalink (relative), domain, score, ups, downs, upvote_ratio,
num_comments, num_duplicates, created, created_utc, edited (false | epoch),
is_video, over_18, spoiler, locked, stickied, archived, distinguished,
thumbnail, link_flair_text, link_flair_css_class, post_hint, preview
```

### 3.2 `t1` comment fields (most-used subset)

```
id, name, author, body, body_html, score, score_hidden, ups, downs, gilded,
created, created_utc, edited, permalink (relative), link_id, parent_id,
depth, replies (string "" OR Listing), subreddit, subreddit_id,
distinguished, stickied, collapsed, collapsed_reason, controversiality,
archived, locked, is_submitter
```

**Critical edge case:** `t1.replies` is either the empty string `""` (no replies, or
`threaded=false`) OR a full `Listing` object whose `children` may mix `t1` and `more`.
Always type-check before descending.

### 3.3 `more` placeholder fields

```
{
  "kind": "more",
  "data": {
    "count":    103,                  // descendants represented
    "name":     "t1_g83z4le",
    "id":       "g83z4le",
    "parent_id":"t1_g8343ao",
    "depth":    4,
    "children": ["g83z4le", "g83wl0j", ...]   // ID36s expandable via /api/morechildren
  }
}
```

**"Continue this thread" special case:** `id === "_"`, `count === 0`, `children: []`.
Cannot be expanded via `/api/morechildren`. Re-fetch with focused URL:
`/r/{sub}/comments/{article}/_/{parent_id_36}?context=0&raw_json=1`.

### 3.4 `permalink` handling

Both `t3.permalink` and `t1.permalink` are root-relative (`/r/.../`). Always prepend
`https://www.reddit.com` to canonicalize. Do not use `oauth.reddit.com` for user-shareable URLs.

## 4. OAuth Flow (server-side, no user)

### 4.1 Token endpoint

```
POST https://www.reddit.com/api/v1/access_token
```

(Token exchange is on `www.reddit.com`, NOT `oauth.reddit.com`.)

### 4.2 Grant type for confidential client (have client_id + client_secret, no user)

```
grant_type=client_credentials
```

### 4.3 Request

```http
POST /api/v1/access_token HTTP/1.1
Host: www.reddit.com
Authorization: Basic {base64(client_id:client_secret)}
User-Agent: nodejs:com.example.search-mcp:v0.1.0 (by /u/your_username)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

### 4.4 Response

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "expires_in": 86400,
  "scope": "*"
}
```

- No `refresh_token` for `client_credentials`.
- `expires_in` historically `3600`, currently up to `86400`. Always read from the response.

### 4.5 Subsequent API calls

```http
GET /r/programming/comments/1abc2de?raw_json=1&sort=top HTTP/1.1
Host: oauth.reddit.com
Authorization: bearer eyJhbGciOi...
User-Agent: nodejs:com.example.search-mcp:v0.1.0 (by /u/your_username)
```

### 4.6 Error response shapes

| Scenario                   | Status  | Body                                                         |
| -------------------------- | ------- | ------------------------------------------------------------ |
| Bad client_id/secret       | 401     | `{"message": "Unauthorized", "error": 401}`                  |
| Bad grant_type body        | **200** | `{"error": "unsupported_grant_type"}` (parse body to detect) |
| Missing User-Agent         | 429     | `{"message": "Too Many Requests", "error": 429}`             |
| Expired bearer on API call | 401     | `{"message": "Unauthorized", "error": 401}`                  |

### 4.7 Rate limits under OAuth

100 QPM per OAuth `client_id`, averaged over a rolling 10-minute window
(July 2023 change; older docs say 60). Headers on every response:

- `X-Ratelimit-Used` (float string)
- `X-Ratelimit-Remaining` (float string)
- `X-Ratelimit-Reset` (seconds-from-now)

### 4.8 User-Agent format (REQUIRED)

```
<platform>:<app-id>:<version> (by /u/<username>)
```

Reddit warns: _"NEVER lie about your user-agent."_ Generic UAs (curl, python-requests) get
aggressive rate-limiting / 429s.

## 5. Edge Cases / Footguns

1. `/api/morechildren` is OAuth-preferred; `children` capped at 100 per call.
2. `more` with `id === "_"` ("continue this thread") — re-fetch focused URL, do NOT call `/api/morechildren`.
3. `t1.replies` polymorphism (empty string `""` vs Listing). Type-check before recursion.
4. Trailing-slash + `.json`: use `slug.json`, never `slug/.json`.
5. Without `raw_json=1`, `&` `<` `>` are HTML-escaped in JSON string fields.
6. `body_html` / `selftext_html` are double-encoded (HTML inside HTML-escaped JSON).
7. Private subreddit → 403 `{"reason": "private", ...}`.
8. Quarantined subreddit → 403, requires user opt-in (impossible with app-only token).
9. Banned subreddit → 404.
10. Deleted submission: `selftext = "[removed]"`, `author = "[deleted]"`.
11. `score`, `ups`, `downs` are fuzzed; `downs` ≈ 0 always; use `upvote_ratio` on `t3`.
12. `modhash` is empty on JSON responses for non-logged-in requests.
13. `Listing.before`/`after` are not paginators on `/comments`.
14. Depth semantics for focused comments: focused comment is `depth: 0` in the response.
15. Anonymous `www.reddit.com` is ~10 QPM in practice (undocumented).
16. Empty comment listing for focused `comment=` id when comment was deleted: 200, not 404.

## 6. Source

Compiled from primary citations:

1. [reddit-api-doc-notes — comment_tree.rst (Pyprohly)](https://github.com/Pyprohly/reddit-api-doc-notes/blob/main/docs/api-reference/comment_tree.rst)
2. [reddit-archive/reddit wiki — JSON](https://github.com/reddit-archive/reddit/wiki/JSON)
3. [reddit-archive/reddit wiki — API](https://github.com/reddit-archive/reddit/wiki/API)
4. [reddit-archive/reddit wiki — OAuth2](https://github.com/reddit-archive/reddit/wiki/OAuth2)
5. [reddit-archive/reddit wiki — OAuth2-Quick-Start-Example](https://github.com/reddit-archive/reddit/wiki/OAuth2-Quick-Start-Example)
6. [PRAW Submission model](https://praw.readthedocs.io/en/latest/code_overview/models/submission.html)
7. [JRAW Issue #225 — raw_json escaping](https://github.com/mattbdean/JRAW/issues/225)
8. [Simon Willison TIL — Scraping Reddit JSON](https://til.simonwillison.net/reddit/scraping-reddit-json)
9. [PRAW Issue #856 — permalink relative path](https://github.com/praw-dev/praw/issues/856)
