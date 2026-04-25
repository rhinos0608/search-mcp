# Synthesis: Improvements for semantic_crawl from Research

**Research Date:** 2026-04-24  
**Sources:** 
- mcp-crawl4ai-rag: https://github.com/coleam00/mcp-crawl4ai-rag.git
- agent-search: https://github.com/brcrusoe72/agent-search.git

---

## Executive Summary

This document synthesizes findings from two research projects and identifies specific, high-value improvements that could be made to search-mcp's `semantic_crawl` tool. The improvements are organized by priority and implementation complexity.

### Key Findings

1. **From mcp-crawl4ai-rag:** Advanced RAG patterns (contextual embeddings, code extraction, hybrid search)
2. **From agent-search:** Robust content extraction (kill chain), security (trust checking), and query optimization

---

## Priority 1: High-Value, Implementable Improvements

### 1.1 Kill Chain Content Extraction (from agent-search)

**Current State:** semantic_crawl uses a single extraction method (markdown conversion via Crawl4AI)

**Proposed Enhancement:** Implement a 9-strategy kill chain for content extraction with automatic fallback

```typescript
// New: Kill chain strategies for semantic_crawl
interface KillChainStrategy {
  name: string;
  attempt: (url: string, html?: string) => Promise<string | null>;
  timeout: number;
  applicable: (url: string) => boolean;
}

const KILL_CHAIN_STRATEGIES: KillChainStrategy[] = [
  {
    name: 'crawl4ai-direct',
    attempt: async (url) => {
      const result = await crawl4ai.arun(url);
      return result.markdown || null;
    },
    timeout: 30000,
    applicable: () => true
  },
  {
    name: 'readability-js',
    attempt: async (url, html) => {
      if (!html) return null;
      const document = new JSDOM(html).window.document;
      const reader = new Readability(document);
      const article = reader.parse();
      return article?.textContent || null;
    },
    timeout: 10000,
    applicable: () => true
  },
  {
    name: 'wayback-machine',
    attempt: async (url) => {
      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1&sort=reverse`;
      const cdxRes = await fetch(cdxUrl);
      const data = await cdxRes.json();
      if (data.length < 2) return null;
      
      const timestamp = data[1][1];
      const snapshotUrl = `https://web.archive.org/web/${timestamp}/${url}`;
      const snapshotRes = await fetch(snapshotUrl);
      const html = await snapshotRes.text();
      
      // Extract content from Wayback snapshot
      return extractFromHtml(html);
    },
    timeout: 20000,
    applicable: (url) => !url.includes('web.archive.org')
  },
  {
    name: 'google-cache',
    attempt: async (url) => {
      const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
      const res = await fetch(cacheUrl);
      const html = await res.text();
      return extractFromHtml(html);
    },
    timeout: 10000,
    applicable: () => true
  }
];

// Integration into semanticCrawl.ts
async function extractWithKillChain(
  url: string, 
  options: KillChainOptions
): Promise<KillChainResult> {
  const strategiesTried: string[] = [];
  
  // Pre-check: Domain trust evaluation
  if (options.checkTrust) {
    const trust = await evaluateTrust(url);
    if (trust.tier === 'suspicious') {
      return {
        success: false,
        content: null,
        strategy: null,
        strategiesTried: ['trust-check-failed'],
        error: `Suspicious domain: ${trust.reasons.join(', ')}`,
        trust
      };
    }
  }
  
  // Try each applicable strategy
  for (const strategy of KILL_CHAIN_STRATEGIES) {
    if (!strategy.applicable(url)) continue;
    
    try {
      const result = await Promise.race([
        strategy.attempt(url),
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), strategy.timeout)
        )
      ]);
      
      if (result && result.length >= 200) {
        return {
          success: true,
          content: result,
          strategy: strategy.name,
          strategiesTried: [...strategiesTried, strategy.name],
          trust
        };
      }
      
      strategiesTried.push(strategy.name);
    } catch (e) {
      strategiesTried.push(`${strategy.name}(failed)`);
    }
  }
  
  return {
    success: false,
    content: null,
    strategy: null,
    strategiesTried,
    error: 'All extraction strategies failed',
    trust
  };
}
```

**Impact:** Dramatically improves content extraction success rate, especially for:
- 404 pages (via Wayback Machine)
- Paywalled content (via Google Cache)
- JavaScript-heavy sites (via multiple extraction methods)

---

## Priority 2: Medium-Term Enhancements

### 2.1 Contextual Embeddings (from mcp-crawl4ai-rag)

**Current State:** Chunks are embedded as-is  
**Proposed Enhancement:** Add optional contextual situating via LLM before embedding

```typescript
// In semanticCrawl.ts
async function generateChunkContext(
  chunk: string, 
  fullDocument: string
): Promise<string> {
  const prompt = `
<document>
${fullDocument.slice(0, 25000)}
</document>

<chunk>
${chunk}
</chunk>

Provide a short context to situate this chunk within the overall document for better retrieval.`;

  const response = await llm.complete(prompt, {
    temperature: 0.3,
    maxTokens: 200
  });
  
  return response.text.trim();
}

// Usage in semanticCrawl
if (opts.useContextualEmbeddings) {
  const fullDoc = chunks.map(c => c.text).join('\n');
  const enrichedChunks = await Promise.all(
    chunks.map(async (chunk) => ({
      ...chunk,
      text: `${await generateChunkContext(chunk.text, fullDoc)}\n---\n${chunk.text}`
    }))
  );
  chunks = enrichedChunks;
}
```

**Trade-off:** 2-3x indexing time but significantly better retrieval accuracy

### 2.2 Code Example Extraction (from mcp-crawl4ai-rag)

**Current State:** Code blocks are treated as regular text  
**Proposed Enhancement:** Specialized handling for code examples

```typescript
interface CodeChunk extends CorpusChunk {
  type: 'code';
  language: string;
  contextBefore: string;
  contextAfter: string;
  summary?: string; // LLM-generated
}

function extractCodeBlocks(markdown: string): CodeBlock[] {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks: CodeBlock[] = [];
  let match;
  
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const code = match[2].trim();
    if (code.length >= 300) { // Minimum threshold
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

---

## Summary: Recommended Implementation Order

### Phase 1 (Immediate - Low Risk)
1. **Kill Chain Extraction** - Add Wayback Machine and Google Cache fallbacks
2. **Domain Trust Check** - Add typosquat detection before crawling
3. **Sitemap Sub-Sitemap** - Recursive sitemap index handling

### Phase 2 (Medium Term)
1. **Content Scrubbing** - Security pipeline for injection detection
2. **Contextual Embeddings** - Optional LLM-powered chunk enrichment
3. **Code Extraction** - Specialized code block handling

### Phase 3 (Long Term)
1. **Batch Processing** - Concurrent URL crawling with semaphores
2. **Cross-Encoder Local** - ONNX model for reranking
3. **Self-Improvement** - Track and optimize extraction strategies

---

**Document Version:** 1.0  
**Last Updated:** 2026-04-24  
**Status:** Ready for Implementation Planning
