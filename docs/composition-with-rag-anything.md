# Composition with RAG-Anything and Other Tools

search-mcp emits structured `ContentElement[]` arrays from `web_read`, `web_crawl`, and several content-oriented tools. This page shows how to compose those elements into downstream pipelines.

## ContentElement Format

Structured content is optional. When present, it uses an `elements` array:

```ts
type StructuredContent = {
  elements?: ContentElement[];
  truncatedElements?: true;
  originalElementCount?: number;
  omittedElementCount?: number;
};

type ContentElement =
  | { type: 'heading'; level: number; text: string; id: string | null }
  | { type: 'text'; text: string; truncated?: true; originalLength?: number }
  | {
      type: 'table';
      markdown: string;
      caption: string | null;
      rows: number;
      cols: number;
      truncated?: true;
      originalLength?: number;
    }
  | { type: 'image'; src: string | null; alt: string; title: string | null }
  | {
      type: 'code';
      language: string | null;
      content: string;
      truncated?: true;
      originalLength?: number;
    }
  | { type: 'list'; ordered: boolean; items: string[] };
```

`elements` preserves document structure -- headings, tables, images, code blocks, and lists are all typed and accessible without re-parsing raw HTML or markdown. When more candidates are found than the response budget allows, `truncatedElements`, `originalElementCount`, and `omittedElementCount` describe the omission. Long text, code, and table payloads can also carry `truncated` plus `originalLength`.

## RAG-Anything (`HKUDS/RAG-Anything`)

RAG-Anything accepts a pre-parsed `content_list` for multimodal ingestion. The types are compatible:

| RAG-Anything `content_list`                       | search-mcp `ContentElement`                                    |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `{"type": "text", "text": ...}`                   | `{"type": "text", "text": ...}`                                |
| `{"type": "image", "image": ..., "caption": ...}` | `{"type": "image", "src": ..., "alt": ...}`                    |
| `{"type": "table", "html": ..., "text": ...}`     | `{"type": "table", "markdown": ..., "rows": ..., "cols": ...}` |

### web_read -> elements -> RAG-Anything

1. Call `web_read` on a URL.
2. Read `result.elements` from the response.
3. Map each element to RAG-Anything's `content_list` format.
4. Call `insert_content_list(content_list, ...)`.

```python
# Pseudocode
result = mcp_call("web_read", {"url": "https://example.com/article"})
elements = result["data"]["elements"]

content_list = []
for el in elements:
    if el["type"] == "text":
        content_list.append({"type": "text", "text": el["text"]})
    elif el["type"] == "image":
        content_list.append({
            "type": "image",
            "image": el["src"],
            "caption": el["alt"]
        })
    elif el["type"] == "table":
        content_list.append({
            "type": "table",
            "html": el["markdown"],
            "text": el["markdown"]
        })
    # ... handle code, list, heading as needed

rag_anything.insert_content_list(content_list, doc_id="article-1")
```

### web_crawl -> markdown -> elements -> RAG-Anything

1. Call `web_crawl` with a seed URL.
2. Each page in `result.pages` now includes `elements`.
3. Map each page's elements to a `content_list`.
4. Batch insert into RAG-Anything.

```python
result = mcp_call("web_crawl", {"url": "https://docs.example.com", "max_depth": 2})
for page in result["data"]["pages"]:
    elements = page.get("elements", [])
    content_list = map_elements_to_content_list(elements)
    rag_anything.insert_content_list(content_list, doc_id=page["url"])
```

Because `web_crawl` already converts crawl4ai markdown into typed `ContentElement`s, you bypass RAG-Anything's internal document parser and go straight to `insert_content_list()`.

## Composing with Other Tools

### github_repo_file -> code elements

`github_repo_file` returns source code and, for text files, includes a `code` element built from the decoded file content:

```python
file_result = mcp_call("github_repo_file", {
    "owner": "org",
    "repo": "repo",
    "path": "src/main.py"
})

element = file_result["data"]["elements"][0]
```

This is useful for feeding code chunks into RAG-Anything's knowledge graph for code-aware retrieval.

### arxiv_search -> academic_search -> text elements

`arxiv_search` and `academic_search` return paper metadata plus abstracts. The abstract can be treated as a `text` element:

```python
papers = mcp_call("academic_search", {"query": "transformer architecture"})
for paper in papers["data"]["results"]:
    elements = [{"type": "text", "text": paper["abstract"]}]
    # Feed into downstream RAG or summarization pipeline
```

### reddit_comments / hackernews_search -> discussion elements

Both tools return threaded discussions. Normalize comments into a flat `text` element list or preserve thread structure with `heading` elements for nesting:

```python
comments = mcp_call("reddit_comments", {"url": post_url})
for comment in comments["data"]["comments"]:
    elements.append({"type": "text", "text": comment["text"]})
```

### youtube_transcript -> text elements

`youtube_transcript` includes one finalized `text` element for the returned transcript text. Use `transcript` when you need segment timing:

```python
transcript = mcp_call("youtube_transcript", {"videoId": "dQw4w9WgXcQ"})
elements = transcript["data"].get("elements", [])
```

## Design Notes

- `web_read` extracts elements from the **article content** (Readability path) or the **full page** (fallback path). In the Readability path, nav, ads, and sidebars are already stripped, so `elements` represents the actual article.
- `web_crawl` extracts elements from crawl4ai's **markdown output**. This includes headings, tables, lists, code fences, and images found in the converted markdown.
- Tools include `elements` only when structured content was successfully extracted. Failed or empty pages have `elements: undefined`.
- Element finalization prefers headings, tables, code, lists, and images over low-value text when a page has more structural candidates than the response budget.
- The `ContentElement` type is intentionally flat and simple -- it serializes cleanly over JSON-RPC and requires zero client-side dependencies to consume.
