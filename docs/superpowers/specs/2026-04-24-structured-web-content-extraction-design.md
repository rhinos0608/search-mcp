---
name: Structured Web Content Extraction
description: Extend all content-fetching tools to return structured ContentElement[] arrays for multimodal downstream pipelines like RAG-Anything.
type: project
---

# Design Spec: Structured Web Content Extraction

## Goal
Extend all content-fetching tools in `search-mcp` to return a structured `elements` array. This enables downstream tools (e.g., HKUDS/RAG-Anything) to consume typed document parts (headings, tables, images, code, lists) directly without re-parsing raw markdown or HTML.

## Background
Currently, `web_read` and `web_crawl` emit `ContentElement[]`. Other tools like `reddit_comments`, `github_repo_file`, and `academic_search` return raw text or abstracts. Downstream RAG pipelines benefit from knowing the structure of this content (e.g., distinguishing code blocks from prose).

## Proposed Changes

### 1. Type Definitions (`src/types.ts`)
Add an optional `elements?: ContentElement[]` field to the following interfaces:
- **Entities**: `GitHubRepo`, `GitHubFileResult`, `GitHubCodeResult`, `YouTubeResult`, `RedditPost`, `NormalizedRedditComment`, `PatentResult`, `PodcastResult`, `AcademicPaper`, `ArXivPaper`, `StackOverflowQuestion`, `SemanticCrawlChunk`.
- **Search/Feed Items**: `SearchResult`, `TrendingRepo`, `TwitterPost`, `ProductHuntProduct`, `HackerNewsItem`, `YouTubeVideo`, `NpmPackage`, `PypiPackage`, `NewsArticle`.

### 2. Extraction Logic

#### A. Markdown Extraction
Use `extractElementsFromMarkdown` (from `src/utils/markdownElements.ts`):
- `reddit_comments`: Body and comment text.
- `github_repo`: README content.
- `reddit_search`: Post bodies.

#### B. HTML Extraction
Use `extractElementsFromHtml` (from `src/utils/htmlElements.ts`) via `jsdom`:
- `stackoverflow_search`: Question and answer bodies.
- `hackernews_search`: Story text (if present).

#### C. Code Wrapping
- `github_repo_file`: Wrap the `content` in a single `CodeElement` with the detected language.

#### D. Text Wrapping (Semantic Mapping)
Wrap existing text fields into a single `TextElement` for tools where structure is unavailable but multimodal ingestion expects a list:
- `YouTubeResult`: Each transcript segment becomes a `TextElement`.
- `academic_search` / `arxiv_search`: Abstracts.
- `patent_search`: Abstracts.
- `podcast_search` / `producthunt_search`: Descriptions.

### 3. Architecture & Performance
- **Isolation**: Element extraction logic is isolated in `src/utils/`.
- **Caching**: Elements are stored in the existing `ToolCache` as part of the tool result.
- **Safety**: Wrapped in try/catch to ensure extraction failure doesn't fail the primary tool call.

## Success Criteria
1. All content-fetching tools return an `elements` field in their `data` payload.
2. `elements` correctly identifies headings, tables, lists, and code blocks where present.
3. Downstream RAG-Anything integration can map these elements directly using the mapping logic in `docs/composition-with-rag-anything.md`.
