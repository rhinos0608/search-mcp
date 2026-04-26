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
  elements?: ContentElement[]; // typed headings, text, tables, images, code, lists
  truncatedElements?: true; // present when element finalization omitted candidates
  originalElementCount?: number; // candidate count before finalization
  omittedElementCount?: number; // number of candidates omitted by finalization
}
```

`text`, `code`, and `table` elements may include `truncated: true` and `originalLength`
when their payload field was shortened.

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

## `semantic_github_code`

Search a GitHub repository with code-aware retrieval. This tool is optimized for source-code questions such as “find `handleSubmit`”, “where is retry logic implemented?”, or “show the function that formats job listings”.

### Inputs

| Parameter        | Type                                                                                                         | Required | Default           | Description                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `query`          | string                                                                                                       | yes      | —                 | Identifier, symbol, or behavior to search for.                                             |
| `repo`           | string                                                                                                       | yes      | —                 | Repository in `owner/repo` form.                                                           |
| `ref`            | string                                                                                                       | no       | default branch    | Git branch, tag, or commit SHA.                                                            |
| `language`       | `"typescript" \| "javascript" \| "python" \| "go" \| "rust" \| "markdown" \| "shell"`                        | no       | —                 | Optional language filter.                                                                  |
| `maxFiles`       | number                                                                                                       | no       | `100`             | Maximum files to collect before chunking. Maximum value: `500`.                            |
| `maxFileBytes`   | number                                                                                                       | no       | `50000`           | Maximum bytes to fetch per GitHub file before truncation. Maximum value: `500000`.         |
| `fileFilter`     | string[]                                                                                                     | no       | —                 | Path prefixes, substrings, or `*` globs to keep after collection.                          |
| `topK`           | number                                                                                                       | no       | `10`              | Number of code results to return. Maximum value: `50`.                                     |
| `profile`        | `"balanced" \| "lexical-heavy" \| "semantic-heavy" \| "high-precision" \| "fast" \| "precision" \| "recall"` | no       | `"lexical-heavy"` | Retrieval profile. Code defaults to lexical-heavy so identifier matches carry more weight. |
| `includeContext` | boolean                                                                                                      | no       | `false`           | Include source text in each result. When false, only metadata and scores are returned.     |
| `debug`          | boolean                                                                                                      | no       | `false`           | Include collected-file and chunk counts.                                                   |

### Output

```ts
{
  query: string;
  repo: string;
  profile: RetrievalProfileName;
  results: Array<{
    rank: number;
    score: {
      fused: number;
      lexical?: number;
      vector?: number;
      rerank?: number;
    };
    path: string;
    url: string;
    language: string;
    startLine?: number;
    endLine?: number;
    symbolName?: string;
    symbolKind?: string;
    signature?: string;
    docstring?: string;
    section: string;
    text?: string; // only when includeContext=true
  }>;
  warnings: string[];
  debug?: {
    collectedFiles: number;
    chunkCount: number;
  };
}
```

### Underlying approach

1. Parses `repo` and collects matching files through the existing GitHub corpus collector.
2. Applies language and path filters, preserving existing GitHub discovery tools unchanged.
3. Parses supported source files with lazy-loaded tree-sitter WASM grammars for TypeScript, JavaScript, Python, Go, and Rust.
4. Chunks by symbol boundaries first: functions, methods, classes, structs, impls, and arrow-function constants.
5. Attaches code metadata such as path, language, line range, symbol name, symbol kind, signature, imports, and docstring.
6. Ranks chunks through the shared RAG pipeline using `lexical-heavy` by default.

### Rate limits / caveats

- GitHub API rate limits apply. Set `GITHUB_TOKEN` for higher quota and private repository access where supported.
- Broad repository scans emit warnings. Add `query`, `language`, or `fileFilter` to avoid drifting into examples or generated files.
- The collector enforces file and byte caps and excludes common generated/vendor directories. `.gitignore` rules are parsed when available by the collector path.
- `maxFileBytes` defaults to 50KB to keep single-file GitHub fetches bounded; raise it when you need larger files, up to 500KB.
- `EMBEDDING_CODE_MODEL` is optional but recommended. When it is missing, the tool warns that code retrieval is falling back to the prose embedding model. Identifier-heavy searches still work well through BM25/`lexical-heavy`, but conceptual code queries may degrade.
- Unsupported or unparsable files fall back to text-style chunking rather than failing the whole request.

### Example

```json
{
  "name": "semantic_github_code",
  "arguments": {
    "repo": "modelcontextprotocol/typescript-sdk",
    "query": "handle tool call validation",
    "language": "typescript",
    "fileFilter": ["src/"],
    "topK": 5,
    "includeContext": true
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

---

## `semantic_youtube`

Search YouTube videos, fetch their transcripts, and return the most semantically relevant transcript passages for a query.

### Inputs

| Parameter            | Type                                                    | Required | Default       | Description                                                                |
| -------------------- | ------------------------------------------------------- | -------- | ------------- | -------------------------------------------------------------------------- |
| `query`              | string                                                  | yes      | —             | Semantic search query.                                                     |
| `maxVideos`          | number                                                  | no       | `20`          | Maximum number of videos to fetch. Maximum value: `50`.                    |
| `channel`            | string                                                  | no       | —             | Restrict results to channels whose name contains this string.              |
| `sort`               | `"relevance"` \| `"date"` \| `"viewCount"`              | no       | `"relevance"` | YouTube search sort order.                                                 |
| `transcriptLanguage` | string                                                  | no       | `"en"`        | BCP-47 language code for transcript captions.                              |
| `profile`            | `"balanced"` \| `"fast"` \| `"precision"` \| `"recall"` | no       | `"balanced"`  | Retrieval profile.                                                         |
| `topK`               | number                                                  | no       | `10`          | Number of semantically relevant transcript passages to return.             |
| `maxBytes`           | number                                                  | no       | `250000000`   | Maximum total transcript corpus size in bytes. Maximum value: `250000000`. |

### Output

Returns a retrieval response with additional metadata. The MCP tool response keeps the ranked `results` and a compact `corpus` summary; the full chunk corpus stays internal so responses remain under transport size limits.

```ts
{
  results: Array<...>;
  corpus: {
    id: string;
    status: 'ready' | 'empty' | 'partial' | 'error';
    adapter: 'transcript';
    documentCount: number;
    chunkCount: number;
    embeddingCount: number;
    model?: string;
    modelRevision?: string;
    dimensions?: number;
  };
  videoCount: number;
  failedTranscripts: number;
  warnings?: string[];
}
```

### Underlying approach

1. Search YouTube for candidate videos.
2. Fetch transcripts with bounded concurrency.
3. Group adjacent transcript captions into contextual chunks and embed them through the shared RAG pipeline.
4. Apply dense + lexical retrieval, then trim to `topK`.
5. Return a compact corpus summary instead of the full internal corpus payload.

### Rate limits / caveats

- Requires `YOUTUBE_API_KEY` and `EMBEDDING_SIDECAR_BASE_URL`.
- The corpus budget is capped at 250MB by default so the tool can safely process large transcripts.
- Transcript failures are tolerated; successful videos still contribute chunks.
- Captions are grouped into contextual windows before embedding, so results are less fragmented than one-caption-at-a-time retrieval.

---

## `semantic_reddit`

Search Reddit posts, fetch their comment trees, and return the most semantically relevant comment passages for a query.

### Inputs

| Parameter      | Type                                                                | Required | Default       | Description                                                                            |
| -------------- | ------------------------------------------------------------------- | -------- | ------------- | -------------------------------------------------------------------------------------- |
| `query`        | string                                                              | yes      | —             | Semantic search query.                                                                 |
| `subreddit`    | string                                                              | no       | —             | Restrict search to a subreddit.                                                        |
| `sort`         | `"relevance"` \| `"hot"` \| `"new"` \| `"top"`                      | no       | `"relevance"` | Reddit search sort order.                                                              |
| `timeframe`    | `"hour"` \| `"day"` \| `"week"` \| `"month"` \| `"year"` \| `"all"` | no       | `"year"`      | Time filter for search.                                                                |
| `maxPosts`     | number                                                              | no       | `10`          | Maximum number of posts to fetch comments for. Maximum value: `25`.                    |
| `commentLimit` | number                                                              | no       | `100`         | Maximum comments to fetch per post. Maximum value: `100` (matches the Reddit API cap). |
| `profile`      | `"balanced"` \| `"fast"` \| `"precision"` \| `"recall"`             | no       | `"balanced"`  | Retrieval profile.                                                                     |
| `topK`         | number                                                              | no       | `10`          | Number of semantically relevant comment passages to return.                            |
| `maxBytes`     | number                                                              | no       | `250000000`   | Maximum total comment corpus size in bytes. Maximum value: `250000000`.                |

### Output

Returns a retrieval response with additional metadata. The MCP tool response keeps the ranked `results` and a compact `corpus` summary; the full chunk corpus stays internal so responses remain under transport size limits.

```ts
{
  results: Array<...>;
  corpus: {
    id: string;
    status: 'ready' | 'empty' | 'partial' | 'error';
    adapter: 'conversation';
    documentCount: number;
    chunkCount: number;
    embeddingCount: number;
    model?: string;
    modelRevision?: string;
    dimensions?: number;
  };
  postCount: number;
  failedPosts: number;
  warnings?: string[];
}
```

### Underlying approach

1. Search Reddit for candidate posts.
2. Fetch comment trees with bounded concurrency.
3. Flatten comments through the shared conversation adapter.
4. Embed chunks and run the shared RAG pipeline.
5. Trim to `topK` after retrieval.
6. Return a compact corpus summary instead of the full internal corpus payload.

Note: `commentLimit` is capped at `100` to match the Reddit API's per-request comment limit.

### Rate limits / caveats

- Requires `EMBEDDING_SIDECAR_BASE_URL`.
- Deleted and removed comments are filtered before embedding.
- The corpus budget is capped at 250MB by default to support large threads.

---

## `semantic_crawl`

Crawl a URL or corpus source and return the most semantically relevant passages for a query.

### Inputs

| Parameter               | Type               | Required | Default     | Description                                                            |
| ----------------------- | ------------------ | -------- | ----------- | ---------------------------------------------------------------------- |
| `source`                | object             | yes      | —           | Crawl source (`url`, `sitemap`, `search`, `github`, or `cached`).      |
| `query`                 | string             | yes      | —           | Semantic search query.                                                 |
| `topK`                  | number             | no       | `10`        | Number of passages to return.                                          |
| `strategy`              | `"bfs"` \| `"dfs"` | no       | `"bfs"`     | Crawl strategy.                                                        |
| `maxDepth`              | number             | no       | `2`         | Maximum crawl depth.                                                   |
| `maxPages`              | number             | no       | `20`        | Maximum pages to crawl.                                                |
| `includeExternalLinks`  | boolean            | no       | `false`     | Follow external links.                                                 |
| `maxBytes`              | number             | no       | `250000000` | Maximum total source corpus size in bytes. Maximum value: `250000000`. |
| `useReranker`           | boolean            | no       | `false`     | Apply cross-encoder re-ranking to top candidates.                      |
| `allowPathDrift`        | boolean            | no       | `false`     | Allow links outside the seed URL path.                                 |
| `extractionConfig`      | object             | no       | —           | Structured extraction config forwarded to crawl4ai.                    |
| `waitFor`               | string             | no       | —           | CSS selector or JS predicate to wait for before extraction.            |
| `delayBeforeReturnHtml` | number             | no       | `0.1`       | Extra seconds to wait for dynamic content to settle.                   |
| `pageTimeout`           | number             | no       | `60000`     | Page timeout in milliseconds.                                          |
| `jsCode`                | string             | no       | —           | Custom JavaScript to run before extraction.                            |

### Underlying approach

Crawls pages, chunks them, embeds them through the shared sidecar, and ranks passages with dense + lexical retrieval. Optional cross-encoder re-ranking can be enabled with `useReranker`.

**Response-size protection:** To prevent MCP response limit errors, `semantic_crawl` implements a two-layer size guard:

1. **Preflight guard:** Before crawling, estimates the total response size using site-aware heuristics (JS-heavy sites like job boards produce larger payloads). If the estimated size would exceed the safe budget (~41MB), `maxPages` is automatically capped to a safe level and a `SEMANTIC_CRAWL_RESPONSE_SIZE_GUARD` warning is emitted.

2. **In-flight accumulator:** During crawling, accumulates the actual serialized byte count of each page. If adding another page would exceed the safe budget, the accumulator stops and returns the pages collected so far, plus `SEMANTIC_CRAWL_RESPONSE_SIZE_LIMIT_APPROACHED` warning and an `omittedPages` list detailing which URLs were skipped.

### Output fields

In addition to the ranked `chunks`, the response may include:

- `omittedPages?: Array<{ url: string; reason: string; estimatedBytes?: number }>` — Pages that were skipped due to response-size limits.
- `structuredWarnings?: Array<{ code: string; message: string; ... }>` — Machine-readable warnings including size-guard events.

### Rate limits / caveats

- Requires `CRAWL4AI_BASE_URL` and `EMBEDDING_SIDECAR_BASE_URL`.
- The corpus budget is capped at 250MB by default.
- **Response-size guard:** Large crawls may return fewer pages than requested if the response would exceed MCP size limits (~52MB). Check `omittedPages` and `structuredWarnings` in the response.
- Cached corpus IDs are retained for at least 24 hours and are refreshed on access; re-run the original crawl if a corpus has been evicted.
- Broad GitHub crawls are de-prioritized toward core source directories, but the best results still come from providing a query pre-filter.
- SSRF protection still applies to fetched seed URLs and discovered pages.
- If crawl4ai returns shell/placeholder content (for example `Loading...`), the crawler automatically retries once with a more aggressive render profile before indexing; successful recoveries may be reported in `meta.warnings`.

---

## `web_crawl`

Crawl a URL using a headless Playwright browser via the Crawl4AI sidecar. Handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. Returns clean LLM-ready Markdown plus raw HTML for each crawled page.

### Inputs

| Parameter               | Type               | Required | Default | Description                                                                                                        |
| ----------------------- | ------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `url`                   | string (URL)       | yes      | —       | Seed URL to start crawling from.                                                                                   |
| `strategy`              | `"bfs"` \| `"dfs"` | no       | `"bfs"` | Crawl strategy: `bfs` (breadth-first, wide coverage) or `dfs` (depth-first, deep nesting).                         |
| `maxDepth`              | number (1–5)       | no       | `1`     | Maximum link depth to follow from seed URL (1 = single page only).                                                 |
| `maxPages`              | number (1–100)     | no       | `1`     | Maximum number of pages to crawl.                                                                                  |
| `includeExternalLinks`  | boolean            | no       | `false` | Follow links to external domains.                                                                                  |
| `extractionConfig`      | object             | no       | —       | Structured extraction config (css_schema, xpath_schema, regex, or llm strategy). Requires Crawl4AI sidecar v0.8.x. |
| `waitFor`               | string             | no       | —       | CSS selector or JS predicate to wait for before extracting.                                                        |
| `delayBeforeReturnHtml` | number (0–30)      | no       | `0.1`   | Extra seconds to wait after page load for dynamic content to settle.                                               |
| `pageTimeout`           | number (ms)        | no       | `60000` | Per-page operation timeout in milliseconds.                                                                        |
| `jsCode`                | string             | no       | —       | Custom JavaScript to execute on the page (e.g. scroll to bottom, click "Load More").                               |

### Underlying approach

Each page is fetched via Playwright through the Crawl4AI sidecar. The sidecar returns three HTML variants: `fit_html` (content-focused), `cleaned_html` (sanitized), and `html` (full DOM). The tool uses the first non-empty variant in that order and populates the `html` field on each result page. Markdown is always returned as the primary content field.

**Timeout scaling:** The outer HTTP timeout scales with `maxPages` to prevent premature cancellation of large crawls: `min(30,000 + maxPages × 15,000, 300,000)` ms. A single-page crawl times out at 45s; a 10-page crawl at 180s; 25+ pages cap at 300s (5 minutes).

### Output

Returns a `WebCrawlResult` with:

- `pages` — array of `CrawlPageResult` objects, each with `url`, `success`, `markdown`, `html?`, `title`, `description`, `links`, `statusCode`, `errorMessage`
- `totalPages` — pages attempted
- `successfulPages` — pages successfully fetched
- `warnings?` — any non-fatal issues

### Rate limits / caveats

- Requires `CRAWL4AI_BASE_URL` (self-hosted Docker sidecar).
- JS-heavy sites (job boards, SPAs) produce larger HTML payloads — the `html` field can be several MB per page.
- SSRF protection applies to all fetched URLs.

---

## `semantic_jobs`

Search for job listings across job boards (SEEK, Indeed, Jora), extract structured fields from HTML, apply constraint filters, rank with weighted composite scoring, and return structured job results.

### Inputs

| Parameter       | Type                               | Required | Default | Description                                                                           |
| --------------- | ---------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `query`         | string                             | yes      | —       | Job search query (e.g. `"frontend developer"`, `"data entry admin"`).                 |
| `location`      | string[]                           | no       | —       | Preferred locations (e.g. `["Sydney", "Melbourne"]`). Ranking boost, not hard filter. |
| `workMode`      | `("remote"\|"hybrid"\|"onsite")`[] | no       | —       | Preferred work modes. Ranking boost, not hard filter.                                 |
| `maxSalary`     | number                             | no       | —       | Maximum annual salary. Listings with a parseable salary above this are excluded.      |
| `excludeTitles` | string[]                           | no       | —       | Title keywords to exclude (e.g. `["senior", "manager"]`).                             |
| `maxPages`      | number (1–50)                      | no       | `20`    | Maximum job listing pages to crawl.                                                   |
| `topK`          | number (1–50)                      | no       | `10`    | Number of top-ranked job listings to return.                                          |
| `maxBytes`      | number                             | no       | `250MB` | Maximum total bytes of listing text to embed.                                         |

### Underlying approach

1. **Discovery:** Issues web searches against SEEK, Indeed, and Jora using the query. Returns result URLs.
2. **Crawl:** Fetches each listing page via the Crawl4AI sidecar. Uses the HTML field (not markdown) for structured extraction.
3. **Extraction:** Parses HTML with Cheerio. Extracts `<script type="application/ld+json">` structured data first, then falls back to CSS selectors for title, company, location, salary, and work mode. Requires Crawl4AI v0.8.x for HTML delivery; older versions produce a `"markdown only"` warning.
4. **Deduplication:** Three-layer dedup — exact URL → source+jobId → company+title normalization.
5. **Constraint filtering:** Hard filters (`maxSalary`, `excludeTitles`) applied before ranking.
6. **Ranking:** Weighted composite score: semantic 0.45, location 0.20, workMode 0.15, recency 0.10, completeness 0.10.
7. **Return:** Top-K `JobListingMvp` objects with confidence scores, verification status, and caveats.

### Output fields

Each result is a `JobListingMvp` with: `title`, `company?`, `location?`, `workMode`, `salaryRaw?`, `source`, `sourceUrl?`, `jobId?`, `postedRaw?`, `caveats[]`, `confidence` (per-field 0–1 scores), `verificationStatus` (`listing_page_fetched` | `search_result_only` | `aggregator_result` | `needs_manual_check`).

### Rate limits / caveats

- Requires `EMBEDDING_SIDECAR_BASE_URL` for semantic ranking; falls back to constraint-only ranking without it.
- Requires a search backend (`BRAVE_API_KEY` or `SEARXNG_BASE_URL`).
- HTML extraction requires Crawl4AI sidecar v0.8.x or later. Older versions deliver markdown only — structured field extraction will be degraded and a warning is emitted.
- Indeed returns heavily JS-rendered pages; extraction reliability is lower than SEEK or Jora.
- LinkedIn is not included (auth-wall risk is too high for reliable crawl).

---
