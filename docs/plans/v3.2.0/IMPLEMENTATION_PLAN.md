# V3.2.0 Implementation Plan - Phased Development with Hard Review Gates

**Status**: Planning Complete  
**Target**: Complete V3.2.0 Domain Adapters + Structured Retrieval + Distribution  
**Estimated LOC**: ~2,840 new + ~660 modified (includes ~340 new + ~160 modified for Phase 6 distribution packaging)

---

## Executive Summary

This plan breaks V3.2.0 into **6 phases** with **hard review gates** between each. Each phase has:

- Clear entry/exit criteria
- Test-driven development workflow
- Review checkpoint with go/no-go decision
- Batch review for efficiency (review multiple related items together)

---

## Current State Assessment

### What Exists ✅

| Component                      | Location                   | Status                                       |
| ------------------------------ | -------------------------- | -------------------------------------------- |
| Base types                     | `src/rag/types.ts`         | Partial - missing Coverage, QueryConstraints |
| Job MVP types                  | `src/rag/types/job.ts`     | Only JobListingMvp, not full                 |
| Job dedup (job-specific)       | `src/rag/jobDedup.ts`      | 3-layer, job-specific                        |
| Job constraints (job-specific) | `src/rag/jobRanking.ts`    | Hard/soft constraints                        |
| Job adapter                    | `src/rag/adapters/job.ts`  | MVP only                                     |
| Code adapter                   | `src/rag/adapters/code.ts` | V3.1.0 complete                              |
| Semantic tools                 | `src/tools/semantic*.ts`   | Partial - missing SO, HN, academic, news     |
| Pipeline                       | `src/rag/pipeline.ts`      | Basic, no dedup/constraints integration      |

### What's Missing ❌

| Component                                             | Needed For                               |
| ----------------------------------------------------- | ---------------------------------------- |
| Generalized dedup module                              | `src/rag/dedup.ts`                       |
| Generalized constraints module                        | `src/rag/constraints.ts`                 |
| Full type system (Coverage, QueryConstraints, scores) | Updated `src/rag/types.ts`               |
| Full JobListing type with salary/experience           | Updated `src/rag/types/job.ts`           |
| Academic adapter                                      | `src/rag/adapters/academic.ts`           |
| QA adapter                                            | `src/rag/adapters/qa.ts`                 |
| Stack Overflow answers tool                           | `src/tools/stackoverflowAnswers.ts`      |
| Instrumentation module                                | `src/rag/instrumentation.ts`             |
| Metrics module                                        | `src/rag/metrics.ts`                     |
| Eval harness                                          | `src/rag/__tests__/eval/`                |
| Golden query fixtures                                 | `src/rag/__tests__/eval/golden-queries/` |

---

## Phase Overview with Review Gates

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 0: Foundation - Type System & Contracts                              │
│  ├─ Entry: Current codebase                                                  │
│  ├─ Exit: All types defined, tests compile (failing), interfaces ready     │
│  └─ Review Gate 0: Type contract review (30 min)                             │
│                                                                              │
│  PHASE 1: Core Infrastructure - Dedup + Constraints                          │
│  ├─ Entry: Review Gate 0 passed                                              │
│  ├─ Exit: Dedup and constraints modules tested and working                   │
│  └─ Review Gate 1: Infrastructure review (45 min)                            │
│                                                                              │
│  PHASE 2: Adapter Ecosystem - Academic + QA                                  │
│  ├─ Entry: Review Gate 1 passed                                                │
│  ├─ Exit: Academic and QA adapters with tests                                │
│  └─ Review Gate 2: Adapter review (60 min)                                     │
│                                                                              │
│  PHASE 3: Integration - Pipeline + Job Upgrade                               │
│  ├─ Entry: Review Gate 2 passed                                                │
│  ├─ Exit: Pipeline integrated, Job adapter upgraded                          │
│  └─ Review Gate 3: Integration review (45 min)                                 │
│                                                                              │
│  PHASE 4: Observability - Instrumentation + Metrics                          │
│  ├─ Entry: Review Gate 3 passed                                                │
│  ├─ Exit: Tracing and metrics working                                        │
│  └─ Review Gate 4: Observability review (30 min)                               │
│                                                                              │
│  PHASE 5: Quality Assurance - Eval Harness + Golden Queries                  │
│  ├─ Entry: Review Gate 4 passed                                                │
│  ├─ Exit: Eval harness with offline tests passing                              │
│  └─ Review Gate 5: Final QA review (60 min)                                    │
│                                                                              │
│  PHASE 6: Distribution - Docker Compose + Ollama + Registry                    │
│  ├─ Entry: Review Gate 5 passed                                                │
│  ├─ Exit: Docker Compose bundle working, Ollama provider tested,               │
│  │         listings submitted to 3 registries                                  │
│  └─ Review Gate 6: Distribution review (30 min)                                │
│                                                                              │
│  RELEASE: V3.2.0                                                              │
│  ├─ Entry: All review gates passed                                             │
│  └─ Exit: Tagged release, docs updated                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Foundation - Type System & Contracts

### Goal

Define all types, interfaces, and contracts. Tests compile but fail (TDD style).

### Entry Criteria

- Current codebase state
- Understanding of V3.2.0 requirements

### Tasks

#### 0.1 Update Core Types (`src/rag/types.ts`)

**Add Missing Interfaces:**

```typescript
// Coverage tracking for retrieval operations
export interface Coverage {
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesPartial: string[];
  sourcesFailed: string[];
  documentsFound: number;
  documentsAfterDedup: number;
  chunksGenerated: number;
  embeddingsGenerated: number;
  retrievalTimeMs: number;
}

// Query constraints for structured retrieval
export interface QueryConstraints {
  hard: {
    location?: string[];
    salary?: { min?: number; max?: number; currency?: string };
    experience?: { min?: number; max?: number };
    workMode?: ('remote' | 'hybrid' | 'onsite')[];
    language?: string[];
    availability?: ('now' | 'week' | 'month')[];
    dateRange?: { from?: Date; to?: Date };
  };
  soft: {
    companySize?: { preferred: string[]; weight: number };
    techStack?: { keywords: string[]; weight: number };
    remoteFirst?: { weight: number };
    sourceReliability?: { weight: number };
    recency?: { weight: number; decay: 'linear' | 'exponential' };
  };
}

// Deduplication configuration
export interface DedupeConfig {
  layers: {
    url: boolean;
    fingerprint: boolean;
    semantic: boolean;
  };
  fingerprintThreshold: number; // default 0.95
  semanticThreshold: number; // default 0.90
  preferKeep: 'newest' | 'mostComplete' | 'highestScore';
}

// Constraint evaluation result
export interface ConstraintEvaluation {
  passedHard: boolean;
  softScore: number; // 0-1
  matchedConstraints: string[];
  failedConstraints: string[];
  explanations: Array<{
    constraint: string;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>;
}
```

**Update Existing Interfaces:**

```typescript
// Update RetrievalResult to include new score fields
export interface RetrievalResult<T = RagChunk> {
  item: T;
  score: RetrievalScore;
  rank: number;
  // New fields for V3.2.0
  constraintScore?: number; // 0-1 from constraint evaluation
  qualityScore?: number; // 0-1 from quality heuristics
  duplicateScore?: number; // 0-1 (higher = more likely duplicate)
  overallScore?: number; // Combined score after all factors
  explanation?: {
    matched: string[]; // What constraints/features matched
    caveats: string[]; // Warnings or limitations
  };
}

// Update RetrievalResponse to include coverage
export interface RetrievalResponse<T = RagChunk> {
  corpus: PreparedCorpus;
  results: RetrievalResult<T>[];
  trace: RetrievalTrace;
  coverage?: Coverage; // New for V3.2.0
  warnings?: string[];
}
```

#### 0.2 Update Job Types (`src/rag/types/job.ts`)

**Add Full JobListing Type:**

```typescript
// Enhanced salary structure
export interface SalaryRange {
  min?: number;
  max?: number;
  currency?: string;
  unit: 'hour' | 'day' | 'week' | 'month' | 'year';
  raw: string; // Original text
}

// Experience requirements
export interface ExperienceRange {
  min?: number;
  max?: number;
  unit: 'month' | 'year';
}

// Structured requirements
export interface JobRequirement {
  category: 'essential' | 'preferred' | 'nice_to_have';
  skill?: string;
  years?: number;
  description: string;
}

// Full job listing (replaces MVP)
export interface JobListing {
  // Core fields
  title: string;
  company?: string;
  location?: string;
  workMode: WorkMode;

  // Structured salary
  salary?: SalaryRange;

  // Experience
  seniority?: 'entry' | 'mid' | 'senior' | 'lead' | 'executive';
  experience?: ExperienceRange;

  // Requirements
  requirements: JobRequirement[];
  niceToHave?: string[];

  // Application
  applyUrl?: string;

  // Metadata
  source: JobSource;
  sourceUrl?: string;
  jobId?: string;

  // Dates
  postedAt?: Date | null;
  expiresAt?: Date | null;

  // Search/retrieval
  extractedText: string;
  confidence: JobFieldConfidence;
  verificationStatus: VerificationStatus;
  caveats: string[];

  // Embeddings for semantic dedup
  embedding?: number[];
  bm25Tokens?: string[];
}
```

#### 0.3 Create Placeholder Files

Create empty files with `// TODO: Phase X` comments so imports work during development:

```bash
# Phase 1 files
touch src/rag/dedup.ts
touch src/rag/constraints.ts

# Phase 2 files
touch src/rag/adapters/academic.ts
touch src/rag/adapters/qa.ts
touch src/tools/stackoverflowAnswers.ts

# Phase 4 files
touch src/rag/instrumentation.ts
touch src/rag/metrics.ts

# Phase 5 files
mkdir -p src/rag/__tests__/eval/golden-queries
touch src/rag/__tests__/eval/runEval.ts
touch src/rag/__tests__/eval/metrics.ts

# Phase 6 files
touch Dockerfile
touch docker-compose.yml
mkdir -p searxng
touch searxng/settings.yml
touch src/utils/ollamaEmbedding.ts
touch src/utils/transformersEmbedding.ts
touch docs/comparison.md
```

### Exit Criteria

- [ ] All type definitions added to `src/rag/types.ts`
- [ ] Full `JobListing` type defined in `src/rag/types/job.ts`
- [ ] Placeholder files created for all modules
- [ ] `npm run typecheck` passes (with placeholders returning `any` or `{}`)
- [ ] All imports resolve (no "module not found" errors)

### Review Gate 0: Foundation Review (30 minutes)

**Checklist:**

- [ ] Type system is complete and consistent
- [ ] All V3.2.0 required types are present
- [ ] JobListing type is comprehensive
- [ ] No circular type dependencies
- [ ] Placeholder files don't break the build

**Reviewers:** Self-review + optional code review

**Go/No-Go Criteria:**

- GO: All checklist items pass, types are solid
- NO-GO: Type issues found, fix and re-review

---

## Phase 1: Core Infrastructure - Dedup + Constraints

### Goal

Build the foundational deduplication and constraint modules that all adapters will use.

### Entry Criteria

- Review Gate 0 passed
- Type system is stable

### Tasks

#### 1.1 Deduplication Module (`src/rag/dedup.ts`)

**Types:**

```typescript
export interface DedupeConfig {
  layers: {
    url: boolean;
    fingerprint: boolean;
    semantic: boolean;
  };
  fingerprintThreshold: number;
  semanticThreshold: number;
  preferKeep: 'newest' | 'mostComplete' | 'highestScore';
}

export interface DedupeLayer {
  name: 'url' | 'fingerprint' | 'semantic';
  removed: number;
  kept: number;
  timeMs: number;
}

export interface DedupeDecision<T> {
  item: T;
  kept: boolean;
  reason: 'unique' | 'duplicate' | 'preferred';
  duplicateOf?: string;
}

export interface DedupeGroup<T> {
  key: string;
  items: T[];
  selected: T;
  discarded: T[];
}

export interface DedupeResult<T> {
  items: T[];
  decisions: DedupeDecision<T>[];
  layers: DedupeLayer[];
  totalTimeMs: number;
}
```

**Functions:**

```typescript
// URL deduplication - normalizes URLs and removes exact duplicates
export function dedupeByUrl<T extends { url: string }>(
  items: T[],
  options?: { normalize?: boolean; removeTracking?: boolean },
): DedupeResult<T>;

// Fingerprint deduplication - uses content similarity
export function dedupeByFingerprint<T extends { text: string; id: string }>(
  items: T[],
  threshold: number,
): DedupeResult<T>;

// Semantic deduplication - uses embeddings for similarity
export async function dedupeBySemantic<
  T extends {
    id: string;
    text: string;
    embedding?: number[];
  },
>(
  items: T[],
  threshold: number,
  embedFn?: (texts: string[]) => Promise<number[][]>,
): Promise<DedupeResult<T>>;

// Main deduplication pipeline
export async function deduplicateCorpus<
  T extends {
    url: string;
    text: string;
    id: string;
    embedding?: number[];
  },
>(
  items: T[],
  config: DedupeConfig,
  embedFn?: (texts: string[]) => Promise<number[][]>,
): Promise<DedupeResult<T>>;

// Utility functions
export function normalizeUrl(url: string): string;
export function computeFingerprint(text: string, threshold?: number): string;
export function clusterBySimilarity(embeddings: number[][], threshold: number): number[][]; // Returns indices of clusters
export function selectPreferred<T>(
  items: T[],
  strategy: 'newest' | 'mostComplete' | 'highestScore',
  scoreFn?: (item: T) => number,
): T;
```

**Tests (TDD):**

```typescript
// src/rag/__tests__/dedup.test.ts

describe('dedupeByUrl', () => {
  it('removes exact URL duplicates', () => {
    const items = [
      { url: 'https://example.com/job1', text: 'Job 1' },
      { url: 'https://example.com/job1', text: 'Job 1 dup' },
      { url: 'https://example.com/job2', text: 'Job 2' },
    ];
    const result = dedupeByUrl(items);
    expect(result.items).toHaveLength(2);
    expect(result.layers[0].removed).toBe(1);
  });

  it('normalizes URLs before comparison', () => {
    const items = [
      { url: 'https://example.com/job?tracking=123', text: 'Job 1' },
      { url: 'https://example.com/job', text: 'Job 1 no tracking' },
    ];
    const result = dedupeByUrl(items, { normalize: true, removeTracking: true });
    expect(result.items).toHaveLength(1);
  });
});

describe('dedupeByFingerprint', () => {
  it('removes near-duplicate content', () => {
    const items = [
      { id: '1', text: 'Software Engineer role at TechCorp. Requirements: Python, React.' },
      {
        id: '2',
        text: 'Software Engineer role at TechCorp. Requirements: Python, React, TypeScript.',
      },
      { id: '3', text: '完全不同的工作内容在这里' },
    ];
    const result = dedupeByFingerprint(items, 0.95);
    // Items 1 and 2 should be considered duplicates
    expect(result.items.length).toBeLessThan(3);
  });
});

describe('dedupeBySemantic', () => {
  it('clusters similar items by embedding', async () => {
    const items = [
      { id: '1', text: 'Senior Software Engineer position' },
      { id: '2', text: 'Senior Software Developer role' },
      { id: '3', text: 'Marketing Manager position' },
    ];
    // Mock embedding function
    const mockEmbed = async (texts: string[]) => {
      // Simple mock: similar texts get similar embeddings
      return texts.map((t) => {
        if (t.includes('Engineer') || t.includes('Developer')) return [1, 0.9, 0.1];
        return [0.1, 0.2, 1];
      });
    };

    const result = await dedupeBySemantic(items, 0.85, mockEmbed);
    expect(result.items.length).toBe(2); // Engineer and Developer should cluster
  });
});

describe('deduplicateCorpus', () => {
  it('runs all three layers in sequence', async () => {
    const config: DedupeConfig = {
      layers: { url: true, fingerprint: true, semantic: true },
      fingerprintThreshold: 0.95,
      semanticThreshold: 0.85,
      preferKeep: 'mostComplete',
    };

    const items = [
      { id: '1', url: 'https://example.com/job1', text: 'Engineer role' },
      { id: '2', url: 'https://example.com/job1', text: 'Engineer role duplicate' },
      { id: '3', url: 'https://example.com/job2', text: 'Engineer position' },
    ];

    const result = await deduplicateCorpus(items, config);
    expect(result.layers).toHaveLength(3);
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });
});
```

#### 1.2 Constraints Module (`src/rag/constraints.ts`)

**Types:**

```typescript
// Hard constraints - items must match all
export type HardConstraint =
  | { type: 'location'; values: string[]; tolerance?: 'exact' | 'region' | 'country' }
  | { type: 'salary'; min?: number; max?: number; currency?: string }
  | { type: 'experience'; min?: number; max?: number; unit: 'month' | 'year' }
  | { type: 'workMode'; values: ('remote' | 'hybrid' | 'onsite')[] }
  | { type: 'language'; values: string[]; requireAll?: boolean }
  | { type: 'availability'; values: ('now' | 'week' | 'month')[] }
  | { type: 'dateRange'; from?: Date; to?: Date };

// Soft constraints - boost matching items
export type SoftConstraint =
  | { type: 'companySize'; preferred: string[]; weight: number }
  | { type: 'techStack'; keywords: string[]; weight: number; match: 'any' | 'all' }
  | { type: 'remoteFirst'; weight: number }
  | { type: 'sourceReliability'; preferred: ('high' | 'medium')[]; weight: number }
  | { type: 'recency'; weight: number; decay: 'linear' | 'exponential'; halfLifeDays?: number };

export interface ConstraintConfig {
  hardConstraints: HardConstraint[];
  softConstraints: SoftConstraint[];
  strictMode: boolean; // If true, unknown values fail hard constraints
}

export interface ConstraintEvaluation {
  passedHard: boolean;
  softScore: number; // 0-1
  matchedConstraints: string[];
  failedConstraints: string[];
  explanations: Array<{
    constraint: string;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>;
}

export interface ConstraintRankedResult<T> {
  item: T;
  originalRank: number;
  constraintEvaluation: ConstraintEvaluation;
  finalScore: number; // Combined retrieval + constraint score
}
```

**Functions:**

```typescript
// Evaluate a single item against all constraints
export function evaluateConstraints<T>(
  item: T,
  config: ConstraintConfig,
  extractors: ConstraintExtractors<T>,
): ConstraintEvaluation;

// Apply constraints to ranked results
export function applyConstraints<T>(
  results: RetrievalResult<T>[],
  config: ConstraintConfig,
  extractors: ConstraintExtractors<T>,
): ConstraintRankedResult<T>[];

// Extractor interface - adapters provide these
export interface ConstraintExtractors<T> {
  location?: (item: T) => string | undefined;
  salary?: (item: T) => { min?: number; max?: number; currency?: string } | undefined;
  experience?: (item: T) => { min?: number; max?: number } | undefined;
  workMode?: (item: T) => string | undefined;
  language?: (item: T) => string[] | undefined;
  companySize?: (item: T) => string | undefined;
  techStack?: (item: T) => string[] | undefined;
  sourceReliability?: (item: T) => 'high' | 'medium' | 'low';
  postedDate?: (item: T) => Date | undefined;
}

// Individual constraint evaluators
export function evaluateLocation(value: string, constraint: HardConstraint): boolean;
export function evaluateSalary(
  value: { min?: number; max?: number },
  constraint: HardConstraint,
): boolean;
export function evaluateExperience(
  value: { min?: number; max?: number },
  constraint: HardConstraint,
): boolean;

// Soft constraint scorers
export function scoreCompanySize(value: string, constraint: SoftConstraint): number;
export function scoreTechStack(value: string[], constraint: SoftConstraint): number;
export function scoreRecency(date: Date, constraint: SoftConstraint): number;
```

**Tests (TDD):**

```typescript
// src/rag/__tests__/constraints.test.ts

describe('evaluateConstraints', () => {
  interface TestItem {
    location: string;
    salary: { min: number; max: number; currency: string };
    experience: { min: number; max: number };
  }

  const extractors: ConstraintExtractors<TestItem> = {
    location: (item) => item.location,
    salary: (item) => item.salary,
    experience: (item) => item.experience,
  };

  it('passes when all hard constraints match', () => {
    const item: TestItem = {
      location: 'Sydney',
      salary: { min: 100000, max: 150000, currency: 'AUD' },
      experience: { min: 3, max: 5 },
    };

    const config: ConstraintConfig = {
      hardConstraints: [
        { type: 'location', values: ['Sydney', 'Melbourne'] },
        { type: 'salary', min: 80000 },
      ],
      softConstraints: [],
      strictMode: false,
    };

    const result = evaluateConstraints(item, config, extractors);
    expect(result.passedHard).toBe(true);
    expect(result.matchedConstraints).toContain('location');
    expect(result.matchedConstraints).toContain('salary');
  });

  it('fails hard constraints when location does not match', () => {
    const item: TestItem = {
      location: 'Perth',
      salary: { min: 100000, max: 150000, currency: 'AUD' },
      experience: { min: 3, max: 5 },
    };

    const config: ConstraintConfig = {
      hardConstraints: [{ type: 'location', values: ['Sydney', 'Melbourne'] }],
      softConstraints: [],
      strictMode: false,
    };

    const result = evaluateConstraints(item, config, extractors);
    expect(result.passedHard).toBe(false);
    expect(result.failedConstraints).toContain('location');
  });

  it('calculates soft constraint scores', () => {
    const item = {
      companySize: 'large',
      techStack: ['python', 'react', 'typescript'],
    };

    const extractors: ConstraintExtractors<typeof item> = {
      companySize: (i) => i.companySize,
      techStack: (i) => i.techStack,
    };

    const config: ConstraintConfig = {
      hardConstraints: [],
      softConstraints: [
        { type: 'companySize', preferred: ['startup', 'large'], weight: 0.3 },
        { type: 'techStack', keywords: ['python', 'typescript'], weight: 0.7 },
      ],
      strictMode: false,
    };

    const result = evaluateConstraints(item, config, extractors);
    expect(result.softScore).toBeGreaterThan(0);
    expect(result.softScore).toBeLessThanOrEqual(1);
  });

  it('handles unknown values in non-strict mode', () => {
    const item = { location: undefined };

    const extractors: ConstraintExtractors<typeof item> = {
      location: (i) => i.location,
    };

    const config: ConstraintConfig = {
      hardConstraints: [{ type: 'location', values: ['Sydney'] }],
      softConstraints: [],
      strictMode: false, // Non-strict: unknown doesn't fail
    };

    const result = evaluateConstraints(item, config, extractors);
    expect(result.passedHard).toBe(true); // Unknown doesn't fail in non-strict
  });

  it('fails unknown values in strict mode', () => {
    const item = { location: undefined };

    const extractors: ConstraintExtractors<typeof item> = {
      location: (i) => i.location,
    };

    const config: ConstraintConfig = {
      hardConstraints: [{ type: 'location', values: ['Sydney'] }],
      softConstraints: [],
      strictMode: true, // Strict: unknown fails
    };

    const result = evaluateConstraints(item, config, extractors);
    expect(result.passedHard).toBe(false);
  });
});

describe('applyConstraints', () => {
  it('filters out items that fail hard constraints', () => {
    const results: RetrievalResult<TestItem>[] = [
      {
        item: {
          location: 'Sydney',
          salary: { min: 100000, max: 150000, currency: 'AUD' },
          experience: { min: 3, max: 5 },
        },
        score: { fused: 0.9 },
        rank: 1,
      },
      {
        item: {
          location: 'Perth',
          salary: { min: 80000, max: 120000, currency: 'AUD' },
          experience: { min: 2, max: 4 },
        },
        score: { fused: 0.85 },
        rank: 2,
      },
    ];

    const config: ConstraintConfig = {
      hardConstraints: [{ type: 'location', values: ['Sydney'] }],
      softConstraints: [],
      strictMode: false,
    };

    const extractors: ConstraintExtractors<TestItem> = {
      location: (item) => item.location,
      salary: (item) => item.salary,
      experience: (item) => item.experience,
    };

    const ranked = applyConstraints(results, config, extractors);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item.location).toBe('Sydney');
  });

  it('calculates final scores combining retrieval and constraint scores', () => {
    // Test that soft constraints boost scores appropriately
  });
});
```

### Exit Criteria

- [ ] `dedupe.ts` implements all three dedup layers
- [ ] `constraints.ts` implements hard/soft constraint evaluation
- [ ] All tests pass (`npm test`)
- [ ] 90%+ code coverage on new modules

### Review Gate 1: Infrastructure Review (45 minutes)

**Checklist:**

- [ ] Dedup logic is correct for all three layers
- [ ] URL normalization handles edge cases
- [ ] Fingerprint similarity is accurate
- [ ] Constraint evaluation handles all constraint types
- [ ] Hard constraints filter correctly
- [ ] Soft constraints score appropriately
- [ ] Edge cases handled (unknown values, strict mode)

**Review Activities:**

- Code review of dedup algorithms
- Constraint logic walkthrough
- Test coverage review
- Edge case discussion

**Go/No-Go Criteria:**

- GO: All infrastructure solid, ready for adapters
- NO-GO: Issues found, fix and re-review

---

## Phase 2: Adapter Ecosystem - Academic + QA

### Goal

Build the Academic and QA adapters with full test coverage.

### Entry Criteria

- Review Gate 1 passed
- Dedup and constraints modules are stable

### Tasks

#### 2.1 Stack Overflow Answers Tool (`src/tools/stackoverflowAnswers.ts`)

This is a prerequisite for the QA adapter. It fetches full question and answer content.

```typescript
export interface StackOverflowQuestion {
  questionId: number;
  title: string;
  body: string;
  tags: string[];
  score: number;
  viewCount: number;
  answerCount: number;
  acceptedAnswerId?: number;
  creationDate: Date;
  lastActivityDate: Date;
  owner: {
    userId: number;
    displayName: string;
    reputation: number;
  };
  link: string;
}

export interface StackOverflowAnswer {
  answerId: number;
  questionId: number;
  body: string;
  score: number;
  isAccepted: boolean;
  creationDate: Date;
  lastEditDate?: Date;
  owner: {
    userId: number;
    displayName: string;
    reputation: number;
  };
  link: string;
}

export interface FetchQuestionOptions {
  includeAnswers?: boolean;
  includeBody?: boolean;
  filter?: string; // Stack Exchange API filter
}

export interface FetchAnswersOptions {
  sort?: 'activity' | 'creation' | 'votes';
  order?: 'desc' | 'asc';
  pageSize?: number;
}

// Main functions
export async function fetchQuestionById(
  questionId: number,
  options?: FetchQuestionOptions,
  apiKey?: string,
): Promise<StackOverflowQuestion>;

export async function fetchAnswersForQuestion(
  questionId: number,
  options?: FetchAnswersOptions,
  apiKey?: string,
): Promise<StackOverflowAnswer[]>;

export async function fetchQuestionWithAnswers(
  questionId: number,
  options?: { answerOptions?: FetchAnswersOptions; apiKey?: string },
): Promise<{ question: StackOverflowQuestion; answers: StackOverflowAnswer[] }>;

// Batch fetch for multiple questions
export async function fetchQuestionsBatch(
  questionIds: number[],
  options?: FetchQuestionOptions,
  apiKey?: string,
): Promise<StackOverflowQuestion[]>;

// Extract code blocks from HTML body
export function extractCodeBlocks(htmlBody: string): Array<{
  language?: string;
  code: string;
}>;

// Build search query for Stack Exchange API
export function buildSearchQuery(params: {
  intitle?: string;
  tagged?: string[];
  notTagged?: string[];
  minScore?: number;
  hasAnswers?: boolean;
  accepted?: boolean;
}): string;
```

**Tests:**

```typescript
// src/tools/__tests__/stackoverflowAnswers.test.ts

describe('fetchQuestionById', () => {
  it('fetches question with correct structure', async () => {
    const mockResponse = {
      items: [
        {
          question_id: 12345,
          title: 'How to use TypeScript?',
          body: '<p>Question body</p>',
          tags: ['typescript', 'javascript'],
          score: 100,
          view_count: 1000,
          answer_count: 5,
          accepted_answer_id: 12346,
          creation_date: 1609459200,
          last_activity_date: 1609545600,
          owner: { user_id: 1, display_name: 'John', reputation: 5000 },
          link: 'https://stackoverflow.com/q/12345',
        },
      ],
    };

    // Mock fetch
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      json: async () => mockResponse,
    } as Response);

    const question = await fetchQuestionById(12345);
    expect(question.questionId).toBe(12345);
    expect(question.title).toBe('How to use TypeScript?');
    expect(question.tags).toContain('typescript');
  });
});

describe('extractCodeBlocks', () => {
  it('extracts code blocks with language', () => {
    const html = `
      <pre><code class="language-typescript">const x: number = 1;</code></pre>
      <pre><code>Plain code block</code></pre>
    `;
    const blocks = extractCodeBlocks(html);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('typescript');
    expect(blocks[0].code).toBe('const x: number = 1;');
    expect(blocks[1].language).toBeUndefined();
  });
});
```

#### 2.2 QA Adapter (`src/rag/adapters/qa.ts`)

```typescript
import type { Adapter, RawDocument, RagChunk } from '../types.js';
import type {
  StackOverflowQuestion,
  StackOverflowAnswer,
} from '../../tools/stackoverflowAnswers.js';

export interface QAChunk extends RagChunk {
  questionId: number;
  answerId?: number;
  postType: 'question' | 'answer';
  score: number;
  isAccepted: boolean;
  language?: string;
  tags: string[];
  codeBlocks: Array<{ language?: string; code: string }>;
  // Linking
  questionTitle?: string;
  questionBody?: string;
  answerCount?: number;
  viewCount?: number;
}

export interface QAAdapterOptions {
  includeAnswers?: boolean;
  includeCodeBlocks?: boolean;
  minScore?: number;
  preferredTags?: string[];
}

export interface QAAdapter extends Adapter {
  type: 'qa';
  options: QAAdapterOptions;

  // Main chunking method
  chunk(docs: RawDocument[]): QAChunk[];

  // QA-specific: link answers to questions
  linkAnswers(question: QAChunk, answers: QAChunk[]): LinkedQA;

  // Extract and preserve code blocks
  extractCodeBlocks(htmlBody: string): Array<{ language?: string; code: string }>;

  // Build context-rich chunks
  buildQuestionChunk(question: StackOverflowQuestion): QAChunk;
  buildAnswerChunk(answer: StackOverflowAnswer, question: StackOverflowQuestion): QAChunk;
}

export interface LinkedQA {
  question: QAChunk;
  answers: QAChunk[];
  acceptedAnswer?: QAChunk;
  topAnswer?: QAChunk;
  totalScore: number;
}

// Factory function
export function createQAAdapter(options?: QAAdapterOptions): QAAdapter;

// Helper to convert Stack Overflow data to RawDocument
export function stackOverflowToRawDocument(
  question: StackOverflowQuestion,
  answers?: StackOverflowAnswer[],
): RawDocument;
```

**Tests (TDD):**

```typescript
// src/rag/__tests__/adapters/qa.test.ts

describe('QAAdapter', () => {
  const mockQuestion: StackOverflowQuestion = {
    questionId: 12345,
    title: 'How to use TypeScript with React?',
    body: '<p>I want to use TypeScript with React...</p><pre><code>const App: React.FC = () => {}</code></pre>',
    tags: ['typescript', 'react', 'javascript'],
    score: 50,
    viewCount: 1000,
    answerCount: 3,
    acceptedAnswerId: 12346,
    creationDate: new Date('2023-01-01'),
    lastActivityDate: new Date('2023-06-01'),
    owner: { userId: 1, displayName: 'John', reputation: 5000 },
    link: 'https://stackoverflow.com/q/12345',
  };

  const mockAnswer: StackOverflowAnswer = {
    answerId: 12346,
    questionId: 12345,
    body: '<p>You can use TypeScript with React like this:</p><pre><code>const App: React.FC = () => { return <div>Hello</div>; };</code></pre>',
    score: 25,
    isAccepted: true,
    creationDate: new Date('2023-01-02'),
    owner: { userId: 2, displayName: 'Jane', reputation: 3000 },
    link: 'https://stackoverflow.com/a/12346',
  };

  describe('chunk', () => {
    it('creates chunks from Stack Overflow documents', () => {
      const adapter = createQAAdapter();
      const doc = stackOverflowToRawDocument(mockQuestion, [mockAnswer]);
      const chunks = adapter.chunk([doc]);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].postType).toBe('question');
      expect(chunks[0].questionId).toBe(12345);
    });

    it('preserves code blocks in chunks', () => {
      const adapter = createQAAdapter();
      const doc = stackOverflowToRawDocument(mockQuestion);
      const chunks = adapter.chunk([doc]);

      const questionChunk = chunks.find((c) => c.postType === 'question');
      expect(questionChunk?.codeBlocks.length).toBeGreaterThan(0);
      expect(questionChunk?.codeBlocks[0].code).toContain('const App');
    });
  });

  describe('linkAnswers', () => {
    it('links answers to their question', () => {
      const adapter = createQAAdapter();
      const questionChunk: QAChunk = {
        id: 'q-12345',
        text: mockQuestion.body,
        questionId: 12345,
        postType: 'question',
        score: 50,
        isAccepted: false,
        tags: ['typescript', 'react'],
        codeBlocks: [],
        metadata: {},
      };

      const answerChunk: QAChunk = {
        id: 'a-12346',
        text: mockAnswer.body,
        questionId: 12345,
        answerId: 12346,
        postType: 'answer',
        score: 25,
        isAccepted: true,
        tags: [],
        codeBlocks: [],
        metadata: {},
      };

      const linked = adapter.linkAnswers(questionChunk, [answerChunk]);
      expect(linked.question).toBe(questionChunk);
      expect(linked.answers).toHaveLength(1);
      expect(linked.acceptedAnswer).toBe(answerChunk);
    });
  });
});
```

#### 2.3 Academic Adapter (`src/rag/adapters/academic.ts`)

```typescript
import type { Adapter, RawDocument, RagChunk } from '../types.js';

export interface AcademicChunk extends RagChunk {
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
  equations: string[];
  figures: string[];
  citations: string[];
  venue?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
}

export interface AcademicAdapterOptions {
  includeAbstract?: boolean;
  includeFullText?: boolean;
  sectionChunkSize?: number;
  preserveEquations?: boolean;
  minSectionLength?: number;
}

export interface AcademicAdapter extends Adapter {
  type: 'academic';
  options: AcademicAdapterOptions;

  chunk(docs: RawDocument[]): AcademicChunk[];

  // Academic-specific methods
  detectSections(paperContent: string): Array<{
    type: AcademicChunk['section'];
    start: number;
    end: number;
    content: string;
  }>;

  extractCitations(text: string): string[];
  extractEquations(text: string): string[];
  extractFigures(text: string): string[];

  // Build chunks from paper sections
  buildAbstractChunk(paper: PaperMetadata, abstract: string): AcademicChunk;
  buildSectionChunk(
    paper: PaperMetadata,
    section: { type: string; content: string },
  ): AcademicChunk[];
}

export interface PaperMetadata {
  paperId: string;
  title: string;
  authors: string[];
  abstract: string;
  venue?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  url?: string;
}

// Factory function
export function createAcademicAdapter(options?: AcademicAdapterOptions): AcademicAdapter;

// Convert academic search results to RawDocument
export function academicResultToRawDocument(paper: PaperMetadata, fullText?: string): RawDocument;
```

**Tests:** Similar structure to QA adapter tests, focusing on section detection, equation extraction, and citation handling.

### Exit Criteria

- [ ] QA adapter fully implemented with tests
- [ ] Academic adapter fully implemented with tests
- [ ] Stack Overflow answers tool implemented with tests
- [ ] All tests pass (`npm test`)
- [ ] 90%+ code coverage on adapters

### Review Gate 2: Adapter Review (60 minutes)

**Checklist:**

- [ ] QA adapter correctly chunks questions and answers
- [ ] Code blocks are preserved in QA chunks
- [ ] Answer-question linking works correctly
- [ ] Academic adapter correctly detects sections
- [ ] Equations and citations are extracted
- [ ] Both adapters follow the same patterns
- [ ] Tests cover edge cases

**Review Activities:**

- Adapter code review
- Test review
- Integration pattern check
- Documentation review

**Go/No-Go Criteria:**

- GO: Adapters are production-ready
- NO-GO: Issues found, fix and re-review

---

## Phase 3: Integration - Pipeline + Job Upgrade

### Goal

Integrate dedup and constraints into the pipeline, upgrade Job adapter to full.

### Entry Criteria

- Review Gate 2 passed
- Adapters are ready for integration

### Tasks

#### 3.1 Pipeline Integration (`src/rag/pipeline.ts`)

Update pipeline to support dedup and constraints:

```typescript
// Add to PrepareCorpusOptions
export interface PrepareCorpusOptions {
  adapter: AdapterType;
  profile?: RetrievalProfileName;
  documents?: RawDocument[];
  chunks?: RagChunk[];
  embeddings?: number[][];
  model?: string;
  modelRevision?: string;
  dimensions?: number;
  metadata?: Record<string, unknown>;
  // New for V3.2.0
  dedupeConfig?: DedupeConfig;
}

// Add to RetrieveCorpusOptions
export interface RetrieveCorpusOptions {
  query: string;
  topK?: number;
  profile?: RetrievalProfileName;
  useReranker?: boolean;
  queryEmbedding?: number[];
  // New for V3.2.0
  constraintConfig?: ConstraintConfig;
  constraintExtractors?: ConstraintExtractors<unknown>;
}
```

Update pipeline functions:

```typescript
// In prepareCorpus, add dedup step
export async function prepareCorpus(
  options: PrepareCorpusOptions
): Promise<PreparedCorpus> {
  // ... existing code ...

  // Step 2.5: Deduplicate documents if config provided
  let dedupedDocuments = documents;
  let dedupeResult: DedupeResult<RawDocument> | undefined;

  if (options.dedupeConfig && documents.length > 0) {
    dedupeResult = await deduplicateCorpus(
      documents,
      options.dedupeConfig,
      embedTexts // From embedding service
    );
    dedupedDocuments = dedupeResult.items;
  }

  // Continue with chunking using dedupedDocuments
  // ...
}

// In retrieveCorpus, add constraint step
export async function retrieveCorpus<T = RagChunk>(
  options: RetrieveCorpusOptions
): Promise<RetrievalResponse<T>> {
  // ... existing retrieval logic ...

  // Step 5: Apply constraints if configured
  let constrainedResults: ConstraintRankedResult<T>[] | undefined;
  let finalResults = results;
```

#### 3.2 Two-Phase Job Discovery Crawl (`src/tools/semanticJobs.ts` + `src/rag/adapters/job.ts`)

**Problem:** `semantic_jobs` currently treats job board search-result pages as individual job listings. `webSearch` returns collection URLs (e.g. `seek.com.au/data-entry-jobs/in-Bankstown-NSW-2200`), which are crawled and fed to `extractJobListingsFromHtml`. Since those pages have no `JobPosting` JSON-LD, the extractor falls back to `<h1>` — yielding "2,564 data entry jobs in Bankstown NSW 2200" as a job title. All extracted fields (location, salary, company) are either absent or wrong.

**Fix:** Add an intermediate step that extracts individual job card links from collection pages before crawling the real listing pages.

**New function: `extractJobLinksFromHtml`**

Add to `src/rag/adapters/job.ts`:

```typescript
// Per-host canonical job URL patterns
const JOB_URL_PATTERNS: { hostname: RegExp; path: RegExp }[] = [
  { hostname: /seek\.com\.au$/, path: /^\/job\/\d+/ },
  { hostname: /indeed\.com$/, path: /\bjk=[a-f0-9]+/ },     // query param
  { hostname: /linkedin\.com$/, path: /\/jobs\/view\// },
  { hostname: /jora\.com$/, path: /\/job\// },
];

export function extractJobLinksFromHtml(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const links = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }
    // Only same-host links
    if (resolved.hostname !== base.hostname) return;

    for (const { hostname, path } of JOB_URL_PATTERNS) {
      if (hostname.test(resolved.hostname) && path.test(resolved.pathname + resolved.search)) {
        links.add(resolved.href);
        break;
      }
    }
  });

  return [...links];
}
```

**Updated `defaultCrawl` in `src/tools/semanticJobs.ts`:**

```typescript
async function defaultCrawl(urls: string[]): Promise<SemanticJobsCrawledPage[]> {
  const cfg = loadConfig();
  const crawlOne = async (url: string) => {
    const result = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
      strategy: 'bfs', maxDepth: 1, maxPages: 1, includeExternalLinks: false,
    });
    return { url, page: result.pages[0] };
  };

  // Phase 1: crawl collection pages to extract individual job links
  const phase1 = await Promise.allSettled(urls.map(crawlOne));
  const jobLinks: string[] = [];
  for (const outcome of phase1) {
    if (outcome.status !== 'fulfilled') continue;
    const { page } = outcome.value;
    if (page?.html) {
      jobLinks.push(...extractJobLinksFromHtml(page.html, outcome.value.url));
    }
  }

  // If no individual job links found, fall back to treating collection pages as listings
  const targets = jobLinks.length > 0 ? dedupUrls(jobLinks) : urls;

  // Phase 2: crawl individual job pages (or fall back to collection pages)
  const phase2 = await Promise.allSettled(targets.map(crawlOne));
  const pages: SemanticJobsCrawledPage[] = [];
  for (let i = 0; i < phase2.length; i++) {
    const outcome = phase2[i];
    const url = targets[i] ?? 'unknown';
    if (outcome === undefined) continue;
    if (outcome.status === 'fulfilled') {
      const { page } = outcome.value;
      pages.push({
        url,
        html: page?.html ?? page?.markdown ?? '',
        success: page?.success ?? false,
        ...(page?.errorMessage ? { error: page.errorMessage } : {}),
      });
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      pages.push({ url, html: '', success: false, error: reason });
    }
  }
  return pages;
}
```

**Integration with full `JobListing` type (from Phase 0.2):**

The new `JobListing` type has structured `salary: SalaryRange`, `experience: ExperienceRange`, and `requirements: JobRequirement[]`. Individual job pages (not collection pages) reliably carry JSON-LD `JobPosting` schema and proper `<h1>` + structured fields. The two-phase crawl is what makes the Phase 0.2 type upgrade worthwhile — without it, the richer type is populated with garbage from collection pages.

Update `buildListing` in `adapters/job.ts` to populate `JobListing` (not just `JobListingMvp`) using the structured extraction paths from Phase 0.2.

**Tests:**

```typescript
// src/rag/__tests__/adapters/job-two-phase.test.ts

describe('extractJobLinksFromHtml', () => {
  it('extracts SEEK job links from a search result page', () => {
    const html = `
      <a href="/job/91431086">Software Engineer</a>
      <a href="/job/91431087">Data Entry Clerk</a>
      <a href="/company/acme">ACME Corp</a>
    `;
    const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/data-entry-jobs');
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('/job/91431086');
    expect(links[1]).toContain('/job/91431087');
  });

  it('extracts Indeed job links via jk param', () => {
    const html = `<a href="/viewjob?jk=abc123def456">Data Entry</a>`;
    const links = extractJobLinksFromHtml(html, 'https://au.indeed.com/jobs?q=data+entry');
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('jk=abc123def456');
  });

  it('ignores cross-domain links', () => {
    const html = `<a href="https://other.com/job/123">Cross-domain</a>`;
    const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
    expect(links).toHaveLength(0);
  });

  it('deduplicates identical links', () => {
    const html = `
      <a href="/job/12345">Job A</a>
      <a href="/job/12345">Job A again</a>
    `;
    const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
    expect(links).toHaveLength(1);
  });
});

describe('defaultCrawl two-phase', () => {
  it('falls back to collection pages when no job links found', async () => {
    // Mock that returns pages with no job card links
    // Expect the collection page URLs themselves to be crawled for extraction
  });

  it('discovers and crawls individual job links when present', async () => {
    // Mock phase 1 returns a collection page with job links
    // Mock phase 2 returns individual job pages with JSON-LD JobPosting
    // Expect extracted listings to have proper title/company/location
  });
});
```

### Exit Criteria

- [ ] Pipeline dedup integration (`src/rag/dedup.ts`) wired into `prepareCorpus`
- [ ] Pipeline constraint integration (`src/rag/constraints.ts`) wired into `retrieveCorpus`
- [ ] `JobListingMvp` upgraded to full `JobListing` with structured salary/experience/requirements
- [ ] `extractJobLinksFromHtml` implemented with tests covering SEEK, Indeed, LinkedIn, Jora patterns
- [ ] `defaultCrawl` in `semanticJobs.ts` uses two-phase discovery
- [ ] Two-phase crawl falls back gracefully when no individual links are found
- [ ] All new tests pass (`npm test`)
- [ ] `npm run typecheck` passes

### Review Gate 3: Integration Review (45 minutes)

**Checklist:**

- [ ] Pipeline dedup and constraints don't break existing tests
- [ ] `JobListing` replaces `JobListingMvp` without breaking `semantic_jobs` results contract
- [ ] Two-phase crawl delivers real individual job listings, not collection page artifacts
- [ ] Fallback to collection pages works when job links are not found
- [ ] Job link patterns cover SEEK, Indeed, LinkedIn, Jora correctly
- [ ] Score formula (`semantic * 0.45 + location * 0.2 + ...`) differentiates results meaningfully with real listing data

**Go/No-Go Criteria:**

- GO: Individual job pages extracted cleanly, scores differentiate across listings
- NO-GO: Regression in existing tools, type errors, or fallback path missing

---

## Phase 6: Distribution — Docker Compose + Ollama + Registry

### Goal

Ship a one-command deploy experience and fully local embedding option. These are the highest-leverage adoption fixes from the competitive analysis. Packaging problems block adoption faster than missing features.

### Entry Criteria

- Review Gate 5 passed
- All domain adapter phases complete and tested
- Eval harness passing in CI

### Why This Phase Exists

The competitive analysis (2026-04-26) identified three critical gaps:

1. **Docker Compose bundles win adoption** — ToKiDoO's fork got 38 stars mostly because of `docker compose up -d`. Users don't want to configure 5 services.
2. **MCP registries drive discoverability** — mcp.so lists 20,414 servers. search-mcp is technically superior but invisible in the discovery layer.
3. **Ollama/Transformers.js closes the privacy gap** — mcp-local-rag runs fully local with no API keys. This is a blocker for privacy-first users.

### Tasks

#### 6.1 Docker Compose Bundle

**What**: Add `Dockerfile` for the search-mcp server + `docker-compose.yml` that bundles SearXNG, Crawl4AI sidecar, and embedding sidecar.

```yaml
# docker-compose.yml (conceptual)
services:
  search-mcp:
    build: .
    ports:
      - '8050:8050'
    environment:
      - EMBEDDING_SIDECAR_BASE_URL=http://embedding-sidecar:8000
      - CRAWL4AI_BASE_URL=http://crawl4ai:8050
      - SEARXNG_BASE_URL=http://searxng:8080
      - SEARCH_BACKEND=searxng

  embedding-sidecar:
    build: ./sidecar/embedding/

  crawl4ai:
    image: unclebrian/crawl4ai:latest

  searxng:
    image: searxng/searxng:latest
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml
```

**Files to create/modify**:
- `Dockerfile` — multi-stage Node.js build (dev + production)
- `docker-compose.yml` — full stack
- `searxng/settings.yml` — pre-configured SearXNG (engines, privacy defaults)
- `docs/quickstart.md` — update with Docker instructions

**Acceptance criteria**:
- [ ] `docker compose up -d` launches all 4 services
- [ ] MCP clients connect via `http://host.docker.internal:8050`
- [ ] SearXNG fallback works when no Exa/Brave API keys configured
- [ ] Server starts without any API keys (fully local mode)

#### 6.2 Ollama / Transformers.js Embedding Provider

**What**: Add `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_PROVIDER=transformers` modes alongside existing sidecar option.

**Ollama path**:

```typescript
// src/utils/embedding.ts — provider abstraction
type EmbeddingProvider = 'sidecar' | 'openai' | 'ollama' | 'transformers';

interface OllamaEmbedder {
  baseUrl: string; // e.g., http://localhost:11434
  model: string;   // e.g., 'nomic-embed-text'
  dimensions?: number;
}

async function embedWithOllama(texts: string[], opts: OllamaEmbedder): Promise<number[][]> {
  const response = await fetch(`${opts.baseUrl}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: opts.model, input: texts }),
  });
  // ...
}
```

**Transformers.js path** (fully in-process, no external service):

```typescript
// src/utils/transformersEmbedding.ts
import { pipeline } from '@xenova/transformers';
let embedder: Pipeline | null = null;
async function getEmbedder(modelName: string) {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', modelName);
  }
  return embedder;
}
```

**Files to create/modify**:
- `src/utils/embedding.ts` — provider dispatch (embedTexts routes to correct backend)
- `src/utils/ollamaEmbedding.ts` — new Ollama client
- `src/utils/transformersEmbedding.ts` — new Transformers.js client
- `src/config.ts` — add `EMBEDDING_PROVIDER`, `EMBEDDING_OLLAMA_BASE_URL`, etc.
- `package.json` — optional dependency on `@xenova/transformers`
- `docs/quickstart.md` — document fully-local paths

**Acceptance criteria**:
- [ ] Ollama embeddings work with `EMBEDDING_PROVIDER=ollama` + `ollama pull nomic-embed-text`
- [ ] Transformers.js embeddings work with `EMBEDDING_PROVIDER=transformers` (no external deps)
- [ ] Existing sidecar path unchanged when `EMBEDDING_PROVIDER` is unset (backward compat)
- [ ] Graceful error if Ollama not running or model not pulled
- [ ] Graceful error if transformers package not installed

#### 6.3 MCP Registry Publishing

**What**: List search-mcp on the three major MCP directories.

**Where**:
- [ ] **mcp.so** — https://mcp.so/submit (largest directory, 20,414 servers)
- [ ] **FastMCP.market** — https://fastmcp.market/submit
- [ ] **MCP Registry** — Package as npm with MCP manifest

**What to include in listings**:
- Feature matrix comparison (36 tools vs competitors' 3-9)
- Docker Compose one-command setup
- Privacy-first positioning (no data leaves user machine with SearXNG)
- Use cases: research, competitive analysis, job search, code search
- Links to docs: tools.md, architecture.md, quickstart.md

**Files to create/modify**:
- `README.md` — add badges, feature comparison table, Docker setup
- `docs/comparison.md` — detailed feature matrix vs Kindly, Vera, mcp-local-rag, mcp-crawl4ai-rag

**Acceptance criteria**:
- [ ] Listed on mcp.so with feature matrix
- [ ] Listed on FastMCP.market
- [ ] npm package has MCP manifest for registry discovery

### Phase 6 Files

| File | Action | Purpose |
|------|--------|---------|
| `Dockerfile` | Create | Multi-stage Node.js build |
| `docker-compose.yml` | Create | Full stack (SearXNG + Crawl4AI + sidecar) |
| `searxng/settings.yml` | Create | Pre-configured SearXNG |
| `src/utils/ollamaEmbedding.ts` | Create | Ollama embedding client |
| `src/utils/transformersEmbedding.ts` | Create | Transformers.js embedding client |
| `src/utils/embedding.ts` | Modify | Provider dispatch |
| `src/config.ts` | Modify | New env vars |
| `package.json` | Modify | Optional transformers dependency |
| `README.md` | Modify | Badges, comparison, Docker setup |
| `docs/quickstart.md` | Modify | Docker + fully-local paths |
| `docs/comparison.md` | Create | Feature matrix vs competitors |

### Estimated Scope

| Component | New LOC | Modified LOC |
|-----------|---------|--------------|
| Dockerfile + compose + SearXNG config | ~50 | 0 |
| Ollama embedding client | ~60 | 0 |
| Transformers.js embedding client | ~80 | 0 |
| Provider dispatch refactor | ~30 | ~50 |
| Config additions | ~20 | ~30 |
| Docs + README + registry | ~100 | ~80 |
| **Total** | **~340** | **~160** |

### Review Gate 6: Distribution Review

**Focus**:
1. Docker Compose: does `docker compose up -d` work on a clean machine?
2. Ollama: correct error handling when server not running
3. Transformers.js: in-process embeddings without segfaults
4. Registry listings: accurate, professional, differentiate

**Duration**: 30 minutes
