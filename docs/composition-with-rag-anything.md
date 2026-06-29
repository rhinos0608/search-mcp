# Composition with Structured Content

search-mcp emits structured `ContentElement[]` arrays from `web_crawl` and content-oriented family tools. Downstream RAG systems can consume these typed elements directly instead of reparsing markdown.

## ContentElement Format

Elements are flat JSON objects with a `type` discriminator:

| Type      | Common fields              |
| --------- | -------------------------- |
| `heading` | `level`, `text`            |
| `text`    | `text`                     |
| `table`   | `markdown`, `rows`, `cols` |
| `code`    | `language`, `content`      |
| `list`    | `ordered`, `items`         |
| `image`   | `src`, `alt`, `title`      |

## web_crawl → elements

1. Call `web_crawl` with a URL and page budget.
2. Read `elements` from each returned page when present.
3. Map elements into your downstream corpus or multimodal index.

```python
result = mcp_call("web_crawl", {"url": "https://docs.example.com", "maxPages": 5})
for page in result["data"]["pages"]:
    elements = page.get("elements", [])
    ingest_elements(elements, doc_id=page["url"])
```

## Other content tools

- `github.file` returns source code that can be treated as a `code` element.
- `research.academic` and `research.arxiv` return abstracts suitable for `text` elements.
- `reddit.comments` and `research.hackernews` return discussions that can be flattened into `text` elements or preserved with heading levels.
- `youtube.transcript` returns transcript text plus segment timing when available.

## Design Notes

- `web_crawl` extracts elements from Crawl4AI markdown output.
- Tools include `elements` only when structured content was successfully extracted.
- Element finalization prefers headings, tables, code, lists, and images over low-value text when response budget is tight.
- `ContentElement` stays intentionally flat so it serializes cleanly over JSON-RPC.
