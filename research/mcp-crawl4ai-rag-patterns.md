# Research: Patterns from mcp-crawl4ai-rag for search-mcp Enhancement

**Repository:** https://github.com/coleam00/mcp-crawl4ai-rag.git  
**Research Date:** 2026-04-24  
**Status:** Planning Phase - No Implementation

---

## Executive Summary

The mcp-crawl4ai-rag repository (2,143 stars, 571 forks) implements a sophisticated RAG (Retrieval-Augmented Generation) MCP server with several advanced patterns that could significantly enhance search-mcp's semantic crawl and retrieval capabilities.

### Key Differentiators
- **Contextual Embeddings**: LLM-powered chunk enrichment before embedding
- **Agentic RAG**: Code example extraction and specialized retrieval
- **Hybrid Search**: Parallel vector + keyword search with intelligent merging
- **Cross-Encoder Reranking**: Local ONNX model for result refinement
- **Knowledge Graph**: Neo4j-based hallucination detection

---

## 1. Architecture Patterns

### 1.1 FastMCP Lifespan Management

**Pattern:** Structured context management with async resource lifecycle

```python
@dataclass
class Crawl4AIContext:
    crawler: AsyncWebCrawler
    supabase_client: Client
    reranking_model: Optional[CrossEncoder] = None
    knowledge_validator: Optional[Any] = None
    repo_extractor: Optional[Any] = None

@asynccontextmanager
async def crawl4ai_lifespan(server: FastMCP) -> AsyncIterator[Crawl4AIContext]:
    # Initialize components with conditional loading
    reranking_model = None
    if os.getenv("USE_RERANKING", "false") == "true":
        reranking_model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    
    yield Crawl4AIContext(...)
    # Cleanup with error handling
```

**Applicability to search-mcp:**
- search-mcp already has good configuration management via `config.ts`
- Could enhance with conditional tool registration based on config availability
- The lifespan pattern could improve the MCP server initialization

### 1.2 Strategy Pattern for RAG Strategies

**Pattern:** Environment-flag driven strategy enablement

```python
# Configuration via environment variables
USE_CONTEXTUAL_EMBEDDINGS = os.getenv("USE_CONTEXTUAL_EMBEDDINGS", "false") == "true"
USE_HYBRID_SEARCH = os.getenv("USE_HYBRID_SEARCH", "false") == "true"
USE_AGENTIC_RAG = os.getenv("USE_AGENTIC_RAG", "false") == "true"
USE_RERANKING = os.getenv("USE_RERANKING", "false") == "true"
```

**Applicability to search-mcp:**
- search-mcp already uses environment-based configuration
- Could add feature flags for experimental features (cross-encoder, contextual embeddings)
- Would enable gradual rollout of new capabilities

---

## 2. Retrieval Patterns

### 2.1 Contextual Embeddings (Document-Chunk LLM Enrichment)

**Pattern:** Use LLM to generate contextual situating text before embedding

```python
def generate_contextual_embedding(full_document: str, chunk: str) -> Tuple[str, bool]:
    prompt = f"""<document> 
{full_document[:25000]} 
</document>
Here is the chunk we want to situate within the whole document 
<chunk> 
{chunk}
</chunk> 
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else."""

    response = openai.chat.completions.create(
        model=model_choice,
        messages=[...],
        temperature=0.3,
        max_tokens=200
    )
    
    context = response.choices[0].message.content.strip()
    contextual_text = f"{context}\n---\n{chunk}"
    return contextual_text, True
```

**Trade-offs:**
- **Pros:** Significantly improves retrieval accuracy, especially for technical docs where terms have context-dependent meanings
- **Cons:** Slower indexing due to LLM calls for each chunk; additional LLM API costs

**Applicability to search-mcp:**
- search-mcp's `semantic_crawl` could add optional contextual embedding via an LLM sidecar
- Would require new configuration for LLM provider
- Could be enabled via feature flag `USE_CONTEXTUAL_EMBEDDINGS`

### 2.2 Hybrid Search (Vector + Keyword Fusion)

**Pattern:** Execute vector and keyword searches in parallel, merge with preference for overlap

```python
def perform_hybrid_search(query, match_count, filter_metadata=None, source=None):
    # 1. Vector search
    vector_results = search_documents(
        client=supabase_client,
        query=query,
        match_count=match_count * 2,
        filter_metadata=filter_metadata
    )
    
    # 2. Keyword search using ILIKE
    keyword_query = supabase_client.from_('crawled_pages')\
        .select('id, url, chunk_number, content, metadata, source_id')\
        .ilike('content', f'%{query}%')
    
    if source:
        keyword_query = keyword_query.eq('source_id', source)
    
    keyword_response = keyword_query.limit(match_count * 2).execute()
    keyword_results = keyword_response.data
    
    # 3. Merge with preference for items in both
    vector_ids = {r.get('id') for r in vector_results if r.get('id')}
    
    combined_results = []
    seen_ids = set()
    
    # First: items in both (boosted similarity)
    for kr in keyword_results:
        if kr['id'] in vector_ids and kr['id'] not in seen_ids:
            for vr in vector_results:
                if vr.get('id') == kr['id']:
                    vr['similarity'] = min(1.0, vr.get('similarity', 0) * 1.2)
                    combined_results.append(vr)
                    seen_ids.add(kr['id'])
                    break
    
    # Then: remaining vector results
    for vr in vector_results:
        if vr.get('id') and vr.get('id') not in seen_ids and len(combined_results) < match_count:
            combined_results.append(vr)
            seen_ids.add(vr['id'])
    
    # Finally: pure keyword matches
    for kr in keyword_results:
        if kr['id'] not in seen_ids and len(combined_results) < match_count:
            combined_results.append({
                'id': kr['id'],
                'url': kr['url'],
                'chunk_number': kr['chunk_number'],
                'content': kr['content'],
                'metadata': kr['metadata'],
                'source_id': kr['source_id'],
                'similarity': 0.5  # Default for keyword-only
            })
            seen_ids.add(kr['id'])
    
    return combined_results[:match_count]
```

**Key Insights:**
- Parallel execution of both search types
- 20% similarity boost for items appearing in both result sets
- Fallback cascade: overlap > vector-only > keyword-only

**Applicability to search-mcp:**
- search-mcp already has BM25 + Bi-encoder fusion in `semanticCrawl.ts`
- The hybrid search pattern from mcp-crawl4ai-rag could enhance the existing RRF fusion
- Could add ILIKE-based keyword search to Supabase integration

### 2.3 Cross-Encoder Reranking

**Pattern:** Use local ONNX cross-encoder model to rerank initial results

```python
from sentence_transformers import CrossEncoder

# Initialize model (local, no API calls)
reranking_model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

def rerank_results(model, query, results, content_key="content"):
    if not model or not results:
        return results
    
    # Extract content
    texts = [result.get(content_key, "") for result in results]
    
    # Create query-document pairs
    pairs = [[query, text] for text in texts]
    
    # Get relevance scores
    scores = model.predict(pairs)
    
    # Add scores and sort
    for i, result in enumerate(results):
        result["rerank_score"] = float(scores[i])
    
    return sorted(results, key=lambda x: x.get("rerank_score", 0), reverse=True)
```

**Trade-offs:**
- **Pros:** ~100-200ms latency for result reordering; no API costs; runs locally on CPU
- **Cons:** Additional dependency (sentence-transformers); model size (~100MB)

**Applicability to search-mcp:**
- search-mcp already has optional cross-encoder reranking in `semanticCrawl.ts`
- The pattern from mcp-crawl4ai-rag validates the approach
- Could enhance with local ONNX model support for lower latency

---

## 3. Data Storage Patterns

### 3.1 Supabase Vector Database Schema

**Pattern:** Three-table design with pgvector for embeddings

```sql
-- Sources table for metadata
CREATE TABLE sources (
    source_id text PRIMARY KEY,
    summary text,
    total_word_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Main documentation chunks table
CREATE TABLE crawled_pages (
    id bigserial PRIMARY KEY,
    url varchar NOT NULL,
    chunk_number integer NOT NULL,
    content text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_id text NOT NULL,
    embedding vector(1536),  -- OpenAI embeddings
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES sources(source_id)
);

-- Code examples table (optional, for agentic RAG)
CREATE TABLE code_examples (
    id bigserial PRIMARY KEY,
    url varchar NOT NULL,
    chunk_number integer NOT NULL,
    content text NOT NULL,
    summary text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_id text NOT NULL,
    embedding vector(1536),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES sources(source_id)
);

-- Indexes for performance
CREATE INDEX ON crawled_pages USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_crawled_pages_metadata ON crawled_pages USING gin (metadata);
CREATE INDEX idx_crawled_pages_source_id ON crawled_pages (source_id);

-- Vector similarity search function
CREATE OR REPLACE FUNCTION match_crawled_pages (
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb,
  source_filter text DEFAULT NULL
) RETURNS TABLE (
  id bigint,
  url varchar,
  chunk_number integer,
  content text,
  metadata jsonb,
  source_id text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    id,
    url,
    chunk_number,
    content,
    metadata,
    source_id,
    1 - (crawled_pages.embedding <=> query_embedding) AS similarity
  FROM crawled_pages
  WHERE metadata @> filter
    AND (source_filter IS NULL OR source_id = source_filter)
  ORDER BY crawled_pages.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Key Design Decisions:**
1. **Separation of concerns**: Sources table for metadata, crawled_pages for content
2. **Code examples table**: Optional specialized storage for agentic RAG
3. **pgvector with ivfflat**: Efficient approximate nearest neighbor search
4. **JSONB metadata**: Flexible schema for additional chunk attributes
5. **Database functions**: Encapsulated similarity search logic

**Applicability to search-mcp:**
- search-mcp currently uses in-memory corpus cache with 24h TTL
- Could add optional Supabase/pgvector persistence layer
- Would enable persistent RAG across server restarts
- Could use similar three-table design (sources, chunks, code_examples)

### 3.2 Corpus Cache with Precomputed Embeddings

**Pattern:** 24h TTL in-memory cache storing chunks + embeddings + BM25 index

```typescript
// search-mcp's current approach (from semanticCrawl.ts)
interface CorpusCache {
  corpusId: string;
  chunks: CorpusChunk[];
  embeddings: number[][];
  bm25Index: Bm25Index;
  createdAt: Date;
}

// getOrBuildCorpus handles cache lookup or creation
const corpus = await getOrBuildCorpus(
  opts.source,
  async () => {
    // Build embeddings and index
    const { embeddings, model } = await embedTextsBatched(...);
    const contentHash = createHash('sha256').update(chunkTexts.join('\n')).digest('hex');
    return { chunks: deduped, embeddings, model, contentHash };
  },
  { ttlMs: 24 * 60 * 60 * 1000, maxCorpora: 50 }
);
```

**Comparison:**

| Aspect | mcp-crawl4ai-rag | search-mcp |
|--------|------------------|------------|
| Storage | Persistent (Supabase/pgvector) | Ephemeral (in-memory) |
| Embeddings | Computed at ingest | Cached with TTL |
| Cross-session | Yes | No (corpus cache is per-process) |
| Scalability | Database-backed | Single-node memory |

**Applicability:**
- search-mcp's in-memory approach is faster for single-session use
- Could add optional persistence layer for cross-session RAG
- The 50-corpus / 24h TTL is a good tradeoff for ephemeral use

---

## 4. Tool Design Patterns

### 4.1 Conditional Tool Registration

**Pattern:** Tools dynamically enabled based on configuration

```python
@mcp.tool()
async def search_code_examples(ctx: Context, query: str, ...):
    """
    Search for code examples relevant to the query.
    
    (requires `USE_AGENTIC_RAG=true`)
    """
    # Check if code example extraction is enabled
    extract_code_examples_enabled = os.getenv("USE_AGENTIC_RAG", "false") == "true"
    if not extract_code_examples_enabled:
        return json.dumps({
            "success": False,
            "error": "Code example extraction is disabled. Perform a normal RAG search."
        }, indent=2)
    
    # ... tool implementation

@mcp.tool()
async def check_ai_script_hallucinations(ctx: Context, script_path: str):
    """
    Check an AI-generated Python script for hallucinations.
    
    (requires `USE_KNOWLEDGE_GRAPH=true`)
    """
    knowledge_graph_enabled = os.getenv("USE_KNOWLEDGE_GRAPH", "false") == "true"
    if not knowledge_graph_enabled:
        return json.dumps({
            "success": False,
            "error": "Knowledge graph functionality is disabled."
        }, indent=2)
    # ... implementation
```

**Design Rationale:**
- Users opt-in to advanced features that have cost/latency implications
- Clear error messages when tools are accessed without enabling the feature
- No breaking changes - tools gracefully degrade

**Applicability to search-mcp:**
- search-mcp already has this pattern - tools check config availability
- Could enhance error messages to be more descriptive about how to enable features
- The optional `useReranker` parameter in `semantic_crawl` follows this pattern

### 4.2 Smart URL Detection and Strategy Selection

**Pattern:** Automatic crawl strategy based on URL type

```python
async def smart_crawl_url(ctx: Context, url: str, max_depth: int = 3, ...):
    """
    Intelligently crawl a URL based on its type.
    
    - For sitemaps: Extracts and crawls all URLs in parallel
    - For text files (llms.txt): Directly retrieves the content
    - For regular webpages: Recursively crawls internal links
    """
    # Determine the crawl strategy
    crawl_results = []
    crawl_type = None
    
    if is_txt(url):
        # For text files, use simple crawl
        crawl_results = await crawl_markdown_file(crawler, url)
        crawl_type = "text_file"
    elif is_sitemap(url):
        # For sitemaps, extract URLs and crawl in parallel
        sitemap_urls = parse_sitemap(url)
        crawl_results = await crawl_batch(crawler, sitemap_urls, max_concurrent=max_concurrent)
        crawl_type = "sitemap"
    else:
        # For regular URLs, use recursive crawl
        crawl_results = await crawl_recursive_internal_links(...)
        crawl_type = "webpage"
```

**Key Features:**
- Automatic content-type detection (sitemap.xml, .txt, regular pages)
- Different crawl strategies for different content types
- Parallel processing for sitemap-derived URLs

**Applicability to search-mcp:**
- search-mcp's `semantic_crawl` already has source type discrimination (url, sitemap, search, github, cached)
- Could add automatic content detection within the 'url' type (detect sitemap vs page)
- The sitemap handling could be enhanced to fetch sub-sitemaps (mcp-crawl4ai-rag does this)

---

## 5. Code Example Extraction (Agentic RAG)

### 5.1 Pattern: Specialized Code Block Extraction

```python
def extract_code_blocks(markdown_content: str, min_length: int = 1000):
    """
    Extract code blocks from markdown content along with context.
    """
    code_blocks = []
    
    # Find all triple-backtick occurrences
    backtick_positions = []
    pos = 0
    while True:
        pos = markdown_content.find('```', pos)
        if pos == -1:
            break
        backtick_positions.append(pos)
        pos += 3
    
    # Process pairs of backticks
    i = 0
    while i < len(backtick_positions) - 1:
        start_pos = backtick_positions[i]
        end_pos = backtick_positions[i + 1]
        
        # Extract content between backticks
        code_section = markdown_content[start_pos+3:end_pos]
        
        # Parse language specifier and content
        lines = code_section.split('\n', 1)
        if len(lines) > 1:
            first_line = lines[0].strip()
            if first_line and not ' ' in first_line and len(first_line) < 20:
                language = first_line
                code_content = lines[1].strip() if len(lines) > 1 else ""
            else:
                language = ""
                code_content = code_section.strip()
        
        # Skip if too short
        if len(code_content) < min_length:
            i += 2
            continue
        
        # Extract surrounding context (1000 chars before/after)
        context_start = max(0, start_pos - 1000)
        context_before = markdown_content[context_start:start_pos].strip()
        
        context_end = min(len(markdown_content), end_pos + 3 + 1000)
        context_after = markdown_content[end_pos + 3:context_end].strip()
        
        code_blocks.append({
            'code': code_content,
            'language': language,
            'context_before': context_before,
            'context_after': context_after,
            'full_context': f"{context_before}\n\n{code_content}\n\n{context_after}"
        })
        
        i += 2
    
    return code_blocks
```

**Key Features:**
- Language detection from markdown fence headers
- Configurable minimum length threshold (default 1000 chars)
- Context extraction (1000 chars before/after) for LLM summarization
- Full context assembly for embedding

**Applicability to search-mcp:**
- search-mcp's chunking in `chunking.ts` already has code fence awareness
- Could add specialized `CodeChunk` type with language metadata
- The context extraction pattern could enhance the existing chunking

### 5.2 Code Example Summarization

**Pattern:** LLM-generated summaries for code examples

```python
def generate_code_example_summary(code: str, context_before: str, context_after: str) -> str:
    """
    Generate a summary for a code example using its surrounding context.
    """
    model_choice = os.getenv("MODEL_CHOICE")
    
    prompt = f"""<context_before>
{context_before[-500:] if len(context_before) > 500 else context_before}
</context_before>

<code_example>
{code[:1500] if len(code) > 1500 else code}
</code_example>

<context_after>
{context_after[:500] if len(context_after) > 500 else context_after}
</context_after>

Based on the code example and its surrounding context, provide a concise summary (2-3 sentences) that describes what this code example demonstrates and its purpose. Focus on the practical application and key concepts illustrated.
"""
    
    response = openai.chat.completions.create(
        model=model_choice,
        messages=[...],
        temperature=0.3,
        max_tokens=100
    )
    
    return response.choices[0].message.content.strip()
```

**Key Features:**
- Truncates context to manage token usage (500 chars before/after, 1500 for code)
- Focused prompt for practical application description
- Low temperature (0.3) for consistent outputs

**Applicability to search-mcp:**
- Could add optional LLM-based chunk summarization
- Would require LLM configuration (could reuse LLM extraction config)
- Summaries could be stored in chunk metadata for display

---

## 6. Knowledge Graph (Hallucination Detection)

### 6.1 Neo4j Graph Schema for Code

**Pattern:** Graph representation of code structure for validation

```cypher
// Node Types
Repository {name: string}
File {path: string, module_name: string}
Class {name: string, full_name: string}
Method {name: string, params_list: [string], params_detailed: [string], return_type: string, args: [string]}
Function {name: string, params_list: [string], params_detailed: [string], return_type: string, args: [string]}
Attribute {name: string, type: string}

// Relationships
(Repository)-[:CONTAINS]->(File)
(File)-[:DEFINES]->(Class)
(File)-[:DEFINES]->(Function)
(Class)-[:HAS_METHOD]->(Method)
(Class)-[:HAS_ATTRIBUTE]->(Attribute)
```

### 6.2 Hallucination Detection Workflow

```python
async def check_ai_script_hallucinations(ctx: Context, script_path: str):
    """
    Validate AI-generated code against knowledge graph.
    """
    # 1. Parse script with AST
    analyzer = AIScriptAnalyzer()
    analysis_result = analyzer.analyze_script(script_path)
    
    # 2. Validate against knowledge graph
    validation_result = await knowledge_validator.validate_script(analysis_result)
    
    # 3. Generate comprehensive report
    reporter = HallucinationReporter()
    report = reporter.generate_comprehensive_report(validation_result)
    
    return {
        "overall_confidence": validation_result.overall_confidence,
        "hallucination_rate": report["validation_summary"]["hallucination_rate"],
        "recommendations": report["recommendations"],
        "libraries_analyzed": report.get("libraries_analyzed", [])
    }
```

**Applicability to search-mcp:**
- Would require Neo4j dependency and knowledge graph infrastructure
- Most valuable for AI coding assistant use cases
- Could be a separate MCP server that search-mcp integrates with
- Probably lower priority than other patterns for general search use case

---

## 7. Summary of Applicable Patterns

### High Priority (Immediate Value)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Contextual Embeddings** | Not implemented | LLM-powered chunk enrichment | Medium |
| **Smart URL Detection** | Basic source types | Auto-detect sitemap vs page vs text file | Low |
| **Sitemap Sub-sitemap** | Single-level | Recursive sub-sitemap fetching | Low |
| **Code Example Extraction** | Basic code fence handling | Specialized code chunking + summarization | Medium |

### Medium Priority (Nice to Have)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Hybrid Search Enhancement** | RRF fusion exists | Add ILIKE keyword search to Supabase | Medium |
| **Cross-Encoder Reranking** | Optional reranking exists | Add local ONNX model option | Medium |
| **Supabase Persistence** | In-memory cache | Add optional Supabase/pgvector layer | High |
| **Source Summarization** | Not implemented | LLM-generated source descriptions | Medium |

### Lower Priority (Specialized Use Cases)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Knowledge Graph** | Not implemented | Neo4j + hallucination detection | High |
| **Agentic RAG Tools** | Not implemented | Code-specific search tools | High |

---

## 8. Applicability to semantic_crawl Specifically

While the patterns above are applicable to search-mcp broadly, several have specific high-value applications to the `semantic_crawl` tool:

### 8.1 Contextual Embeddings for Chunk Quality
**Current:** semantic_crawl uses raw markdown chunks  
**Enhancement:** Add optional `useContextualEmbeddings` parameter that uses LLM to generate situating context for each chunk before embedding

```typescript
// In semanticCrawl.ts
if (opts.useContextualEmbeddings) {
  const enrichedChunks = await Promise.all(
    chunks.map(async (chunk) => {
      const context = await generateChunkContext(
        chunk.text, 
        corpusChunks.map(c => c.text).join('\n') // Full corpus context
      );
      return {
        ...chunk,
        text: `${context}\n---\n${chunk.text}`
      };
    })
  );
}
```

**Trade-off:** 2-3x indexing time but significantly better retrieval accuracy for technical content

### 8.2 Code Example Extraction and Specialized Chunking
**Current:** semantic_crawl treats code blocks as regular text  
**Enhancement:** Detect code blocks ≥300 chars, extract with context, generate LLM summary

```typescript
interface CodeChunk extends CorpusChunk {
  type: 'code';
  language: string;
  contextBefore: string;
  contextAfter: string;
  summary?: string; // LLM-generated
}

// In chunking.ts
function extractCodeBlocks(markdown: string): CodeBlock[] {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks: CodeBlock[] = [];
  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const code = match[2].trim();
    if (code.length >= 300) {
      const pos = match.index;
      blocks.push({
        language: match[1] || 'text',
        code,
        contextBefore: markdown.slice(Math.max(0, pos - 1000), pos),
        contextAfter: markdown.slice(pos + match[0].length, pos + match[0].length + 1000),
      });
    }
  }
  return blocks;
}
```

### 8.3 Sitemap Sub-Sitemap Handling
**Current:** semantic_crawl processes single-level sitemaps  
**Enhancement:** Recursively fetch sub-sitemaps from sitemap index files

```typescript
// In semanticCrawl.ts sitemap handling
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const response = await fetch(sitemapUrl);
  const xml = await response.text();
  
  // Check if it's a sitemap index
  if (xml.includes('<sitemapindex')) {
    const sitemapRegex = /<loc>(.*?)<\/loc>/g;
    const subSitemaps: string[] = [];
    let match;
    while ((match = sitemapRegex.exec(xml)) !== null) {
      subSitemaps.push(match[1]);
    }
    
    // Recursively fetch sub-sitemaps (with concurrency limit)
    const allUrls = await Promise.all(
      subSitemaps.slice(0, 10).map(fetchSitemapUrls) // Limit to 10 sub-sitemaps
    );
    return allUrls.flat();
  }
  
  // Regular sitemap - extract URLs
  const urlRegex = /<loc>(.*?)<\/loc>/g;
  const urls: string[] = [];
  let match;
  while ((match = urlRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}
```

### 8.4 Cross-Encoder Reranking Integration
**Current:** semantic_crawl has optional reranking via API  
**Enhancement:** Add local ONNX cross-encoder option (from mcp-crawl4ai-rag pattern)

```typescript
// In semanticCrawl.ts
interface RerankOptions {
  strategy: 'none' | 'api' | 'local';
  model?: string; // for local: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
  topK?: number;
}

// Local reranking using ONNX runtime
async function localRerank(
  query: string, 
  chunks: CorpusChunk[],
  modelPath: string
): Promise<CorpusChunk[]> {
  // Use onnxruntime-node to run cross-encoder model locally
  // Returns chunks sorted by relevance score
  // ~100-200ms latency, no API calls
}
```

---

## 9. Integration Recommendations

### Phase 1: Quick Wins (No Breaking Changes)

1. **Enhanced Sitemap Handling**
   - Add recursive sub-sitemap fetching
   - Detect sitemap index files
   - Minimal code change, high value

2. **Smart URL Content Detection**
   - Auto-detect sitemap vs page vs text file from URL patterns
   - Single source type with internal routing
   - Improves user experience

3. **Code Chunk Enhancement**
   - Add language metadata to chunks from markdown fences
   - Preserve code block context in chunking
   - Foundation for future code-specific features

### Phase 2: Feature Additions (Opt-in)

1. **Contextual Embeddings (Optional)**
   - New `useContextualEmbeddings` parameter to `semantic_crawl`
   - Requires LLM configuration (can reuse existing LLM extraction config)
   - Opt-in due to cost/latency implications

2. **Enhanced Hybrid Search**
   - Add keyword search alongside vector search in RRF fusion
   - Already have BM25, could add ILIKE for databases
   - Incremental improvement to existing system

3. **Source Summarization**
   - Optional LLM-generated source descriptions
   - Store in metadata for display
   - Nice-to-have for documentation browsing

### Phase 3: Infrastructure (Major Additions)

1. **Optional Supabase Persistence**
   - New persistence layer alongside in-memory cache
   - Cross-session RAG capability
   - Significant effort, highest impact

2. **Cross-Encoder Reranking Enhancement**
   - Local ONNX model option for lower latency
   - Alternative to current API-based reranking
   - Performance optimization

---

## 9. Conclusion

The mcp-crawl4ai-rag repository demonstrates several sophisticated RAG patterns that could meaningfully enhance search-mcp:

**Immediate Opportunities:**
1. Sitemap sub-sitemap fetching (low effort, high value)
2. Smart URL content type detection (improves UX)
3. Enhanced code chunking with language metadata (foundation for more)

**Medium-term Additions:**
1. Contextual embeddings (opt-in, significant retrieval improvement)
2. Enhanced hybrid search (incremental RRF improvement)
3. Source summarization (documentation browsing enhancement)

**Long-term Infrastructure:**
1. Optional Supabase persistence (cross-session RAG)
2. Local ONNX cross-encoder (performance optimization)
3. Knowledge graph integration (specialized use cases)

The patterns demonstrate a mature understanding of production RAG challenges: balancing retrieval quality with latency/cost, providing opt-in advanced features, and maintaining clean separation between core and advanced capabilities.

---

## References

1. **mcp-crawl4ai-rag Repository:** https://github.com/coleam00/mcp-crawl4ai-rag.git
2. **Crawl4AI Documentation:** https://crawl4ai.com
3. **Model Context Protocol:** https://modelcontextprotocol.io
4. **pgvector Documentation:** https://github.com/pgvector/pgvector
5. **Cross-Encoders (Sentence-Transformers):** https://www.sbert.net/examples/applications/cross-encoder/README.html
