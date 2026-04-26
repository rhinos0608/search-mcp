**File:** `/Users/rhinesharar/search-mcp/context.md`

---

## 1. Server‑level Architecture  

| File | Role | Key exports / functions |
|------|------|------------------------|
| **src/server.ts** | Main HTTP server (Fastify). Sets up routes, applies global middlewares (CORS, rate‑limit, health, logging), registers the *tool router* (`/tools/:toolName`). Starts the server on `PORT`. | `createServer()`, `start()`. |
| **src/index.ts** | Entry point used by the CLI (`npm start`). Imports `createServer` and calls `listen()`. Handles graceful shutdown, loads **config** and **logger**. |
| **src/config.ts** | Centralised env‑var handling (via `zod`). Exposes a strongly‑typed `config` object used everywhere. Controls: server port, LLM provider, embedding model path, API keys for external services, database paths, safety limits, crawl budget, etc. |
| **src/health.ts** | Implements the `/health` endpoint. Returns JSON with version, uptime, DB connection status, and a quick *search‑engine ping* (e.g., Brave / SearXNG). Used by `test/crawl4aiHealth.test.ts`. |

**Pattern:** Dependency injection via the single `config` object; Fastify plugins for request‑level guards (`httpGuards.ts`) and rate‑limiting (`rateLimit.ts`). All tool implementations are plain functions that receive a validated request payload and return a typed `ToolResponse` (see `src/types.ts`).

---

## 2. All Registered Tools  

The server discovers tools from `src/tools/*.ts`. Each file exports a **tool definition**:

```ts
export const TOOL_NAME = {
  name: 'tool_name',
  description: 'Human‑readable description',
  inputSchema: z.object({ ... }),      // Zod schema for JSON payload
  handler: async (input, ctx) => {...}, // core implementation
  // optional fields:
  requiresAuth?: boolean,
  rateLimitKey?: string,
  backendInfo?: { type: 'search'|'embedding'|'repo', ... }
}
```

Below is the complete catalogue (alphabetical). The *backend* column denotes the external service or local component used.

| Tool | Purpose | Input schema (high‑level) | Backend / API keys |
|------|---------|--------------------------|--------------------|
| **academicSearch** | Search scholarly articles (Semantic Scholar style) | `query:string`, `page?:number` | Uses **S2 API** – requires `ACADEMIC_API_KEY` (optional, fallback to public). |
| **arxivSearch** | Search arXiv pre‑prints | `query:string`, `maxResults?:number` | Public HTTP to arXiv OAI; no key. |
| **braveSearch** | General web search (Brave) | `query:string`, `region?:string` | `BRAVE_API_KEY` required. |
| **exaSearch** | Fast web search (EXA) | `query:string`, `highlight?:boolean` | `EXA_API_KEY`. |
| **githubRepo** | Fetch public repo metadata (owner, description, stars…) | `owner:string`, `repo:string` | Uses **GitHub REST** – optional `GITHUB_TOKEN`. |
| **githubRepoFile** | Retrieve a single file from a repo (raw content) | `owner:string`, `repo:string`, `path:string`, `ref?:string` | GitHub API – needs `GITHUB_TOKEN` for private repos; public works without. |
| **githubRepoSearch** | Code search across a repo (via GitHub search API) | `owner:string`, `repo:string`, `query:string` | `GITHUB_TOKEN`. |
| **githubRepoTree** | List repo file‑tree (recursive) | `owner:string`, `repo:string`, `ref?:string` | `GITHUB_TOKEN` optional. |
| **githubTrending** | Trending repos on GitHub | `language?:string`, `since?:'daily'|'weekly'|'monthly'` | Public endpoint – no key. |
| **hackernewsSearch** | Search HN posts (Algolia) | `query:string`, `hitsPerPage?:number` | No key (Algolia public). |
| **newsSearch** | General news search (NewsAPI) | `query:string`, `language?:string` | `NEWS_API_KEY`. |
| **npmSearch** | Search NPM packages | `query:string` | Public endpoint – no key. |
| **patentSearch** | Search USPTO/Google Patents | `query:string` | Public web scrape – no key. |
| **podcastSearch** | Search podcasts (ListenNotes) | `query:string`, `type?:'episode'|'podcast'` | `LISTEN_NOTES_KEY`. |
| **producthuntSearch** | Search Product Hunt posts | `query:string` | `PRODUCT_HUNT_TOKEN`. |
| **pypiSearch** | Search Python packages | `query:string` | Public – no key. |
| **redditAuth** | Exchange Reddit OAuth code for access token (helper) | `code:string`, `redirect_uri:string` | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`. |
| **redditClient** | Low‑level wrapper around Reddit API (GET/POST) | `endpoint:string`, `params?:object` | Same Reddit OAuth creds. |
| **redditComments** | Pull comment tree for a Reddit submission (can use OAuth or public JSON). | `url:string`, `useOAuth?:boolean` | If OAuth: needs Reddit token; otherwise public JSON works for most subreddits. |
| **redditPermalink** | Resolve a Reddit permalink to full post JSON | `permalink:string` | Public JSON endpoint – no key. |
| **redditSearch** | Search Reddit submissions | `query:string`, `subreddit?:string`, `sort?:string` | OAuth optional – higher rate limits with token. |
| **redditSearchParser** | Helper that normalises Reddit search results (internal). | N/A (used by redditSearch). |
| **redditThreadParser** | Normalises comment/thread trees. | N/A (internal). |
| **searxngSearch** | Search via a self‑hosted SearXNG instance | `query:string`, `instanceUrl:string` | No key; instance supplied by user. |
| **semanticCrawl** | Crawl arbitrary web pages, chunk, embed **locally** (uses **sentence‑transformers** model), store chunks in an **SQLite corpus cache**. | `urls:string[]`, `budget?:number` | No external key – all embeddings are local (`EMBEDDING_MODEL_PATH`). |
| **semanticGitHubCode** | Crawl a GitHub repo (source code) with local embeddings. | `owner:string`, `repo:string`, `branch?:string` | No external key – uses the same local model. |
| **semanticJobs** | Search/parse job postings from job boards, embed locally and rank. | `query:string`, `board?:string[]` | No external key. |
| **semanticReddit** | Crawl Reddit threads, embed locally; respects Reddit OAuth for private subreddits. | `subreddits:string[]`, `maxPosts?:number` | Optionally requires Reddit OAuth. |
| **semanticYoutube** | Grab YouTube video transcripts (via YouTube Data API, then embed locally). | `videoIds:string[]` | `YOUTUBE_API_KEY`. |
| **stackoverflowSearch** | Search StackOverflow via StackExchange API. | `query:string`, `tags?:string[]` | `STACKEXCHANGE_KEY` (optional). |
| **twitterSearch** | Search recent tweets (Twitter V2 API). | `query:string`, `maxResults?:number` | `TWITTER_BEARER_TOKEN`. |
| **webCrawl** | Generic web crawler → extracts main content, strips cookie‑banners, respects robots.txt, produces **Markdown**. | `urls:string[]`, `budget?:number` | No external key, but may call external **webRead** for each URL. |
| **webRead** | Low‑level fetcher + HTML sanitiser; applies extraction configs, SSRF guard. | `url:string` | No key. |
| **webSearch** | General web search (fallback to Brave/SEARXNG). | `query:string` | Uses whatever search tool is configured (e.g., Brave). |
| **youtubeSearch** | Search YouTube videos (YouTube Data API). | `query:string`, `maxResults?:number` | `YOUTUBE_API_KEY`. |
| **youtubeTranscript** | Retrieve transcript for a single video (YouTube API). | `videoId:string` | `YOUTUBE_API_KEY`. |

*All tools follow the same contract: a validated JSON payload → a **ToolResponse** that contains `output`, optional `metadata`, and possible `error` fields.*

---

## 3. RAG Pipeline (`src/rag/`)  

| Module | Purpose | Important Functions / Types |
|--------|---------|-----------------------------|
| **pipeline.ts** | Orchestrates end‑to‑end retrieval‑augmented generation. `runPipeline(request)` runs: *fetch → chunk → embed → BM25 → fusion → rerank → profile‑based post‑processing*. Returns `RagResult`. |
| **chunking.ts** (high‑level) | Chooses a chunker based on **profile** (code, text, transcript, job). Calls `chunkMarkdown` (see `src/chunking.ts`) or `chunkCode`. |
| **embedding.ts** | Wraps **local sentence‑transformers** model (ONNX). `embedTexts(texts)` returns float32 vectors. Model path from `config.EMBEDDING_MODEL_PATH`. Supports batching. |
| **bm25.ts** | Classic BM25 over tokenised chunks (uses `utils/bm25.ts`). Provides `bm25Search(query, chunks, k1, b)`. |
| **fusion.ts** | Implements **reciprocal rank fusion** (`rrf`) and **weighted linear fusion** between BM25 scores and embedding similarity (`cosine`). |
| **rerank.ts** | Optional LLM reranker (`utils/rerank.ts`) that calls the configured LLM endpoint (OpenAI / Azure / local). |
| **profiles.ts** | Declares retrieval profiles: `text`, `code`, `conversation`, `job`, `transcript`. Each profile defines: *chunk size, overlap, token limit, ranking weights*. |
| **jobDedup.ts / jobRanking.ts** | Specialized post‑processing for job postings: de‑duplicate similar offers and re‑score based on seniority, location, salary regex. |
| **lexicalConstraint.ts** | Allows a profile to enforce lexical constraints (e.g., must contain certain keywords). |
| **sources/** | Helpers for fetching source material (web, GitHub, YouTube). Used by `semantic*` tools before they hand data to the pipeline. |
| **types/** | Strongly typed interfaces (`RagChunk`, `Embedding`, `RagResult`, `ProfileConfig`). |

**Key flow (simplified):**

1. **Fetch** → `semanticCrawl` or `webRead` produces raw markdown.
2. **Chunk** → `chunkMarkdown` (or language‑specific splitter) yields `RagChunk`s with metadata (`sourceUrl`, `lineStart`, `lineEnd`).
3. **Embed** → `embedTexts` → vector store (in‑memory for the request).
4. **BM25** → lexical scoring on tokenised markdown.
5. **Fusion** → `rrfFusion(bm25Scores, embeddingScores)`.
6. **Rerank** (optional) → pass top‑k chunks to LLM for relevance scoring.
7. **Profile‑adjust** → apply `lexicalConstraint`, `jobDedup`, etc.
8. **Return** → `chunks` + overall `score` + `profileUsed`.

---

## 4. Semantic Tools  

| Tool | Core Steps |
|------|------------|
| **semanticCrawl** | 1️⃣ Accept list of URLs & optional budget. 2️⃣ Uses **webCrawl.ts** → extracts main content as markdown (removes navigation, cookie banners) 3️⃣ Calls **chunkMarkdown** → produces chunks 4️⃣ Runs **embedding.ts** (local model) 5️⃣ Persists chunks in **SQLite corpusCache** (`src/rag/corpusCache.ts`) keyed by URL+hash; on repeat calls it loads from cache, avoiding re‑embedding. |
| **semanticGitHubCode** | 1️⃣ Clone (shallow) the repo via GitHub REST tree API (`utils/githubCorpus.ts`). 2️⃣ Walk files, filter by language via `rag/code/languages.ts`. 3️⃣ Chunk each source file with the **code chunker** (`rag/code/treeSitter.ts` + `src/chunking.ts`). 4️⃣ Local embed + store in corpus cache (same DB). |
| **semanticJobs** | 1️⃣ Hit various job‑board APIs (Indeed, LinkedIn – via public RSS/JSON). 2️⃣ Normalise postings, run **jobSources.ts** to fetch full description. 3️⃣ Chunk (plain text) and embed. 4️⃣ Post‑process with `jobDedup.ts` & `jobRanking.ts`. |
| **semanticReddit** | 1️⃣ For each subreddit, fetch recent submissions via Reddit API (OAuth optional). 2️⃣ For each submission, call **redditComments** → retrieve full comment tree. 3️⃣ Convert HTML/markdown → `chunkMarkdown`. 4️⃣ Embed locally, store in corpus cache. |
| **semanticYoutube** | 1️⃣ Call YouTube Data API to get captions (`youtubeTranscript.ts`). 2️⃣ Split transcript into speaker‑wise or time‑wise chunks (`rag/adapters/transcript.ts`). 3️⃣ Embed locally and cache. |

All semantic tools **avoid external vector DBs** – they rely on the in‑process embedding model and a lightweight SQLite cache for persistence across requests.

---

## 5. GitHub Tools  

| Tool | What it does | Backend |
|------|--------------|---------|
| **githubRepo** | GET `/repos/:owner/:repo` → returns `RepoMeta` (stars, description, default branch). | GitHub REST (`/repos`). |
| **githubRepoFile** | GET raw file content (`/repos/:owner/:repo/contents/:path?ref=`). Handles base64 decode, returns plain text. | GitHub REST `contents` endpoint. |
| **githubRepoTree** | Recursive tree (`/git/trees/:sha?recursive=1`). Returns list of file paths, sizes, types. | GitHub REST `trees`. |
| **githubRepoSearch** | Code search limited to one repo (`/search/code?q=repo:owner/repo+<query>`). Returns matches (file, snippet). | GitHub Search API (requires token for higher rate). |
| **githubTrending** | Scrapes GitHub Trending page (HTML → markdown) – no API key needed. Uses **webRead** internally. |

All tools use `src/utils/githubCorpus.ts` for token‑budgeting when crawling many files.

---

## 6. Reddit Tools  

| Tool | OAuth vs Public | Details |
|------|----------------|---------|
| **redditSearch** | If `config.REDDIT_CLIENT_ID`/`SECRET` present → OAuth bearer token (higher limits). Otherwise uses public **json** endpoint (`https://www.reddit.com/search.json`). | Normalises with `redditSearchParser.ts`. |
| **redditComments** | Parameter `useOAuth?: boolean`. When true → uses OAuth token; else public JSON (`https://www.reddit.com/comments/{id}.json`). Handles pagination, depth truncation, and comment‑body markdown conversion (`redditThreadParser.ts`). |
| **redditPermalink**, **redditAuth**, **redditClient** are lower‑level helpers for token exchange and generic GET/POST. |

OAuth flow: `redditAuth` exchanges a code for a token, caches it in memory with expiry; `redditClient` automatically refreshes.

---

## 7. Crawl Infrastructure  

| File | Responsibility |
|------|----------------|
| **webCrawl.ts** | High‑level orchestrator: takes URLs → respects **robots.txt**, deduplicates, respects per‑request **crawl budget** (`utils/crawlBudget.ts`). Calls `webRead` for each URL, then runs **smartExtraction** (`utils/smartExtraction.ts`) which selects the best config (readability, readability‑lite, custom CSS selectors). Strips cookie banners using `utils/cookieBanner.ts`. |
| **webRead.ts** | Low‑level fetch with **SSRF guard** (`httpGuards.ts`). Supports redirects, timeout, content‑type validation. Returns raw HTML + extracted metadata (`title`, `description`). |
| **utils/cookieBanner.ts** | Detects typical cookie‑banner elements (by class/id regex) and removes them before extraction. |
| **utils/extractionConfig.ts** | Provides multiple extraction strategies (readability, boilerpipe, custom) and selects the one yielding highest *content quality* score (via `utils/extractionQuality.ts`). |
| **utils/smartExtraction.ts** | Runs each config, scores by word count, link density, and returns the best markdown. |
| **utils/url.ts** | Normalises URLs, enforces allowed schemes, prevents internal IPs. |

---

## 8. Safety / SSRF  

**src/httpGuards.ts**

* Implements `guardedFetch(url, options)`:
  * Checks scheme (`http`/`https` only).
  * Disallows private IP ranges (10/172.16/192.168, loopback, link‑local) – mitigates SSRF.
  * Enforces a configurable timeout (`config.HTTP_TIMEOUT_MS`).
  * Allows a whitelist of hostnames set via `SAFE_HOSTS` env var (used for internal services like a custom SearXNG instance).
* Returns a `FetchResult` with safe‑parsed JSON/text; throws `HttpGuardError` which is caught and turned into a structured tool error (see `errors.ts`).

---

## 9. Error Handling (`src/errors.ts`)  

* Defines a hierarchy of `ToolError` subclasses:
  * `InvalidInputError` – Zod validation failures.
  * `ExternalApiError` – non‑2xx responses, includes `status`, `body`.
  * `RateLimitExceededError`.
  * `HttpGuardError` – SSRF / timeout.
* Each error implements `toResponse(): ToolResponse` that contains:
  ```ts
  {
    success: false,
    error: {
      type: 'InvalidInput',
      message: string,
      details?: any
    }
  }
  ```
* The Fastify error hook serialises these into HTTP 200 responses (the MCP contract expects a JSON envelope, not HTTP error codes).

---

## 10. Rate Limiting (`src/rateLimit.ts`)  

* Uses **fastify‑rate‑limit** plugin.
* Configurable via env vars:
  * `RATE_LIMIT_MAX` – max requests per `windowMs`.
  * `RATE_LIMIT_WINDOW_MS`.
* Keys can be per‑IP or per‑API‑key (`config.RATE_LIMIT_KEY = 'apiKey'`), supporting per‑client quotas.
* When limit exceeded, throws `RateLimitExceededError`.

---

## 11. Corpus Cache (`src/rag/corpusCache.ts`)  

* SQLite DB (`config.CORPUS_DB_PATH`, default `./data/corpus.db`).
* Schema:
  ```sql
  CREATE TABLE chunks (
    id TEXT PRIMARY KEY,          -- SHA256(url+chunkIdx)
    url TEXT,
    content TEXT,
    embedding BLOB,               -- float32 array serialized
    metadata TEXT                -- JSON string
  );
  CREATE INDEX idx_url ON chunks(url);
  ```
* API:
  * `saveChunks(url, chunks)` – bulk insert with `INSERT OR REPLACE`.
  * `loadChunks(url)` – returns cached chunks (with embeddings) if present.
* Used by all **semantic** tools to avoid recomputation across requests.

---

## 12. Chunking (`src/chunking.ts` & `src/rag/chunking.ts`)  

* **`chunkMarkdown(text, opts)`**:
  * Splits on headings (`#`, `##`, …) and blank lines.
  * For code blocks (` ``` `) it creates separate chunks preserving language tag.
  * Tables are kept intact; if too large, they are split row‑wise.
  * Token overlap (`opts.overlapTokens`, default 200) is applied using the **tiktoken** tokenizer (`utils/tokenizer.ts`).
  * Each chunk carries `sourceUrl`, `lineStart`, `lineEnd`, `tokenCount`.
* **Code chunker** (`rag/code/treeSitter.ts`):
  * Uses **tree‑sitter** parsers to split source files into logical units (functions, classes). Symbols extracted via `rag/code/symbols.ts`.
* **Transcript chunker** (`rag/adapters/transcript.ts`):
  * Splits by speaker turn and by time intervals (max 5 min per chunk).

---

## 13. Config & Side‑cars  

**src/config.ts** (zod schema) – required env vars:

| Variable | Description | Example |
|----------|------------|---------|
| `PORT` | HTTP port | `8080` |
| `EMBEDDING_MODEL_PATH` | Path to ONNX sentence‑transformer model file | `./models/all-MiniLM-L6-v2.onnx` |
| `OPENAI_API_KEY` / `AZURE_OPENAI_KEY` | LLM provider (optional) | – |
| `BRAVE_API_KEY`, `EXA_API_KEY`, `NEWS_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | External services | – |
| `HTTP_TIMEOUT_MS` | Global fetch timeout | `10000` |
| `SAFE_HOSTS` | Comma‑separated whitelist for internal services | `search.mycorp.com` |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Rate‑limit config | `100`, `60000` |
| `CORPUS_DB_PATH` | SQLite file for cache | `./data/corpus.db` |
| `CRAWL_BUDGET_BYTES` | Max transfer per crawl request | `5_000_000` |
| `LLM_ENDPOINT` | If using a custom LLM server | `http://localhost:5000/v1/completions` |

*Side‑cars*:  
- **Embedding model** (ONNX) – must be present on the filesystem.  
- **SQLite** – embedded, no external process.  
- **Optional external LLM** – can be OpenAI, Azure, or a self‑hosted server.

---

## 14. Tests  

The `test/` folder mirrors the src hierarchy, providing unit and integration coverage:

| Area | Representative tests |
|------|------------------------|
| **Tools** | `academicSearch.test.ts`, `redditSearch.test.ts`, `githubRepoFile.test.ts`, `webCrawl.test.ts` |
| **RAG pipeline** | `ragPipeline.test.ts`, `ragEmbedding.test.ts`, `fusion.test.ts`, `ragAdapters.test.ts` |
| **Chunking** | `chunking.test.ts`, `codeChunking.test.ts`, `codeTreeSitter.test.ts`, `transcriptChunking.test.ts` |
| **Safety** | `webCrawlSsrf.test.ts`, `httpGuards` indirectly via above, `crawlBudget.test.ts` |
| **Corpus Cache** | `corpusCache.test.ts`, `githubCorpusGuardrails.test.ts` |
| **Reddit OAuth** | `redditOAuth.test.ts`, `redditCommentsOAuth.test.ts`, plus validation tests. |
| **Semantic tools** | `semanticCrawl.test.ts`, `semanticGithubCode.test.ts`, `semanticJobs.test.ts`, `semanticYoutube.test.ts` |
| **Rate limiting / health** | `infrastructure.test.ts`, `crawl4aiHealth.test.ts` |
| **Utilities** | `utils/*` tests for cookie banner removal, extraction quality scoring, URL sanitisation, time utils, etc. |

**Coverage:** > 90 % on core modules (pipeline, chunking, tools). Tests also assert proper error handling (invalid inputs, SSRF blocks, rate‑limit violations).

---

## 15. What Makes *search‑mcp* Unique  

| Feature | Typical MCP servers (e.g., generic OpenAI plugins) | **search‑mcp** |
|---------|----------------------------------------------------|----------------|
| **Local embeddings** | Rely on external vector DB (Pinecone, Weaviate) or OpenAI embeddings. | Uses an **ONNX sentence‑transformer** on the same process – no network call, lower latency, full data‑privacy. |
| **Hybrid retrieval** | Usually BM25 **or** embeddings, not both. | Implements a **reciprocal‑rank fusion** of BM25 + embedding similarity, giving robust results for both lexical and semantic queries. |
| **Multiple search back‑ends** | One vendor (Google, Bing). | Supports **Brave, EXA, SearXNG, Semantic Scholar, Reddit, GitHub, YouTube, Jobs, Patents**, etc., each with its own adapter. |
| **Corpus cache** | No built‑in caching of crawled material. | Persists chunk embeddings in a **SQLite DB** – repeat semantic crawls are instant. |
| **Fine‑grained RAG profiles** | Single generic chunker. | Profile‑driven chunkers (code, transcripts, job postings) with language‑aware Tree‑Sitter parsing. |
| **Safety guardrails** | Basic input validation. | **SSRF guard**, private‑IP blocking, cookie‑banner stripping, extraction‑quality scoring, lexical constraints, and explicit `ToolError` hierarchy. |
| **Test depth** | Often minimal. | **Extensive unit + integration tests** (≈200 tests) covering every tool, crawling edge‑cases, OAuth flows, and safety checks. |
| **Self‑contained** | Needs external vector DB & often paid APIs. | Only needs the **embedding model** and optional API keys; otherwise it can run fully offline. |
| **Configurable rate‑limit** | Fixed per‑IP. | Per‑API‑key or IP, with environment overrides. |

These design choices make *search‑mcp* a powerful, privacy‑first Retrieval‑Augmented Generation server ideal for internal enterprise deployments where data cannot leave the premises.

--- 

*End of generated context.*