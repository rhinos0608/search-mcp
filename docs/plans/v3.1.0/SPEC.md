# V3.1.0 — Code / GitHub: Implementation Plan

**Status**: Not Started  
**Priority**: High  
**Depends On**: V3.0.0 (extracted RAG pipeline)  
**Precedes**: V3.2.0 (full domain adapters)

## Overview

Consolidate existing GitHub tools (`github_repo`, `github_repo_file`, `github_repo_search`, `github_repo_tree`) into the RAG pipeline with a dedicated code adapter. Enable semantic query across codebases — "show me where this function is called" — powered by the code adapter.

## Why Now

V3.0.0 extracts the RAG pipeline but doesn't yet exploit the full GitHub integration. Existing tools return file trees, raw content, and search results — great for "find a file by name" but not "find the code that does X."

Adding code-aware retrieval to the pipeline is high-leverage:

- Existing GitHub API + content → semantic retrieval across codebases
- Already have the crawler (githubCorpus.ts)
- Just need to plug into the new pipeline

## Goals

1. Register code adapter in RAG pipeline
2. Create `semantic_github_code` tool for semantic code search
3. Integrate with existing GitHub tools
4. Enable multi-file context for code understanding

## Current Code: githubCorpus.ts

Looking at `src/utils/githubCorpus.ts` (already exists):

```typescript
// Simplified — current implementation
export async function fetchGitHubCorpus(opts: GitHubCorpusOptions): Promise<GitHubCorpusDocument[]>;

interface GitHubCorpusDocument {
  path: string;
  content: string;
  url: string;
}
```

This already collects GitHub file documents. Need to:

1. Keep collection separate from code chunking
2. Add language detection, code chunking, and symbol metadata in the code adapter
3. Plug collected documents into the RAG pipeline

## Code Adapter Interface

```typescript
interface CodeChunk extends Chunk {
  language: string;
  functionName?: string; // extracted from code
  className?: string;
  imports: string[]; // require/import statements
  signature?: string; // function signature
  docstring?: string; // JSDoc/docstring
  complexity?: number; // optional future metric; not required in V3.1.0
  startLine: number;
  endLine: number;
}

interface CodeAdapter extends Adapter {
  type: 'code';

  chunk(docs: RawDocument[], opts: ChunkOpts): CodeChunk[];

  // Code-specific: function/class extraction
  extractSymbols(code: string, language: string): Symbol[];

  // Code-specific: build call graph
  buildCallGraph(chunks: CodeChunk[]): CallGraph;

  // Language detection
  detectLanguage(path: string, content: string): string;
}
```

## Enhancements Over Current githubCorpus

### Language Detection

```typescript
// src/rag/adapters/code.ts

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // ...
};

export function detectLanguage(path: string, content: string): string {
  const ext = path.split('.').pop();
  if (ext && EXTENSION_TO_LANGUAGE[ext]) {
    return EXTENSION_TO_LANGUAGE[ext];
  }
  // Fallback: shebang or magic comment
  if (content.startsWith('#!')) {
    return 'bash';
  }
  return 'unknown';
}
```

### Code-Aware Chunking

Different from text: chunk at function/class boundaries, not token count.

```typescript
export function chunkCode(
  content: string,
  path: string,
  maxChunkTokens: number = 400,
): CodeChunk[] {
  const language = detectLanguage(path, content);

  if (isImperativeLanguage(language)) {
    return chunkBySymbols(content, language, maxChunkTokens);
  }

  // Fallback: token-based like text
  return chunkByTokens(content, maxChunkTokens);
}

function chunkBySymbols(content: string, language: string, maxTokens: number): CodeChunk[] {
  // Extract functions/classes
  const symbols = extractSymbols(content, language);

  // Group into chunks by symbol boundaries
  const chunks: CodeChunk[] = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (const symbol of symbols) {
    const symbolTokens = countTokens(symbol.body);
    if (currentTokens + symbolTokens > maxTokens && chunks.length > 0) {
      // Push current and start new
      chunks.push(buildChunk(currentChunk, language));
      currentChunk = symbol.body;
      currentTokens = symbolTokens;
    } else {
      currentChunk += '\n' + symbol.body;
      currentTokens += symbolTokens;
    }
  }

  // ... handle remaining
  return chunks;
}
```

### Symbol Extraction

```typescript
export function extractSymbols(code: string, language: string): FunctionSymbol[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractJsSymbols(code);
    case 'python':
      return extractPySymbols(code);
    case 'go':
      return extractGoSymbols(code);
    // ... support major languages
    default:
      return [];
  }
}

// Example: TypeScript/JavaScript
interface FunctionSymbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'arrow';
  params: string;
  body: string;
  startLine: number;
  endLine: number;
}

function extractJsSymbols(code: string): FunctionSymbol[] {
  // Parse with regex patterns for function declarations
  // - function name(params) {}
  // - const name = (params) => {}
  // - class Name { method() {} }

  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/gm,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\}/gm,
    /^(?:export\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/gm,
    /^class\s+(\w+)\s*\{([\s\S]*?)\n\}/gm,
  ];

  // ... implementation
}
```

## Tool: semantic_github_code

**Input schema:**

```typescript
{
  query: string,
  repo: string,                    // "owner/repo"
  ref?: string,                     // branch/tag, default "main"
  language?: string,                // filter by language
  maxFiles?: number,                // max files to index, default 50
  fileFilter?: string[],             // glob patterns to include
  topK?: number,
  profile?: RetrievalProfile,
  includeContext?: boolean,        // include call sites, default true
  debug?: boolean
}
```

**Output:** `RetrievalResponse<CodeChunk>` with call context

```typescript
interface SemanticGitHubCodeResponse {
  results: CodeSearchResult[];
  corpusStatus: CorpusStatus;
  retrievalTrace?: RetrievalTrace;
  callGraph?: CallGraphSummary; // optional: call relationships found
}

interface CodeSearchResult {
  chunk: CodeChunk;
  semanticScore: number;
  rank: number;
  callSites?: CallSite[]; // where this function is called
  definitions?: SymbolRef[]; // variable/function definitions
}
```

## Pipeline

```
1. github_repo → repo metadata, default branch
2. github_repo_tree → file tree (filtered by fileFilter)
3. github_repo_file → fetch content in parallel (adaptive concurrency)
4. Code adapter: detect language, chunk by symbols, extract imports/signatures
5. prepareCorpus() with code adapter
6. retrieveCorpus() with code-specific profile (semantic-heavy)
7. Return CodeChunk[] with symbol context
```

## Quality Gates

- [ ] Code adapter handles TypeScript, JavaScript, Python, Go, Rust
- [ ] Chunks respect function/class boundaries, not arbitrary token splits
- [ ] Function names extracted and searchable via semantic query
- [ ] Multi-file context: "where is this function called" returns call sites across files
- [ ] Language filter works

## Integration with Existing Tools

**Preserve existing tools:**

- `github_repo` — repo metadata (used as step 1)
- `github_repo_file` — raw content (used as step 3)
- `github_repo_tree` — file tree (used as step 2)
- `github_repo_search` — filename search

**New tool:**

- `semantic_github_code` — semantic code search across repo

**Rationale:** Existing tools remain useful for "find file by name" queries. Semantic search complements, doesn't replace.

## Files to Create/Modify

**Create:**

1. `src/rag/adapters/code.ts` (adapter + chunking + symbol extraction)
2. `src/tools/semanticGitHubCode.ts` (tool implementation)

**Modify:**

1. `src/rag/adapters/index.ts` (register code adapter)
2. `src/server.ts` (register semantic_github_code)

## Open Questions

1. **Graph database for call graph?**
   - Decision: No for V3.1.0; build in-memory for single-query scope. V3.2+ adds persistence.

2. **Index size limits?**
   - Decision: Default max 50 files, configurable. Large repos need pagination.

## Dependencies

- V3.0.0 RAG pipeline
- GitHub API (existing via tools)
- Embedding sidecar (existing)

## Estimated Scope

- Code adapter: ~600 LOC
- Tool registration: ~200 LOC

**Total new code: ~800 LOC**

---

**Next Step**: V3.2.0 — Full Domain Adapters + Eval
