# V3.2.0 — Full Domain Adapters + Eval: Implementation Plan

**Status**: Not Started  
**Priority**: Medium  
**Depends On**: V3.0.0 (core pipeline), V3.0.5 (job MVP), V3.1.0 (code)

## Overview

Complete the domain adapter ecosystem with all listed adapters (academic, QA, job full), add comprehensive three-layer deduplication, constraint-aware ranking, and robust eval harness with metrics. This is the finale of the V3 cycle.

## Why Now

V3.0.0 provided the pipeline infrastructure.
V3.0.5 added job MVP.
V3.1.0 added code adapter.

V3.2.0:

- Fills remaining domain gaps (academic, QA)
- Fixes dedup limitations discovered in real-world use
- Adds eval rigor that V3.0.0 skipped for speed

## Goals

1. Complete all domain adapters
2. Three-layer deduplication
3. Constraint-aware ranking
4. Full eval harness with metrics
5. Observability foundation

## Domain Adapters: Completeness

### Adapter Registry (Final)

| Adapter      | Status        | Source Types            | Notes                                |
| ------------ | ------------- | ----------------------- | ------------------------------------ |
| text         | V3.0.0        | url, sitemap, search    | Default, moved                       |
| transcript   | V3.0.0        | youtube                 | Speaker turns or fixed segments      |
| conversation | V3.0.0        | reddit, hn              | Flatten tree, parent context         |
| code         | V3.1.0        | github                  | Language detection + symbol chunking |
| job          | V3.0.5        | seek, indeed, jora      | MVP + confidence                     |
| academic     | NEW           | arxiv, semantic scholar | Paper structure awareness            |
| qa           | NEW           | stackoverflow           | Question/answer pair preservation    |
| job          | V3.0.5 → FULL | +linkedin, glassdoor    | Full source profiles                 |

### Academic Adapter

```typescript
interface AcademicChunk extends Chunk {
  paperId: string;
  title: string;
  authors: string[];
  abstract: string;
  section:
    | 'abstract'
    | 'introduction'
    | 'related'
    | 'method'
    | 'results'
    | 'discussion'
    | 'references';
  equations: string[]; // detected equations
  figures: string[]; // detected figure references
  citations: string[]; // paper IDs cited
}

interface AcademicAdapter extends Adapter {
  type: 'academic';

  chunk(docs: RawDocument[]): AcademicChunk[];

  // Paper-specific: section detection
  detectSections(paperContent: string): Section[];

  // Paper-specific: citation extraction
  extractCitations(bibliography: string): string[];
}
```

**Pipeline:**

1. `academic_search` → paper list
2. Fetch paper PDFs or parse arxiv abstract
3. Academic adapter chunks by section (abstract, intro, method, results, etc.)
4. `prepareCorpus()` with academic adapter
5. `retrieveCorpus()` with academic-specific profile

**Query examples:**

- "what are the limitations of method X in paper Y"
- "compare approaches in papers about Z"

### QA Adapter

Stack Overflow / Stack Exchange:

```typescript
interface QAChunk extends Chunk {
  questionId: string;
  answerId?: string;
  postType: 'question' | 'answer';
  score: number;
  isAccepted: boolean;
  language?: string;
  tags: string[];
  codeBlocks: string[]; // extracted code snippets
}

interface QAAdapter extends Adapter {
  type: 'qa';

  chunk(docs: RawDocument[]): QAChunk[];

  // QA-specific: preserve question-answer context
  linkAnswers(question: QAChunk, answers: QAChunk[]): LinkedQA[];
}
```

**Pipeline:**

1. `stackoverflow_search` → question list
2. Fetch questions + answers
3. QA adapter: link answers to questions
4. Chunk by question with linked answers
5. `prepareCorpus()` with QA adapter

### Job Adapter (Full)

Add LinkedIn, Glassdoor support with full source profiles:

```typescript
const SOURCE_PROFILES: FullSourceProfiles = {
  seek: {
    baseUrl: 'https://www.seek.com.au',
    authRequired: false,
    rateLimitRpm: 30,
    reliability: 'high',
    structuredData: 'high',
    dedupeStrategy: 'domain',
  },
  indeed: {
    baseUrl: 'https://indeed.com',
    authRequired: false, // optional for employer emails
    rateLimitRpm: 20,
    reliability: 'medium',
    structuredData: 'low',
    dedupeStrategy: 'fingerprint',
  },
  linkedin: {
    baseUrl: 'https://linkedin.com/jobs',
    authRequired: true, // cookie-based
    rateLimitRpm: 10,
    reliability: 'low', // aggressive throttling
    structuredData: 'medium',
    dedupeStrategy: 'title+company',
  },
  glassdoor: {
    baseUrl: 'https://glassdoor.com',
    authRequired: false,
    rateLimitRpm: 15,
    reliability: 'medium',
    structuredData: 'medium',
    dedupeStrategy: 'title+company+location',
  },
};
```

## Three-Layer Deduplication

### Why Three Layers

Current dedup is URL-based. Real-world issues:

1. **Same job, different sites**: Jora copies SEEK listings → `https://jora.com/job/123` = `https://seek.com.au/job/456`
2. **Same employer, different phrasing**: "Software Engineer" vs "Software Dev" → not duplicates at URL level
3. **Near-duplicates**: Small changes (salary "up to $X" vs "$X-$Y") → should be grouped

### Layers

```typescript
interface DedupeConfig {
  layers: {
    url: boolean; // exact URL dedup (default: true)
    fingerprint: boolean; // content fingerprint, 95% similarity (default: true)
    semantic: boolean; // semantic dedup, same entity + role (default: false)
  };
  fingerprintThreshold: number; // 0.95
  semanticThreshold: number; // cosine similarity > 0.90
}

async function deduplicate(corpus: RawDocument[], config: DedupeConfig): Promise<RawDocument[]> {
  let deduped: RawDocument[] = [];
  const urlSeen = new Set<string>();

  // Layer 1: URL dedup
  for (const doc of corpus) {
    if (!urlSeen.has(doc.url)) {
      urlSeen.add(doc.url);
      deduped.push(doc);
    }
  }

  // Layer 2: Fingerprint dedup
  if (config.layers.fingerprint) {
    const fingerprintGroups = new Map<string, RawDocument[]>();
    for (const doc of deduped) {
      const fp = computeFingerprint(doc.content, config.fingerprintThreshold);
      const existing = fingerprintGroups.get(fp) || [];
      existing.push(doc);
      fingerprintGroups.set(fp, existing);
    }
    // Keep longest/most recent per group
    deduped = [...fingerprintGroups.values()].map((g) => mostComplete(g));
  }

  // Layer 3: Semantic dedup
  if (config.layers.semantic) {
    // Embed and cluster by similarity
    const embeddings = await embedTexts(
      deduped.map((d) => d.content),
      'document',
      dims,
    );
    const clusters = clusterBySimilarity(embeddings, config.semanticThreshold);
    deduped = clusters.map((c) => mostRecent(c));
  }

  return deduped;
}
```

## Constraint-Aware Ranking

### From Placeholder to Full

V3.0.0 created placeholder `constraints.ts`. V3.2.0 implements:

```typescript
interface ConstraintConfig {
  hardConstraints: HardConstraint[];
  softConstraints: SoftConstraint[];
  scoringWeights: ConstraintWeights;
}

type HardConstraint =
  | { type: 'location'; values: string[]; tolerance?: number }
  | { type: 'salary'; min?: number; max?: number }
  | { type: 'experience'; min?: number; max?: number }
  | { type: 'workMode'; values: ('remote' | 'hybrid' | 'onsite')[] }
  | { type: 'language'; values: string[] }
  | { type: 'availability'; values: ('now' | 'week' | 'month')[] };

type SoftConstraint =
  | { type: 'companySize'; preferred: string[] }
  | { type: 'techStack'; keywords: string[] }
  | { type: 'remoteFirst'; weight: number };

interface ConstraintResult {
  passedHard: boolean;
  softScore: number;
  matchedConstraints: string[];
  failedConstraints: string[];
}

function rankWithConstraints(
  items: RetrievalResult<T>[],
  query: string,
  config: ConstraintConfig,
): ConstraintResult[] {
  return items
    .map((item) => {
      // Hard constraints: filter
      const hardResults = config.hardConstraints.map((c) => evaluateHard(c, item));
      const passedHard = hardResults.every((r) => r.passed);

      // Soft constraints: score boost
      const softResults = config.softConstraints.map((c) => evaluateSoft(c, item));
      const softScore = softResults.reduce((sum, r) => sum + r.score * r.weight, 0);

      return {
        item,
        passedHard,
        softScore,
        matchedConstraints: hardResults.filter((r) => r.passed).map((r) => r.type),
        failedConstraints: hardResults.filter((r) => !r.passed).map((r) => r.type),
      };
    })
    .filter((r) => r.passedHard);
}
```

## Observability Foundation

### Metrics

```typescript
interface RAGMetrics {
  retrieval: {
    totalQueries: number;
    cacheHits: number;
    avgLatencyMs: p50/p95/p99;
    topKDistribution: number[];
  };
  corpus: {
    totalBuilds: number;
    avgBuildTimeMs: number;
    avgChunkCount: number;
    byAdapter: Record<AdapterType, BuildStats>;
  };
  quality: {
    avgRelevanceScore: number;
    rerankImprovement: number;
    dedupRemovalRate: number;
  };
}
```

### Instrumentation

```typescript
// src/rag/instrumentation.ts

export function withTracing<T>(spanName: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recordMetric(spanName, { success: true, latencyMs: performance.now() - start });
    return result;
  } catch (e) {
    recordMetric(spanName, {
      success: false,
      latencyMs: performance.now() - start,
      error: e.message,
    });
    throw e;
  }
}

// Span hierarchy:
// - prepareCorpus.fetch
// - prepareCorpus.chunk
// - prepareCorpus.embed
// - prepareCorpus.index
// - retrieveCorpus.chunk
// - retrieveCorpus.rank
// - retrieveCorpus.rerank
// - retrieveCorpus.constrain
```

## Eval Harness (Full)

### Eval Structure

```
src/rag/__tests__/eval/
├── golden-queries/
│   ├── youtube.json
│   ├── reddit.json
│   ├── github-code.json
│   ├── jobs.json
│   ├── academic.json
│   └── qa.json
├── runEval.ts
├── metrics.ts
└── thresholds.json
```

### Metrics

```typescript
interface EvalMetrics {
  // Retrieval quality
  recallAt1: number; // expected in top 1
  recallAt3: number; // expected in top 3
  recallAt10: number; // expected in top 10
  mrr: number; // mean reciprocal rank

  // Latency
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;

  // Corpus quality
  avgChunkTokens: number;
  deduplicationRate: number;

  // Failure handling
  partialFailureRecall: number; // 30% failure still returns relevant
}
```

### Test Suites

```
# Run all evals
npm run eval

# Run per adapter
npm run eval:youtube
npm run eval:reddit
npm run eval:github
npm run eval:jobs
npm run eval:academic
npm run eval:qa

# CI integration
# Fail if recall@3 < 0.7 or p95Latency > 10s
```

## Files to Create

1. `src/rag/adapters/academic.ts`
2. `src/rag/adapters/qa.ts`
3. `src/rag/adapters/jobFull.ts`
4. `src/rag/dedup.ts`
5. `src/rag/constraints.ts`
6. `src/rag/instrumentation.ts`
7. `src/rag/metrics.ts`
8. `src/rag/__tests__/eval/runEval.ts`
9. `src/rag/__tests__/eval/golden-queries/*.json`

## Files to Modify

1. `src/rag/adapters/index.ts` (register all adapters)
2. `src/rag/pipeline.ts` (add dedup + constraint pipeline args)
3. `src/tools/semanticJobs.ts` (upgrade to full)

## Quality Gates

- [ ] Academic adapter: chunks by paper section, extracts equations + citations
- [ ] QA adapter: links answers to questions, preserves code blocks
- [ ] Dedupe: three-layer removes 40%+ duplicates on mixed-source corpus
- [ ] Constraints: hard filters work, soft boosts ranking by 0.1-0.2
- [ ] Metrics: all spans logged, p50/p95/p99 latency exported
- [ ] Eval: golden queries cover all adapters, recall@3 >= 0.7
- [ ] Partial failure: 30% source failure returns relevant results

## Dependencies

- V3.0.0 RAG pipeline
- V3.0.5 job adapter
- V3.1.0 code adapter

## Estimated Scope

- Academic adapter: ~300 LOC
- QA adapter: ~300 LOC
- Job full: ~300 LOC
- Dedupe: ~400 LOC
- Constraints: ~300 LOC
- Instrumentation: ~200 LOC
- Eval: ~400 LOC

**Total new code: ~2,000 LOC**

---

**Next Steps Beyond V3**:

- V4.0.0: Multi-corpus RAG (query across corpora)
- Multi-turn agents (clarify, refine)
- Custom scraper builder (user-defined crawlers)
