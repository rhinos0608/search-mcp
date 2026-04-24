# Structured Web Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend all content-fetching tools in `search-mcp` to return a structured `elements` array for multimodal downstream pipelines.

**Architecture:** Centralize element extraction in `src/utils/elementHelpers.ts` to wrap JSDOM/Markdown logic with safety, resource management, and payload budgeting. Update `src/types.ts` to use a `StructuredContent` interface across all relevant tool results.

**Tech Stack:** TypeScript, JSDOM, Mozilla Readability (existing), Markdown regex (existing).

---

### Task 1: Shared Interfaces & Extractor Helpers

**Files:**
- Modify: `src/types.ts`
- Create: `src/utils/elementHelpers.ts`
- Test: `test/elementHelpers.test.ts`

- [ ] **Step 1: Define StructuredContent interface and update types**

Modify `src/types.ts` to add the `StructuredContent` interface and extend relevant interfaces.

```typescript
// Add near line 49 in src/types.ts
export interface StructuredContent {
  /**
   * Structured document elements (headings, tables, images, code, lists) 
   * for multimodal downstream consumption.
   */
  elements?: ContentElement[];
}

// Update the following interfaces to extend StructuredContent:
// GitHubRepo, GitHubFileResult, GitHubCodeResult, YouTubeResult, RedditPost,
// NormalizedRedditComment, PatentResult, PodcastResult, AcademicPaper, 
// ArXivPaper, StackOverflowQuestion, SemanticCrawlChunk, SearchResult, 
// TrendingRepo, TwitterPost, ProductHuntProduct, HackerNewsItem, YouTubeVideo, 
// NpmPackage, PypiPackage, NewsArticle.
```

- [ ] **Step 2: Create elementHelpers.ts**

Create `src/utils/elementHelpers.ts` to provide safe wrappers for extraction.

```typescript
import { JSDOM } from 'jsdom';
import { extractElementsFromHtml } from './htmlElements.js';
import { extractElementsFromMarkdown } from './markdownElements.js';
import type { ContentElement } from '../types.js';
import { logger } from '../logger.js';

const MAX_ELEMENTS = 500;
const MAX_TEXT_LENGTH = 10000;

export function safeExtractFromHtml(html: string | null | undefined): ContentElement[] | undefined {
  if (!html || html.trim().length === 0) return undefined;
  
  try {
    const dom = new JSDOM(html);
    try {
      const elements = extractElementsFromHtml(dom.window.document);
      if (elements.length === 0) return undefined;
      return elements.slice(0, MAX_ELEMENTS);
    } finally {
      dom.window.close();
    }
  } catch (err) {
    logger.debug({ err }, 'HTML element extraction failed');
    return undefined;
  }
}

export function safeExtractFromMarkdown(markdown: string | null | undefined): ContentElement[] | undefined {
  if (!markdown || markdown.trim().length === 0) return undefined;
  
  try {
    const elements = extractElementsFromMarkdown(markdown);
    if (elements.length === 0) return undefined;
    return elements.slice(0, MAX_ELEMENTS);
  } catch (err) {
    logger.debug({ err }, 'Markdown element extraction failed');
    return undefined;
  }
}

export function wrapTextInElement(text: string | null | undefined): ContentElement[] | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const trimmed = text.trim();
  return [{ type: 'text', text: trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) + '...' : trimmed }];
}
```

- [ ] **Step 3: Write tests for helpers**

Create `test/elementHelpers.test.ts`.

```typescript
import { expect } from 'chai';
import { safeExtractFromHtml, safeExtractFromMarkdown, wrapTextInElement } from '../src/utils/elementHelpers.js';

describe('elementHelpers', () => {
  it('should extract from HTML safely', () => {
    const html = '<h1>Title</h1><p>Text</p>';
    const elements = safeExtractFromHtml(html);
    expect(elements).to.have.lengthOf(2);
    expect(elements?.[0]?.type).to.equal('heading');
  });

  it('should extract from Markdown safely', () => {
    const md = '# Title\n\nText';
    const elements = safeExtractFromMarkdown(md);
    expect(elements).to.have.lengthOf(2);
    expect(elements?.[0]?.type).to.equal('heading');
  });

  it('should wrap text safely', () => {
    const elements = wrapTextInElement('Hello world');
    expect(elements).to.have.lengthOf(1);
    expect(elements?.[0]?.type).to.equal('text');
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test test/elementHelpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/utils/elementHelpers.ts test/elementHelpers.test.ts
git commit -m "feat: add shared StructuredContent interface and extractor helpers"
```

---

### Task 2: Wire up GitHub & Source Code

**Files:**
- Modify: `src/tools/githubRepo.ts`
- Modify: `src/tools/githubRepoFile.ts`

- [ ] **Step 1: Extract elements from GitHub README**

Modify `src/tools/githubRepo.ts` to use `safeExtractFromMarkdown` for the README content.

```typescript
// In githubRepo tool handler
if (repo.readme) {
  repo.elements = safeExtractFromMarkdown(repo.readme);
}
```

- [ ] **Step 2: Wrap GitHub file content in CodeElement**

Modify `src/tools/githubRepoFile.ts`.

```typescript
// In githubRepoFile tool handler
if (!result.isBinary) {
  result.elements = [{
    type: 'code',
    language: detectLanguage(result.path), // Use existing or simple ext-based detection
    content: result.content
  }];
}
```

- [ ] **Step 3: Verify with manual test**

Run the MCP server locally and call `github_repo` for a repository with a README.
Expected: `elements` field contains structured parts of the README.

- [ ] **Step 4: Commit**

```bash
git add src/tools/githubRepo.ts src/tools/githubRepoFile.ts
git commit -m "feat: add structured elements to GitHub tools"
```

---

### Task 3: Wire up Reddit & StackOverflow

**Files:**
- Modify: `src/tools/redditComments.ts`
- Modify: `src/tools/redditClient.ts`
- Modify: `src/tools/stackoverflowSearch.ts`

- [ ] **Step 1: Extract from Reddit posts and comments**

Modify `src/tools/redditClient.ts` (normalization logic) or the tool handlers.

```typescript
// RedditPost
post.elements = safeExtractFromMarkdown(post.selftext);

// NormalizedRedditComment
comment.elements = safeExtractFromMarkdown(comment.body);
```

- [ ] **Step 2: Extract from StackOverflow HTML**

Modify `src/tools/stackoverflowSearch.ts`.

```typescript
// For each question
question.elements = safeExtractFromHtml(question.body);
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/redditClient.ts src/tools/redditComments.ts src/tools/stackoverflowSearch.ts
git commit -m "feat: add structured elements to Reddit and StackOverflow"
```

---

### Task 4: Text Wrapping for Long-tail Tools

**Files:**
- Modify: `src/tools/youtubeSearch.ts`, `src/tools/academicSearch.ts`, `src/tools/arxivSearch.ts`, `src/tools/patentSearch.ts`, `src/tools/podcastSearch.ts`, `src/tools/producthuntSearch.ts`, `src/tools/newsSearch.ts`, `src/tools/npmSearch.ts`, `src/tools/pypiSearch.ts`, `src/tools/twitterSearch.ts`, `src/tools/hackerNewsSearch.ts`

- [ ] **Step 1: Apply wrapTextInElement or safeExtractFromHtml/Markdown**

Iterate through the tools and apply the appropriate helper to the main content field (Abstract, Description, Body, etc.).

- [ ] **Step 2: Commit**

```bash
git add src/tools/*.ts
git commit -m "feat: add structured elements fallback to all remaining content tools"
```

---

### Task 5: Semantic Crawl Preservation

**Files:**
- Modify: `src/tools/semanticCrawl.ts`
- Modify: `src/tools/webCrawl.ts`

- [ ] **Step 1: Propagate elements from crawl to semantic chunks**

Modify `src/tools/semanticCrawl.ts` to include relevant elements in the `SemanticCrawlChunk` if they are available from the source page.

- [ ] **Step 2: Verify with manual test**

Run a `semantic_crawl` and verify that chunks contain an `elements` array when the source page has structure.

- [ ] **Step 3: Commit**

```bash
git add src/tools/semanticCrawl.ts src/tools/webCrawl.ts
git commit -m "feat: propagate structured elements through semantic crawl"
```

---

### Task 6: Final Verification & Payload Audit

- [ ] **Step 1: Run full test suite**

Run: `npm test`

- [ ] **Step 2: Payload check**

Verify that total response size remains under 10MB even with complex structure.
Check that `elements` are omitted when empty.

- [ ] **Step 3: Final Commit**

```bash
git commit --allow-empty -m "chore: structured elements integration complete"
```
