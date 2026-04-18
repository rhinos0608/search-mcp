# Tools

`search-mcp` exposes a set of MCP tools. This document describes each tool's inputs, outputs, underlying approach, and known caveats.

---

## `web_search`

Perform a web search using Brave or SearXNG and return a ranked list of results.

### Inputs

| Parameter    | Type    | Required | Default | Description                                               |
| ------------ | ------- | -------- | ------- | --------------------------------------------------------- |
| `query`      | string  | yes      | —       | The search query string.                                  |
| `limit`      | number  | no       | `10`    | Maximum number of results to return. Maximum value: `25`. |
| `safeSearch` | boolean | no       | `true`  | When `true`, filters adult content from results.          |

### Output

An array of result objects:

```ts
Array<{
  title: string; // page title
  url: string; // canonical URL
  description: string; // snippet / summary from the search backend
}>;
```

### Underlying approach

Uses a multi-backend search strategy with Brave as the primary backend and SearXNG as the fallback. The configured primary backend is tried first; if it fails, the remaining backend is attempted. Brave requires a `BRAVE_API_KEY`; SearXNG requires a `SEARXNG_BASE_URL` pointing to a running instance.

### Rate limits / caveats

- Brave API has a free tier with rate limits; check your plan for details.
- SearXNG results depend on the upstream engines configured in your instance.
- Maximum `limit` is capped at `25` regardless of the value passed.

### Example

```json
{
  "name": "web_search",
  "arguments": {
    "query": "typescript mcp server tutorial",
    "limit": 5,
    "safeSearch": true
  }
}
```

---

## `web_read`

Fetch a URL and extract the main article text, stripping navigation, ads, and other page chrome.

### Inputs

| Parameter | Type   | Required | Default | Description                                                   |
| --------- | ------ | -------- | ------- | ------------------------------------------------------------- |
| `url`     | string | yes      | —       | The full URL to fetch (must include scheme, e.g. `https://`). |

### Output

```ts
{
  title: string; // article or page title
  content: string; // cleaned HTML of the main content
  textContent: string; // plain-text version of the main content
  byline: string; // author line if detected
  siteName: string; // publication or site name if detected
  url: string; // the URL that was fetched
}
```

### Underlying approach

1. Fetches the raw HTML from the URL.
2. Parses it into a DOM using `jsdom`.
3. Passes the DOM to `@mozilla/readability` (Firefox Reader View), which identifies and extracts the primary content block.

### Rate limits / caveats

- Respects the target server's rate limits; no built-in retry logic.
- Some sites block headless requests (e.g. those requiring JavaScript rendering or behind Cloudflare).
- Paywalled content will not be accessible.
- Very large pages may be slow to parse.

### Example

```json
{
  "name": "web_read",
  "arguments": {
    "url": "https://modelcontextprotocol.io/introduction"
  }
}
```

---

## `github_repo`

Fetch metadata for a GitHub repository, optionally including its README.

### Inputs

| Parameter       | Type    | Required | Default | Description                                           |
| --------------- | ------- | -------- | ------- | ----------------------------------------------------- |
| `owner`         | string  | yes      | —       | GitHub username or organisation name.                 |
| `repo`          | string  | yes      | —       | Repository name.                                      |
| `includeReadme` | boolean | no       | `false` | When `true`, fetches and includes the README content. |

### Output

```ts
{
  name: string;             // repository name
  fullName: string;         // "owner/repo"
  description: string;      // repository description
  stars: number;            // stargazer count
  forks: number;            // fork count
  language: string;         // primary programming language
  license: string;          // SPDX license identifier
  topics: string[];         // repository topics / tags
  defaultBranch: string;    // e.g. "main" or "master"
  homepage: string;         // project homepage URL if set
  pushedAt: string;         // ISO 8601 timestamp of last push
  createdAt: string;        // ISO 8601 timestamp of creation
  latestRelease?: {         // present if a release exists
    tagName: string;
    name: string;
    publishedAt: string;
  };
  readme?: string;          // README content (only if includeReadme: true)
}
```

### Underlying approach

Calls the GitHub REST API (`api.github.com/repos/{owner}/{repo}`). No authentication is configured by default, so the unauthenticated rate limit applies. Setting a `GITHUB_TOKEN` environment variable (if supported by the implementation) raises this limit significantly.

### Rate limits / caveats

- Unauthenticated: 60 requests per hour per IP.
- Private repositories are not accessible without a token.
- README is fetched as a second API call when `includeReadme` is `true`.

### Example

```json
{
  "name": "github_repo",
  "arguments": {
    "owner": "anthropics",
    "repo": "anthropic-sdk-python",
    "includeReadme": true
  }
}
```

---

## `github_trending`

Scrape the GitHub trending page and return a ranked list of repositories.

### Inputs

| Parameter  | Type                                   | Required | Default   | Description                                                                               |
| ---------- | -------------------------------------- | -------- | --------- | ----------------------------------------------------------------------------------------- |
| `language` | string                                 | no       | `""`      | Filter by programming language (e.g. `"typescript"`). Empty string returns all languages. |
| `since`    | `"daily"` \| `"weekly"` \| `"monthly"` | no       | `"daily"` | Time window for trending calculation.                                                     |
| `limit`    | number                                 | no       | `25`      | Maximum number of repositories to return.                                                 |

### Output

An array of repository objects:

```ts
Array<{
  rank: number; // position on the trending list (1-based)
  owner: string; // repository owner
  repo: string; // repository name
  fullName: string; // "owner/repo"
  description: string; // repository description
  language: string; // primary programming language
  stars: number; // total stargazer count
  todayStars: number; // stars gained in the selected time window
  forks: number; // total fork count
  url: string; // full GitHub URL
}>;
```

### Underlying approach

Fetches `https://github.com/trending/{language}?since={since}` and parses the HTML with `cheerio`. GitHub does not provide an official trending API, so scraping is the only option.

### Rate limits / caveats

- GitHub may change the trending page HTML at any time, which could break parsing.
- GitHub may rate-limit or block frequent automated requests.
- The trending list is updated periodically by GitHub, not in real time.

### Example

```json
{
  "name": "github_trending",
  "arguments": {
    "language": "typescript",
    "since": "weekly",
    "limit": 10
  }
}
```

---

## `youtube_transcript`

Fetch the transcript (captions) for a YouTube video.

### Inputs

| Parameter  | Type   | Required | Default | Description                                                |
| ---------- | ------ | -------- | ------- | ---------------------------------------------------------- |
| `videoId`  | string | yes      | —       | YouTube video ID (e.g. `dQw4w9WgXcQ`) or full YouTube URL. |
| `language` | string | no       | `"en"`  | BCP-47 language code for the desired caption track.        |

### Output

```ts
{
  videoId: string;    // normalised video ID
  title?: string;     // video title if available
  transcript: Array<{
    text: string;     // caption text for this segment
    duration: number; // segment duration in seconds
    offset: number;   // start time offset in seconds from the beginning
  }>;
  fullText: string;   // all caption segments joined into a single string
}
```

### Underlying approach

Uses the `youtube-transcript` package, which fetches the caption track data directly from YouTube's internal caption endpoint. No YouTube Data API key is required.

### Rate limits / caveats

- Only works for videos that have captions available (auto-generated or manually uploaded).
- Videos with disabled captions or age-restricted videos may not return a transcript.
- YouTube may change internal endpoints, which could break the underlying package.
- If the requested language is not available, the tool may fall back to another language or return an error.

### Example

```json
{
  "name": "youtube_transcript",
  "arguments": {
    "videoId": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "language": "en"
  }
}
```

---

## `reddit_search`

Search Reddit posts using the public Reddit JSON API (no authentication required).

### Inputs

| Parameter   | Type                                                                | Required | Default       | Description                                                                                    |
| ----------- | ------------------------------------------------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `query`     | string                                                              | yes      | —             | Search query string.                                                                           |
| `subreddit` | string                                                              | no       | —             | Restrict search to a specific subreddit (omit `r/` prefix). Searches all of Reddit if omitted. |
| `sort`      | `"relevance"` \| `"hot"` \| `"top"` \| `"new"` \| `"comments"`      | no       | `"relevance"` | Sort order for results.                                                                        |
| `timeframe` | `"all"` \| `"year"` \| `"month"` \| `"week"` \| `"day"` \| `"hour"` | no       | `"all"`       | Time window filter. Only meaningful when `sort` is `"top"`.                                    |
| `limit`     | number                                                              | no       | `25`          | Maximum number of posts to return. Maximum value: `100`.                                       |

### Output

An array of post objects:

```ts
Array<{
  title: string; // post title
  url: string; // URL the post links to (may be a Reddit self-post URL)
  selftext: string; // body text for self (text) posts; empty for link posts
  score: number; // net upvote score
  numComments: number; // total comment count
  subreddit: string; // subreddit name (without "r/")
  author: string; // Reddit username of the poster
  createdUtc: number; // Unix timestamp (seconds) of post creation
  permalink: string; // relative Reddit permalink, e.g. "/r/sub/comments/abc/title/"
  isVideo: boolean; // true if the post contains a Reddit-hosted video
}>;
```

### Underlying approach

Routes through the shared Reddit transport in `src/tools/redditClient.ts`. By default calls Reddit's public `.json` API endpoint (`https://www.reddit.com/search.json` or `https://www.reddit.com/r/{subreddit}/search.json`). When both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are configured, requests are routed through `https://oauth.reddit.com` with a cached `client_credentials` bearer token instead. The `User-Agent` header is set to avoid Reddit's bot detection.

### Rate limits / caveats

- Unauthenticated public path is aggressively rate-limited per User-Agent (roughly 10 QPM in practice; Reddit's documented "60 QPM unauth" figure is no longer accurate as of 2023).
- OAuth path raises the quota to 100 QPM per OAuth `client_id`, averaged over a rolling 10-minute window.
- See `reddit_comments` below for the full Reddit OAuth env var setup; both tools share the same configuration and rate-limit tracker.
- Reddit may return fewer results than `limit` for some queries.
- Very new posts may not appear in search results immediately.
- Deleted or removed posts may appear in results with `[deleted]` or `[removed]` content.
- The `timeframe` parameter is only applied by Reddit when `sort` is `"top"`; it is ignored for other sort values.
- Maximum `limit` is capped at `100`.

### Example

```json
{
  "name": "reddit_search",
  "arguments": {
    "query": "model context protocol MCP",
    "subreddit": "MachineLearning",
    "sort": "top",
    "timeframe": "year",
    "limit": 10
  }
}
```

---

## `reddit_comments`

Fetch a Reddit post plus its comment tree as a single normalized payload. Accepts three mutually-exclusive locator forms and supports focused-subthread retrieval.

### Inputs

| Parameter   | Type                                                                           | Required                 | Default        | Description                                                                                                       |
| ----------- | ------------------------------------------------------------------------------ | ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `url`       | string                                                                         | one-of locator           | —              | Full Reddit post URL, e.g. `https://www.reddit.com/r/{sub}/comments/{id}/...`.                                    |
| `permalink` | string                                                                         | one-of locator           | —              | Relative Reddit permalink beginning with `/r/{sub}/comments/{id}`.                                                |
| `subreddit` | string                                                                         | with `article`           | —              | Subreddit name (without `r/`). Must be provided together with `article`.                                          |
| `article`   | string                                                                         | with `subreddit`         | —              | Post id without the `t3_` prefix. Must be provided together with `subreddit`.                                     |
| `comment`   | string                                                                         | no                       | —              | Comment id (without `t1_` prefix). When set, narrows retrieval to a focused subthread.                            |
| `context`   | number                                                                         | no (only with `comment`) | Reddit default | Number of parent (ancestor) context comments Reddit should include around `comment`. Integer `0..8`.              |
| `sort`      | `"confidence"` \| `"top"` \| `"new"` \| `"controversial"` \| `"old"` \| `"qa"` | no                       | `"confidence"` | Comment sort order.                                                                                               |
| `depth`     | number                                                                         | no                       | Reddit default | Maximum tree depth. Integer `1..10`.                                                                              |
| `limit`     | number                                                                         | no                       | Reddit default | Maximum number of comment nodes. Integer `1..100`.                                                                |
| `showMore`  | boolean                                                                        | no                       | `false`        | When `false`, `more` placeholders are omitted from `comments` and surfaced in the top-level `more` array instead. |

Exactly one locator form (`url`, `permalink`, or `subreddit`+`article`) must be supplied. `url` and `permalink` may include a trailing comment id; an explicit `comment` argument overrides any id parsed from the locator.

### Output

```ts
{
  post: {
    id: string;
    fullname: string;        // e.g. "t3_1abc23"
    title: string;
    selftext: string;
    author: string;
    subreddit: string;
    score: number;
    numComments: number;
    createdUtc: number;      // Unix seconds
    permalink: string;
    url: string;             // linked URL (for link posts) or self-post URL
    isVideo: boolean;
  };
  comments: Array<NormalizedComment | NormalizedMore>;   // nested tree
  more: NormalizedMore[];    // `more` placeholders omitted from `comments` when showMore=false
  request: {
    source: "url" | "permalink" | "subreddit_article";
    sort: "confidence" | "top" | "new" | "controversial" | "old" | "qa";
    depth: number | undefined;
    limit: number | undefined;
    comment: string | undefined;
    context: number | undefined;
    showMore: boolean;
    usedOAuth: boolean;      // true iff this request was routed via oauth.reddit.com
    permalink: string;
    url: string;
  };
}

type NormalizedComment = {
  id: string;
  fullname: string;          // e.g. "t1_xyz789"
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  permalink: string;
  parentId: string;          // e.g. "t3_..." or "t1_..."
  depth: number;
  replies: Array<NormalizedComment | NormalizedMore>;
  distinguished: string | null;
  stickied: boolean;
  collapsed: boolean;
};

type NormalizedMore = {
  id: string;
  parentId: string;
  depth: number;
  count: number;
  children: string[];        // comment ids referenced by this placeholder
};
```

### Underlying approach

Uses the shared Reddit transport in `src/tools/redditClient.ts`:

- When neither `REDDIT_CLIENT_ID` nor `REDDIT_CLIENT_SECRET` is set, fetches `https://www.reddit.com/r/{sub}/comments/{id}.json` (public JSON API).
- When both are set, fetches `https://oauth.reddit.com/r/{sub}/comments/{id}` with `Authorization: bearer <token>`, using a `client_credentials` app-only token acquired from `https://www.reddit.com/api/v1/access_token`. Tokens are cached in memory and refreshed on expiry or 401.
- `request.usedOAuth` in the output reflects which transport actually served the request.

### Error codes

| Code               | When                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | Mixed or missing locator, out-of-range numeric, `context` without `comment`, or partial OAuth config (one of `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` set without the other). |
| `RATE_LIMIT`       | Reddit returned 429, or the in-process rate-limit tracker blocks the request.                                                                                                    |
| `UNAVAILABLE`      | Reddit returned 403 (private / quarantined / banned subreddit), 404 (thread not found), or another non-OK status.                                                                |
| `TIMEOUT`          | Request exceeded the 30s timeout.                                                                                                                                                |

### Rate limits / caveats

- Unauthenticated public path: ~10 QPM (Reddit's unauth quota; bot-detected clients may get less).
- OAuth (`client_credentials`) path: 100 QPM per app.
- v1 does not call `/api/morechildren`. `showMore` only controls whether existing `more` placeholders are preserved in the returned tree.
- `depth`, `limit`, and `context` are forwarded to Reddit; omitting them lets Reddit apply its own defaults.
- Deleted or removed comments surface with `[deleted]` / `[removed]` bodies and authors.

### Configuration

| Environment variable   | Required | Description                                                                                                                                                               |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDDIT_CLIENT_ID`     | optional | Reddit app client id. Pair with `REDDIT_CLIENT_SECRET` to enable OAuth.                                                                                                   |
| `REDDIT_CLIENT_SECRET` | optional | Reddit app client secret. Pair with `REDDIT_CLIENT_ID` to enable OAuth.                                                                                                   |
| `REDDIT_USER_AGENT`    | optional | Custom `User-Agent`. Should follow Reddit's required format `<platform>:<app-id>:<version> (by /u/<username>)`. See `docs/plans/2026-04-18-reddit-api-reference.md` §4.8. |

Setting exactly one of `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` is treated as invalid configuration: the server still starts, `health_check` reports the `reddit_oauth` entry as `degraded`, and `reddit_comments` / `reddit_search` calls throw `VALIDATION_ERROR` until the other credential is supplied or both are unset.

### Example

```json
{
  "name": "reddit_comments",
  "arguments": {
    "url": "https://www.reddit.com/r/MachineLearning/comments/1abc23/example_post/",
    "sort": "top",
    "depth": 4,
    "limit": 50,
    "showMore": false
  }
}
```
