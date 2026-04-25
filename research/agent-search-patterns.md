# Research: Patterns from agent-search for search-mcp Enhancement

**Repository:** https://github.com/brcrusoe72/agent-search.git  
**Research Date:** 2026-04-24  
**Status:** Planning Phase - No Implementation

---

## Executive Summary

The agent-search repository is a **self-hosted meta-search API** that aggregates results from 70+ search engines via SearXNG. Unlike mcp-crawl4ai-rag (which focuses on RAG/embedding-based retrieval), agent-search focuses on **search aggregation, content extraction, and result ranking**.

### Key Differentiators
- **9-Strategy Kill Chain**: Escalating content extraction with multiple fallback strategies
- **Query Expansion**: Rule-based multi-query fusion without LLM calls
- **Cross-Engine Scoring**: Domain authority + position + engine agreement scoring
- **Self-Improvement Loop**: Adaptive extraction that learns from failures
- **Trust Evaluation**: Typosquat detection and tiered domain trust

---

## 1. Architecture Patterns

### 1.1 Meta-Search Aggregation Layer

**Pattern:** Abstract multiple search engines behind a unified API with result deduplication

```python
# Core aggregation flow (from app/main.py)
async def search(q: str, count: int, engines: Optional[str]) -> SearchResponse:
    # 1. Check cache
    cached_resp = cache.get(q, engines or "", count)
    if cached_resp:
        return cached_resp
    
    # 2. Query SearXNG (aggregates 70+ engines)
    raw = await _query_searxng(q, count * 2, engines)
    
    # 3. Deduplicate and score
    results = deduplicate_with_scoring(raw)
    
    # 4. Apply filters
    if domain:
        results = [r for r in results if domain.lower() in r.url.lower()]
    
    # 5. Fetch content via kill chain if requested
    if fetch:
        kc_results = await kill_chain_batch(http_client, [r.url for r in results])
        for result, kc in zip(results, kc_results):
            result.content = kc.content
    
    # 6. Log and cache
    await query_db.log_query(q, engines_used, len(results), elapsed)
    cache.set(q, engines or "", count, response)
    
    return response
```

**Key Design Decisions:**
1. **SearXNG as upstream**: Delegates engine rotation/rate limiting to SearXNG
2. **Double count for dedup**: Requests 2x results to allow for deduplication
3. **Conditional kill chain**: Content extraction only when explicitly requested
4. **Multi-level caching**: In-memory cache with TTL + content cache for extracted text

**Applicability to search-mcp:**
- search-mcp could add a meta-search tool that aggregates multiple search backends
- Could use similar deduplication logic for combining Brave + SearXNG results
- Kill chain pattern could enhance `web_read` tool with multiple extraction strategies

### 1.2 9-Strategy Kill Chain for Content Extraction

**Pattern:** Escalating fallback chain for extracting content from stubborn URLs

```python
# The kill chain strategies (from app/killchain.py)
async def kill_chain(client, url, searxng_url, content_cache, max_chars):
    strategies_tried = []
    
    # Pre-check: Domain trust evaluation
    trust = evaluate_trust(url, check_whois=False)
    if trust.lookalike_of and not _is_trusted_tld(trust.domain):
        return KillChainResult(
            url=url, content=None, 
            error=f"Blocked: possible typosquat of '{trust.lookalike_of}'",
            trust=trust
        )
    
    # Special handlers first
    if _is_medium(url):
        strategies_tried.append("medium-adapter")
        content = await _strategy_medium(url)
        if content:
            return _success_result(content, "medium-adapter", trust)
    
    if _is_youtube(url):
        strategies_tried.append("youtube")
        content = await strategy_youtube(url)
        if content:
            return _success_result(content, "youtube", trust)
    
    if _is_pdf_url(url):
        strategies_tried.append("pdf")
        content = await strategy_pdf(url)
        if content:
            return _success_result(content, "pdf", trust)
    
    # Web content strategies (escalating)
    web_strategies = [
        ("direct", lambda: strategy_direct(client, url)),
        ("readability", lambda: strategy_readability(client, url)),
        ("ua-rotate", lambda: strategy_ua_rotation(client, url)),
    ]
    
    # Insert Cloudflare bypass if detected
    _cf_adapter = _load_cloudflare_adapter()
    if _cf_adapter and _cf_adapter.can_handle(url):
        web_strategies.append(("cloudflare-bypass", 
            lambda: _strategy_cloudflare(_cf_adapter, url)))
    
    web_strategies.extend([
        ("wayback", lambda: strategy_wayback(client, url)),
        ("google-cache", lambda: strategy_google_cache(client, url)),
        ("search-about", lambda: strategy_search_about(client, url, searxng_url)),
        ("adapter-403", lambda: strategy_adapter(url, "403_forbidden")),
        ("adapter-empty", lambda: strategy_adapter(url, "empty_content")),
        ("adapter-parse", lambda: strategy_adapter(url, "parse_error")),
    ])
    
    # Try each strategy in order
    for name, strategy_fn in web_strategies:
        strategies_tried.append(name)
        try:
            content = await strategy_fn()
            if content and len(content.strip()) >= MIN_USEFUL_CHARS:
                # Success! Tag, sanitize, and return
                content = _tag_content(sanitize_content(content))
                if content_cache:
                    await content_cache.set(url, content, name)
                return KillChainResult(
                    url=url, content=content, strategy=name,
                    chars=len(content), cached=False,
                    strategies_tried=strategies_tried,
                    trust=trust,
                )
        except Exception as e:
            logger.debug(f"Strategy {name} failed for {url}: {e}")
    
    # All strategies exhausted
    return KillChainResult(
        url=url, content=None, strategy=None, chars=0,
        cached=False, strategies_tried=strategies_tried,
        error="All extraction strategies failed",
        trust=trust,
    )
```

**Strategy Details:**

| # | Strategy | When It Works | Cost |
|---|----------|---------------|------|
| 1 | **Direct fetch** | Standard sites | ~200ms |
| 2 | **Readability** | Article pages | ~300ms |
| 3 | **UA rotation** | Blocks by UA | ~400ms |
| 4 | **Cloudflare bypass** | CF-protected | ~2-5s |
| 5 | **Wayback Machine** | Dead pages | ~1-3s |
| 6 | **Google Cache** | Recently cached | ~500ms |
| 7 | **Search-about** | No direct access | ~2-4s |
| 8 | **Custom adapters** | Site-specific | Varies |
| 9 | **PDF/YouTube** | Special formats | Varies |

**Applicability to search-mcp:**
- search-mcp's `web_read` could adopt the kill chain pattern for better extraction
- Could add multiple extraction strategies beyond Mozilla Readability
- Could add Wayback Machine fallback for 404s
- Could add domain-specific adapters

---

## 2. Search Enhancement Patterns

### 2.1 Query Expansion (Rule-Based Multi-Query Fusion)

**Pattern:** Generate 3-5 query variations without LLM calls, then merge results

```python
# From app/query_expansion.py

def generate_query_variations(original_query: str) -> List[str]:
    """Generate 3-5 genuinely different query reformulations."""
    variations = [original_query]
    query_lower = original_query.strip().lower()
    words = query_lower.split()

    # Strategy 1: Question form
    question = _to_question(query_lower, words)
    if question and question.lower() != query_lower:
        variations.append(question)

    # Strategy 2: Concept expansion (synonym replacement)
    expanded = _expand_concepts(original_query, words)
    if expanded and expanded.lower() != query_lower:
        variations.append(expanded)

    # Strategy 3: Opposing viewpoint
    opposing = _opposing_viewpoint(original_query, query_lower, words)
    if opposing and opposing.lower() != query_lower:
        variations.append(opposing)

    # Strategy 4: Domain narrowing or broadening
    scoped = _adjust_scope(original_query, query_lower, words)
    if scoped and scoped.lower() != query_lower:
        variations.append(scoped)

    # Deduplicate and return max 5
    seen = set()
    unique = []
    for v in variations:
        key = v.strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(v)

    return unique[:5]


# Concept expansion with domain-specific mappings
CONCEPT_MAP = {
    "ai": ["artificial intelligence", "machine learning", "deep learning"],
    "llm": ["large language model", "foundation model", "GPT", "Claude"],
    "api": ["interface", "integration", "SDK", "endpoint"],
    "devops": ["deployment automation", "CI/CD", "infrastructure as code"],
    "kubernetes": ["k8s", "container orchestration"],
    "startup": ["early-stage company", "venture-backed"],
    "vc": ["venture capital", "startup funding", "investor"],
    # ... many more
}

# Opposing viewpoint triggers
OPPOSITION_TRIGGERS = {
    "best": "worst problems with",
    "benefits": "risks drawbacks of",
    "advantages": "disadvantages limitations of",
    "success": "failure case study",
    "growing": "declining stagnating",
    "safe": "risks dangers of",
    "easy": "challenges difficulties of",
    "good": "problems criticism of",
    "pros": "cons drawbacks",
}
```

**Trade-offs:**
- **Pros:** No LLM latency/cost, predictable performance, works offline
- **Cons:** Less nuanced than LLM-based expansion, requires maintenance of concept maps

**Applicability to search-mcp:**
- search-mcp could add optional query expansion for `web_search` tool
- Could generate multiple query variations and merge results
- Rule-based approach fits search-mcp's philosophy of minimal dependencies

### 2.2 Cross-Engine Deduplication with Scoring

**Pattern:** Merge results from multiple engines with domain authority scoring

```python
# From app/dedup.py

# Domain authority scores (hardcoded baseline)
DOMAIN_AUTHORITY = {
    'arxiv.org': 0.9,
    'wikipedia.org': 0.9,
    'github.com': 0.8,
    'stackoverflow.com': 0.8,
    'docs.python.org': 0.8,
    'developer.mozilla.org': 0.8,
    'medium.com': 0.5,
    'reddit.com': 0.4,
    'quora.com': 0.3,
}

def deduplicate_with_scoring(raw_results: list[dict]) -> list[SearchResult]:
    """Enhanced deduplication with domain authority and position scoring."""
    seen: dict[str, dict] = {}
    
    # First pass: deduplicate and merge
    for i, r in enumerate(raw_results):
        url = r.get("url", "")
        if not url:
            continue
        norm = _normalize_url(url)
        
        if norm in seen:
            existing = seen[norm]
            # Merge engines
            for e in r.get("engines", []):
                if e not in existing["engines"]:
                    existing["engines"].append(e)
            # Keep longer snippet
            if len(r.get("snippet", "")) > len(existing["snippet"]):
                existing["snippet"] = r["snippet"]
            # Keep best position
            existing["best_position"] = min(existing.get("best_position", i), i)
        else:
            seen[norm] = {
                "title": r.get("title", ""),
                "url": url,
                "snippet": r.get("snippet", ""),
                "engines": list(r.get("engines", [])),
                "best_position": i,
            }

    # Second pass: calculate enhanced scores
    results: list[SearchResult] = []
    
    for item in seen.values():
        # Engine agreement score (0-1)
        all_engines = set().union(*[r.get("engines", []) for r in raw_results])
        engine_score = len(item["engines"]) / max(len(all_engines), 1)
        
        # Domain authority score (0-1)
        domain = urlparse(item["url"]).netloc.lower()
        domain_score = DOMAIN_AUTHORITY.get(domain, 0.2)  # Unknown = low
        
        # Position score (0-1, higher for better positions)
        position_score = 1.0 / (1.0 + item["best_position"] / 10.0)
        
        # Combined score (weighted)
        final_score = (engine_score * 0.4) + (domain_score * 0.3) + (position_score * 0.3)
        
        results.append(SearchResult(
            title=item["title"],
            url=item["url"],
            snippet=item["snippet"],
            engines=item["engines"],
            score=round(final_score, 3),
            position=0,  # Set after sorting
        ))
    
    # Sort by score and set positions
    results.sort(key=lambda x: x.score, reverse=True)
    for i, result in enumerate(results):
        result.position = i + 1
    
    return results
```

**Key Features:**
- **Three-factor scoring**: Engine agreement (40%), domain authority (30%), position (30%)
- **Hardcoded domain authority**: Baseline scores for common domains
- **Position decay**: Earlier positions score higher (exponential decay)
- **Engine merging**: Results appearing in multiple engines get boosted

**Applicability to search-mcp:**
- search-mcp already has multiple search backends (Brave, SearXNG)
- Could add cross-backend deduplication similar to this pattern
- Domain authority scoring could improve result ranking
- Could add position-based scoring for recency bias

---

## 3. Trust and Security Patterns

### 3.1 Domain Trust Evaluation with Typosquat Detection

**Pattern:** Multi-factor domain trust evaluation with fuzzy matching for typosquats

```python
# From app/domain_trust.py (inferred from killchain.py usage)

from dataclasses import dataclass
from typing import Optional
import tldextract
from rapidfuzz import fuzz

@dataclass
class TrustResult:
    domain: str
    tier: str  # "trusted", "neutral", "suspicious", "blocked"
    score: float  # 0-1
    reasons: list[str]
    https: bool
    lookalike_of: Optional[str] = None

# High-value domains to protect from typosquats
PROTECTED_DOMAINS = [
    "google.com", "youtube.com", "facebook.com", "twitter.com",
    "github.com", "amazon.com", "apple.com", "microsoft.com",
    "linkedin.com", "reddit.com", "wikipedia.org", "arxiv.org",
    "openai.com", "anthropic.com", "claude.ai", "chatgpt.com",
]

def evaluate_trust(url: str, check_whois: bool = False) -> TrustResult:
    """Evaluate trust tier of a domain."""
    extracted = tldextract.extract(url)
    domain = f"{extracted.domain}.{extracted.suffix}"
    
    reasons = []
    score = 0.5
    tier = "neutral"
    lookalike_of = None
    
    # Check for typosquats of protected domains
    for protected in PROTECTED_DOMAINS:
        # Fuzzy match on domain name (without TLD)
        protected_name = protected.split('.')[0]
        similarity = fuzz.ratio(extracted.domain, protected_name)
        
        if similarity > 80 and domain != protected:
            lookalike_of = protected
            tier = "suspicious"
            score = 0.1
            reasons.append(f"Possible typosquat of {protected} (similarity: {similarity}%)")
            break
    
    # Check TLD reputation
    suspicious_tlds = {".tk", ".ml", ".ga", ".cf", ".gq", ".buzz", ".top", ".xyz"}
    if f".{extracted.suffix}" in suspicious_tlds:
        tier = "suspicious"
        score -= 0.2
        reasons.append(f"Suspicious TLD: .{extracted.suffix}")
    
    # Check for HTTPS
    https = url.startswith("https://")
    if not https:
        score -= 0.1
        reasons.append("No HTTPS")
    
    # Determine final tier
    if score < 0.3:
        tier = "suspicious"
    elif score > 0.7:
        tier = "trusted"
    
    return TrustResult(
        domain=domain,
        tier=tier,
        score=max(0, min(1, score)),
        reasons=reasons,
        https=https,
        lookalike_of=lookalike_of,
    )
```

**Key Features:**
- **Fuzzy matching**: Uses `rapidfuzz` for typosquat detection
- **Protected domain list**: High-value targets to protect
- **Multi-factor scoring**: TLD reputation, HTTPS, similarity
- **Tiered classification**: trusted/neutral/suspicious/blocked

**Applicability to search-mcp:**
- Could add domain trust checking to `web_read` and `web_search` tools
- Typosquat detection could warn users about suspicious URLs
- Trust scores could be exposed in tool responses
- Could add `blocked_domains` configuration for enterprise use

---

## 4. Summary of Applicable Patterns

### High Priority (Immediate Value)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Kill Chain Extraction** | Mozilla Readability only | 9-strategy fallback chain | Medium |
| **Query Expansion** | Not implemented | Rule-based multi-query fusion | Low |
| **Cross-Backend Deduplication** | Sequential fallback | Parallel + merge with scoring | Medium |
| **Domain Trust Check** | Not implemented | Typosquat + TLD reputation | Low |

### Medium Priority (Nice to Have)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Content Scrubbing** | Basic sanitization | Injection/exfiltration detection | Medium |
| **Batch URL Processing** | Sequential | Concurrent with semaphore | Low |
| **Self-Improvement Loop** | Not applicable | Track extraction failures | High |

### Lower Priority (Specialized Use Cases)

| Pattern | Current search-mcp | Enhancement | Effort |
|---------|-------------------|-------------|--------|
| **Source Library** | Not implemented | Curated domain registry | Medium |
| **Policy Search** | Not implemented | Think tank/gov source focus | Medium |

---

## 5. Integration Recommendations

### Phase 1: Quick Wins

1. **Wayback Machine Fallback for web_read**
   - Add Wayback Machine as fallback when direct fetch returns 404
   - Low effort, high value for accessing dead pages

2. **Domain Trust Warning**
   - Add typosquat detection to `web_read`
   - Warn users about suspicious domains
   - Could be exposed as metadata in response

3. **Query Expansion for web_search**
   - Add optional `expand_query` parameter
   - Generate 2-3 variations and merge results
   - Rule-based approach (no LLM dependency)

### Phase 2: Feature Enhancements

1. **Kill Chain Integration**
   - Refactor `web_read` to use multiple extraction strategies
   - Add UA rotation, readability, Wayback as fallbacks
   - Track which strategy succeeded

2. **Cross-Backend Deduplication**
   - When both Brave and SearXNG are available
   - Query both, deduplicate, and score results
   - Similar to agent-search's cross-engine scoring

3. **Content Scrubbing**
   - Add injection pattern detection
   - Redact potential exfiltration attempts
   - Sanitize content before returning

### Phase 3: Infrastructure

1. **Batch Processing**
   - Add `web_read_batch` tool
   - Concurrent URL fetching with semaphore
   - Shared rate limiting

2. **Self-Improvement Tracking**
   - Track extraction failure patterns
   - Dynamically adjust strategy order
   - Could inform kill chain prioritization

---

## 7. Applicability to semantic_crawl Specifically

While the patterns above are applicable to search-mcp broadly, the **kill chain content extraction** patterns have particularly high-value applications to the `semantic_crawl` tool:

### 7.1 Kill Chain Integration for Crawled Content

**Current:** semantic_crawl uses a single extraction method per page  
**Enhancement:** Apply the 9-strategy kill chain to each crawled page for maximum content extraction success

```typescript
// In semanticCrawl.ts - Kill chain integration
interface KillChainStrategy {
  name: string;
  attempt: (url: string, html: string) => Promise<string | null>;
  timeout: number;
}

const KILL_CHAIN_STRATEGIES: KillChainStrategy[] = [
  { name: 'direct', attempt: extractDirect, timeout: 5000 },
  { name: 'readability', attempt: extractReadability, timeout: 8000 },
  { name: 'ua-rotate', attempt: extractWithUARotation, timeout: 10000 },
  { name: 'wayback', attempt: extractWayback, timeout: 15000 },
  { name: 'google-cache', attempt: extractGoogleCache, timeout: 10000 },
];

async function extractWithKillChain(url: string): Promise<{
  content: string;
  strategy: string;
  strategiesTried: string[];
}> {
  const strategiesTried: string[] = [];
  
  for (const strategy of KILL_CHAIN_STRATEGIES) {
    try {
      const result = await Promise.race([
        strategy.attempt(url, html),
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), strategy.timeout)
        )
      ]);
      
      if (result && result.length >= 200) {
        return {
          content: result,
          strategy: strategy.name,
          strategiesTried: [...strategiesTried, strategy.name]
        };
      }
      
      strategiesTried.push(strategy.name);
    } catch (e) {
      strategiesTried.push(`${strategy.name}(failed)`);
    }
  }
  
  return {
    content: '',
    strategy: 'failed',
    strategiesTried
  };
}
```

### 7.2 Domain Trust Pre-Check

**Current:** semantic_crawl crawls all URLs without trust validation  
**Enhancement:** Add domain trust evaluation before crawling to avoid typosquats and suspicious domains

```typescript
// In semanticCrawl.ts - Trust evaluation
import { evaluateTrust, TrustResult } from './domainTrust';

interface CrawlOptions {
  checkTrust?: boolean;
  minTrustScore?: number;
  blockedDomains?: string[];
}

async function shouldCrawlUrl(url: string, options: CrawlOptions): Promise<{
  allowed: boolean;
  trust?: TrustResult;
  reason?: string;
}> {
  if (!options.checkTrust) {
    return { allowed: true };
  }
  
  const trust = await evaluateTrust(url);
  
  // Block suspicious domains
  if (trust.tier === 'suspicious' || trust.score < (options.minTrustScore || 0.3)) {
    return {
      allowed: false,
      trust,
      reason: `Suspicious domain: ${trust.reasons.join(', ')}`
    };
  }
  
  // Check for typosquats
  if (trust.lookalikeOf) {
    return {
      allowed: false,
      trust,
      reason: `Possible typosquat of ${trust.lookalikeOf}`
    };
  }
  
  return { allowed: true, trust };
}
```

### 7.3 Content Scrubbing for Security

**Current:** semantic_crawl stores raw extracted content  
**Enhancement:** Add content scrubbing pipeline to detect and redact injection attempts

```typescript
// In semanticCrawl.ts - Content scrubbing
interface ScrubResult {
  content: string;
  threatsDetected: ThreatType[];
  riskScore: number;
  redactions: number;
}

type ThreatType = 
  | 'prompt_injection' 
  | 'data_exfiltration' 
  | 'role_play' 
  | 'instruction_override'
  | 'fake_completion'
  | 'xss';

function scrubContent(rawContent: string): ScrubResult {
  let content = rawContent;
  const threatsDetected: ThreatType[] = [];
  let redactions = 0;
  
  // Pattern 1: Prompt injection attempts
  const injectionPatterns = [
    /ignore\s+(previous|above|prior)\s+instructions?/gi,
    /forget\s+(everything|all)\s+(you|you were)/gi,
    /system\s*:\s*/gi,
    /\[\s*system\s*\]/gi,
  ];
  
  for (const pattern of injectionPatterns) {
    if (pattern.test(content)) {
      threatsDetected.push('prompt_injection');
      content = content.replace(pattern, '[REDACTED_INJECTION]');
      redactions++;
    }
  }
  
  // Pattern 2: Data exfiltration attempts
  const exfilPatterns = [
    /send\s+(the|this|that)\s+(data|info|information)\s+to/gi,
    /email\s+(me|us)\s+at/gi,
    /(contact|reach)\s+(me|us)\s+at/gi,
  ];
  
  for (const pattern of exfilPatterns) {
    if (pattern.test(content)) {
      threatsDetected.push('data_exfiltration');
      content = content.replace(pattern, '[REDACTED_EXFIL]');
      redactions++;
    }
  }
  
  // Calculate risk score (0-1)
  const riskScore = Math.min(1, (threatsDetected.length * 0.3) + (redactions * 0.1));
  
  return {
    content,
    threatsDetected: [...new Set(threatsDetected)],
    riskScore,
    redactions
  };
}
```

### 7.4 Batch URL Processing with Concurrency Control

**Current:** semantic_crawl processes URLs sequentially  
**Enhancement:** Add batch processing with semaphore-based concurrency control

```typescript
// In semanticCrawl.ts - Batch processing
interface BatchCrawlOptions {
  urls: string[];
  maxConcurrent: number;
  timeoutMs: number;
  onProgress?: (completed: number, total: number) => void;
}

interface BatchCrawlResult {
  url: string;
  success: boolean;
  content?: string;
  chunks?: CorpusChunk[];
  error?: string;
  strategy?: string;
  strategiesTried?: string[];
}

async function batchCrawl(
  options: BatchCrawlOptions,
  embeddingConfig: EmbeddingConfig
): Promise<BatchCrawlResult[]> {
  const semaphore = new Semaphore(options.maxConcurrent);
  const results: BatchCrawlResult[] = [];
  let completed = 0;
  
  const crawlOne = async (url: string): Promise<BatchCrawlResult> => {
    await semaphore.acquire();
    try {
      // Apply kill chain extraction
      const extraction = await extractWithKillChain(url);
      
      if (!extraction.content) {
        return {
          url,
          success: false,
          error: 'All extraction strategies failed',
          strategiesTried: extraction.strategiesTried
        };
      }
      
      // Chunk and embed
      const chunks = chunkMarkdown(extraction.content);
      const { embeddings, model } = await embedTextsBatched(
        chunks.map(c => c.text),
        embeddingConfig
      );
      
      // Build corpus chunks with embeddings
      const corpusChunks: CorpusChunk[] = chunks.map((chunk, i) => ({
        ...chunk,
        embedding: embeddings[i],
        metadata: {
          ...chunk.metadata,
          extractionStrategy: extraction.strategy,
          extractionSuccess: true
        }
      }));
      
      return {
        url,
        success: true,
        content: extraction.content,
        chunks: corpusChunks,
        strategy: extraction.strategy,
        strategiesTried: extraction.strategiesTried
      };
      
    } catch (error) {
      return {
        url,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      semaphore.release();
      completed++;
      options.onProgress?.(completed, options.urls.length);
    }
  };
  
  // Process all URLs with concurrency limit
  const crawlPromises = options.urls.map(url => crawlOne(url));
  const crawlResults = await Promise.all(crawlPromises);
  
  return crawlResults;
}

// Semaphore implementation for concurrency control
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise<void>(resolve => {
      this.waiting.push(() => {
        this.permits--;
        resolve();
      });
    });
  }
  
  release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) {
        // Permit already decremented in acquire
        this.permits++;
        next();
      }
    }
  }
}
```

### 7.5 Summary: Priority Integration Points for semantic_crawl

| Pattern | Implementation Complexity | Value to semantic_crawl | Priority |
|---------|--------------------------|---------------------------|----------|
| **Kill Chain Extraction** | Medium - Add retry strategies | Very High - Better content extraction success | **P1** |
| **Domain Trust Check** | Low - Pre-crawl validation | High - Security, avoid typosquats | **P1** |
| **Content Scrubbing** | Medium - Security pipeline | High - Prevent injection attacks | **P2** |
| **Batch Processing** | Medium - Concurrency control | Medium - Faster multi-URL crawling | **P2** |
| **Wayback Fallback** | Low - Add fallback strategy | Medium - Recover dead pages | **P3** |

---

## 8. Conclusion

The agent-search repository demonstrates several sophisticated patterns for **search aggregation and content extraction** that could meaningfully enhance search-mcp:

**Immediate Opportunities:**
1. **Wayback Machine fallback** (low effort, high value for 404 recovery)
2. **Domain trust checking** (typosquat detection for security)
3. **Query expansion** (rule-based multi-query fusion)

**Medium-term Additions:**
1. **Kill chain extraction** (multiple fallback strategies for stubborn URLs)
2. **Cross-backend deduplication** (parallel Brave + SearXNG with merging)
3. **Content scrubbing** (injection/exfiltration detection)

**Long-term Infrastructure:**
1. **Batch processing** (concurrent URL fetching)
2. **Self-improvement tracking** (adaptive strategy ordering)
3. **Source library** (curated domain registry)

The patterns demonstrate a mature understanding of production search challenges: balancing coverage with quality, handling failures gracefully, and optimizing for both speed and accuracy.

---

## References

1. **agent-search Repository:** https://github.com/brcrusoe72/agent-search.git
2. **SearXNG Documentation:** https://docs.searxng.org
3. **Wayback Machine CDX API:** https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
4. **rapidfuzz:** https://github.com/maxbachmann/rapidfuzz
5. **Mozilla Readability:** https://github.com/mozilla/readability
