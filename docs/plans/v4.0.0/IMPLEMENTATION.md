# V4.0.0 Implementation Plan: Deep Research Orchestration Engine

> **Status**: Draft · **Est. Scope**: ~3,180 LOC MVP / ~3,580 LOC full  
> **Execution**: Subagent-driven with review gates per phase  
> **Branch**: `feature/v4-deep-research`

---

## Overview

This plan breaks V4.0.0 into 7 implementation phases, each with subagent assignments,
review gates, and integration testing. The phases follow the MVP priority order from the SPEC.

### Conventions

- New files go in `src/research/` and `test/research/`
- Tool registration in `src/tools/deepResearch.ts`
- Config amendments in `src/config.ts` and `src/health.ts`
- All new code follows existing conventions: ESM with `.js` extensions, Zod v4, strict TypeScript, pino logging to stderr
- Every phase includes: implementation → tests → typecheck → lint → review gate

### Subagent Architecture

```
Phase Lead (orchestrator agent)
  │
  ├── Worker 1: implements module(s)
  │     └── Reviewer: audits code + tests
  │
  ├── Worker 2: implements module(s)
  │     └── Reviewer: audits code + tests
  │
  └── Integrator: merges, runs full typecheck + lint, verifies no regressions
```

---

## Phase 0: Scaffolding & Config (1 session, ~150 LOC)

**Subagent**: 1 worker  
**Review**: quick check

### Deliverables

1. **Create `src/research/` module structure**

   ```bash
   src/research/
   ├── types.ts        # (empty shell → populated in Phase 1)
   ├── index.ts        # barrel export
   ```

2. **Amend `src/config.ts`**
   - Add `DeepResearchConfig` interface
   - Add defaults + env var resolution
   - Add to `SearchConfig` type

3. **Amend `src/health.ts`**
   - Add `deepResearchCapabilities()` function
   - Add `DEEP_RESEARCH_ENABLED` to config gating

4. **Create `docs/research-architecture.md`**
   - Architecture diagram copied from SPEC
   - Module dependency graph

### Review Gate

- `typecheck --noEmit` passes
- `lint` clean
- `SearchConfig` includes `deepResearch`
- `health_check` reports deep_research capability

---

## Phase 1: Types + State Engine (1–2 sessions, ~500 LOC)

**Subagents**: 2 workers (parallel: types + state engine)  
**Review**: thorough

### Worker 1: Types (`src/research/types.ts`)

Implement all research state types from SPEC §5:

```typescript
// Core state
ResearchPhase, ResearchState, ResearchTaxonomy

// Sources
SourceEntry, SourceRegistry, SourceType (literal union)
ToolStrategy, FreshnessRequirement

// Questions
QueryClassification, SubQuestion, SubQuestionStatus

// Findings
EvidenceType, EvidenceDirectness, ClaimType, ConfidenceLabel
Finding, FindingRegistry

// Contradictions
ContradictionType, Contradiction

// Gaps
GapCategory, GapRecord, OpenQuestion

// Budget
ResearchDepth, BudgetProfile, BudgetState

// Discovery
SourceCandidate, DiscoveryResult

// Progress
ResearchProgress (discriminated union per phase)

// Output
ResearchResult, ResearchMeta

// Config
DeepResearchConfig

// Errors
ResearchError (typed enum)
```

All types use Zod v4 schemas + TypeScript interfaces. Follow existing pattern from `src/types.ts` and `src/rag/types.ts`.

### Worker 2: State Engine (`src/research/state.ts`)

```typescript
class ResearchStateEngine {
  constructor(config: DeepResearchConfig);

  // Lifecycle
  initialize(query: string, depth: ResearchDepth): ResearchState;
  getState(): ResearchState;
  getPhase(): ResearchPhase;
  transitionTo(phase: ResearchPhase): void;

  // Sources
  addSource(entry: SourceEntry): void;
  getSources(subQuestionId?: string): SourceEntry[];
  getSourcesByIds(ids: string[]): SourceEntry[];
  markSourceExtracted(id: string): void;
  markSourceFailed(id: string): void;

  // Findings
  addFinding(finding: Finding): string; // returns ID
  getFindings(subQuestionId?: string): Finding[];
  getFindingsByConfidence(minConfidence: number): Finding[];
  getFindingsBySourceId(sourceId: string): Finding[];
  updateConfidence(findingId: string, delta: number): void;
  mergeFindings(existingId: string, newId: string): void; // dedup

  // Contradictions
  detectContradictions(): Contradiction[];
  addContradiction(c: Contradiction): void;
  resolveContradiction(id: string): void;
  getUnresolvedContradictions(): Contradiction[];

  // Gaps
  getOpenGaps(): GapRecord[];
  addGap(gap: GapRecord): void;
  closeGap(id: string): void;
  updateGapStatus(id: string, status: GapRecord['status']): void;

  // Claims graph (lightweight)
  addClaimEdge(edge: ClaimEdge): void;
  getRelatedClaims(claimId: string): ClaimEdge[];

  // Serialization
  toJSON(): ResearchState;
  fromJSON(state: ResearchState): void;
  compress(): CompressedState; // for gap analysis input
}
```

Also implement `src/research/budget.ts`:

```typescript
class BudgetTracker {
  constructor(profile: BudgetProfile);

  // Tracking
  recordToolCall(): boolean; // returns false if over budget
  recordToken(count: number): boolean;
  recordExtraction(): boolean;
  getElapsedMs(): number;

  // Queries
  isExhausted(): boolean;
  remainingBudget(): { calls: number; tokens: number; extractions: number };
  isInformationGainWorthwhile(improvement: number): boolean;
}
```

### Review Gate

- All types exported and self-consistent
- State engine unit tests cover: init, add sources, add findings, detect contradictions, gap lifecycle, serialization round-trip
- BudgetTracker unit tests cover: exhaustion, partial depletion, merge scenarios
- `typecheck` passes (this is the strictest test — types must be exactly right)
- `npm run typecheck` clean

---

## Phase 2: Decomposer + Taxonomy Revision (1 session, ~300 LOC)

**Subagents**: 1 worker  
**Review**: thorough

### Worker: `src/research/decomposer.ts`

Implements Phase 1 query understanding:

```typescript
class QueryDecomposer {
  decompose(query: string): {
    classification: QueryClassification;
    subQuestions: SubQuestion[];
    plan: ResearchPlan;
  };

  private classifyQuery(query: string): QueryClassification;
  private generateSubQuestions(query: string, classification: QueryClassification): SubQuestion[];
  private chooseToolStrategy(subQuestion: SubQuestion): ToolStrategy[];
}
```

MVP: Rule-based classification + template-based sub-question generation. Uses keyword patterns to classify query type, then maps to preset sub-question templates per classification.

**Example templates per classification**:

- `technical`: ["What mechanisms are involved in {topic}?", "What architectures support {topic}?", "How is {topic} evaluated?"]
- `comparative`: ["What are the main options for {topic}?", "What are the tradeoffs?", "When would you choose each?"]
- `applied-practitioner`: ["What do production systems use for {topic}?", "What are common pitfalls?", "What tools/frameworks support {topic}?"]

### Worker: `src/research/taxonomy.ts`

```typescript
class TaxonomyRevision {
  revise(original: ResearchTaxonomy, discoveryResults: DiscoveryResult[]): ResearchTaxonomy;

  private detectNewAngles(sources: DiscoveryResult[]): string[];
  private mergeSubQuestions(original: SubQuestion[], newTopics: string[]): SubQuestion[];
  private dropIrrelevant(original: SubQuestion[], sources: DiscoveryResult[]): SubQuestion[];
}
```

MVP: Structural revision based on source coverage. If a sub-question returns no sources, demote it. If sources cluster around an unexpected topic, add a new sub-question.

### Review Gate

- Decomposer produces 3–7 sub-questions for each query classification
- Taxonomy revision preserves original intent
- Tests cover all 8 query classifications
- Edge cases: empty query, very short query, ambiguous query

---

## Phase 3: Discovery (1–2 sessions, ~450 LOC)

**Subagents**: 2 workers (parallel: discovery core + source scoring)  
**Review**: thorough

### Worker 1: Discovery Core (`src/research/discovery.ts`)

```typescript
class DiscoveryEngine {
  constructor(state: ResearchStateEngine, budget: BudgetTracker);

  async discover(subQuestions: SubQuestion[]): Promise<SourceCandidate[]>;

  private async discoverForSubQuestion(sq: SubQuestion): Promise<SourceCandidate[]>;

  // Tool dispatch
  private async searchWeb(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchAcademic(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchReddit(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchHackerNews(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchGitHub(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchGithubRepos(query: string, limit: number): Promise<SourceCandidate[]>;
  private async searchStackOverflow(query: string, limit: number): Promise<SourceCandidate[]>;

  // Parallel execution
  private async executeTools(strategies: ToolStrategy[]): Promise<SourceCandidate[][]>;
  private mergeResults(results: SourceCandidate[][]): SourceCandidate[];
}
```

Each search tool wrapper calls the existing MCP tool's underlying function directly (not via MCP). For example, `searchWeb` calls `webSearch()` from `src/tools/webSearch.ts`.

### Worker 2: Source Scoring + Dedup (`src/research/score.ts`)

```typescript
class SourceScorer {
  scoreCandidates(candidates: SourceCandidate[]): RankedSourcePool;

  private computeRelevance(candidate: SourceCandidate, subQuestion: SubQuestion): number;
  private computeDiversity(candidate: SourceCandidate, existing: SourceEntry[]): number;
  private computeFreshness(candidate: SourceCandidate): number;
  private computeSourceConfidence(candidate: SourceCandidate): number;
  private combineScore(scores: {
    relevance: number;
    diversity: number;
    freshness: number;
    confidence: number;
  }): number;
}

class SourceDeduplicator {
  dedup(candidates: SourceCandidate[]): SourceCandidate[];

  private urlLevel(candidates: SourceCandidate[]): Map<string, SourceCandidate>;
  private documentLevel(candidates: SourceCandidate[]): SourceCandidate[];
  private claimLevel(candidates: SourceCandidate[]): SourceCandidate[];
  private preserveDiversity(
    deduped: SourceCandidate[],
    original: SourceCandidate[],
  ): SourceCandidate[];
}
```

### Integration

Discovery engine uses `SourceScorer` to rank and `SourceDeduplicator` to dedup, then stores candidates in `ResearchStateEngine`.

### Review Gate

- Integration test: mock search tools → produces ranked candidates
- Dedup preserves diversity (academic + practitioner + docs)
- Source scoring respects all 4 dimensions
- BudgetTracker is checked before each tool call
- Error handling: tool failure doesn't crash discovery

---

## Phase 4: Extraction + Distillation (1–2 sessions, ~450 LOC)

**Subagents**: 2 workers (parallel: extraction core + claim extractor)  
**Review**: thorough

### Worker 1: Extraction Engine (`src/research/extraction.ts`)

```typescript
class ExtractionEngine {
  constructor(state: ResearchStateEngine, budget: BudgetTracker);

  async extract(sources: SourceEntry[]): Promise<Finding[]>;

  private selectTopSources(candidates: SourceEntry[], budget: BudgetProfile): SourceEntry[];

  private async fetchAndExtract(source: SourceEntry): Promise<{
    markdown: string;
    title: string;
    success: boolean;
  }>;

  private chunkContent(markdown: string, url: string): MarkdownChunk[];

  private async retrievePassages(
    chunks: MarkdownChunk[],
    subQuestions: SubQuestion[],
  ): Promise<Array<{ chunk: MarkdownChunk; relevantTo: string[]; score: number }>>;
}
```

**Fetch logic**:

1. If Crawl4AI configured → `webCrawl()` (single page)
2. If not → `webRead()` (Readability)
3. Handle failures gracefully (Wayback Machine fallback already in existing tools)

**Chunking**: reuse `chunkMarkdown()` from `src/chunking.ts`

**Passage retrieval**: reuse BM25+ scorer from RAG pipeline for sub-question relevance.

### Worker 2: Claim Extractor (`src/research/claims.ts`)

```typescript
class ClaimExtractor {
  extractFromPassages(
    passages: Array<{ chunk: MarkdownChunk; relevantTo: string[] }>,
    source: SourceEntry,
  ): Finding[];

  private extractClaims(text: string, subQuestionIds: string[], source: SourceEntry): Finding[];

  // Heuristic extraction patterns
  private extractMechanismDescription(text: string): string | null;
  private extractBenchmarkResult(text: string): { claim: string; confidence: number } | null;
  private extractComparison(text: string): { claim: string; confidence: number } | null;
  private extractFailureMode(text: string): { claim: string; evidenceSummary: string } | null;
  private extractRecommendation(text: string): string | null;

  // Confidence estimation
  private estimateConfidence(finding: Omit<Finding, 'id' | 'confidence' | 'confidenceLabel'>): {
    score: number;
    label: ConfidenceLabel;
  };
}
```

**MVP**: Rule-based claim extraction using pattern matching on chunk text. Not LLM-based.

- Patterns for mechanism descriptions ("X uses Y to...", "The architecture consists of...")
- Patterns for benchmarks ("achieved X%", "outperforms by...")
- Patterns for comparisons ("compared to X, Y...", "tradeoff between...")
- Patterns for failure modes ("limitation is...", "struggles with...")

### Review Gate

- Extraction handles Crawl4AI and Readability fallback
- Claim extractor produces valid `Finding` objects
- All findings have source linkage
- Raw content is not retained after distillation
- Tests: mock HTML → correct claim extraction, edge case pages, failed fetches

---

## Phase 5: Gap Analysis + Loop Control (1 session, ~250 LOC)

**Subagents**: 1 worker  
**Review**: thorough

### Worker: `src/research/gapAnalysis.ts`

```typescript
class GapAnalyzer {
  constructor(state: ResearchStateEngine);

  analyze(): GapRecord[];

  private unansweredSubQuestions(): GapRecord[];
  private lowConfidenceClaims(): GapRecord[];
  private unresolvableContradictions(): GapRecord[];
  private missingSourceTypes(): GapRecord[];
  private missingRecency(): GapRecord[];
  private overrepresentedViewpoints(): GapRecord[];
}

class GapFiller {
  constructor(state: ResearchStateEngine, budget: BudgetTracker);

  async fillGaps(gaps: GapRecord[]): Promise<{
    filled: number;
    remaining: GapRecord[];
    newFindings: Finding[];
  }>;

  private generateFollowUpTasks(gap: GapRecord): ToolStrategy[];
  private shouldContinueLoop(): boolean;
  private estimateInformationGain(gap: GapRecord): number;
}
```

**Loop control**:

- After each gap loop, check stopping heuristics (SPEC §9)
- Track information gain: compare confidence distribution before/after
- Hard stop at budget exhaustion or max loops
- Soft stop when all gaps are low-priority or unresolvable

### Review Gate

- Gap analyzer detects all 6 gap categories
- Gap filler generates appropriate follow-up tasks
- Loop terminates correctly under all budget scenarios
- Tests: partial state → correct gap detection
- Edge cases: all gaps resolved, no gaps found, unresolvable gaps

---

## Phase 6: Audit + Citation Integrity (1 session, ~200 LOC)

**Subagents**: 1 worker  
**Review**: thorough

### Worker: `src/research/audit.ts`

```typescript
class StateAuditor {
  constructor(state: ResearchStateEngine);

  audit(): AuditReport;

  private checkSourceSupport(): CitationIssue[];
  private checkConfidenceCalibration(): CalibrationIssue[];
  private checkDuplicateClaims(): DuplicateIssue[];
  private checkContradictionIntegrity(): ContradictionIssue[];
  private checkCaveatPreservation(): CaveatIssue[];
  private checkDiversity(): DiversityIssue[];
  private checkDrift(): DriftIssue[];
}

interface AuditReport {
  passed: boolean;
  issues: AuditIssue[];
  stats: {
    totalClaims: number;
    unsourcedClaims: number;
    lowConfidenceClaims: number;
    unresolvedContradictions: number;
    mergedDuplicates: number;
    sourceDiversity: { type: string; count: number }[];
    taxonomyDrift: boolean;
  };
  timestamp: string;
}
```

### Review Gate

- Audit detects unsourced claims
- Audit detects confidence-evidence mismatch
- Duplicate detection works
- Integration: run audit before synthesis, fail on critical issues
- Tests: clean state → no issues; corrupted state → all issues detected

---

## Phase 7: Synthesizer + Tool Registration (1–2 sessions, ~550 LOC)

**Subagents**: 2 workers (parallel: synthesizer + tool registration)  
**Review**: thorough + integration test

### Worker 1: Synthesizer (`src/research/synthesizer.ts`)

```typescript
class ResearchSynthesizer {
  constructor(state: ResearchStateEngine);

  synthesize(): ResearchReport;

  // Section builders
  private buildExecutiveSummary(): string;
  private buildKeyFindings(): KeyFindingSection[];
  private buildByTheme(): ThemedSection[];
  private buildContradictions(): ContradictionSection;
  private buildUncertainties(): UncertaintySection;
  private buildSourceNotes(): SourceNoteSection;
  private buildOpenQuestions(): OpenQuestionSection;
  private buildRecommendations(): RecommendationSection;

  // Confidence prose helpers
  private confidencePrefix(label: ConfidenceLabel): string;
  // "Well-corroborated evidence suggests..."
  // "Practitioners commonly report..."
  // "Several sources imply, but do not conclusively show..."
  // "Sources disagree on..."
  // "This remains weakly supported..."

  private formatComparison(items: ComparisonItem[]): string;
  private formatTradeoffs(tradeoffs: Tradeoff[]): string;
}
```

Output structure:

```typescript
interface ResearchReport {
  query: string;
  classification: QueryClassification;
  depth: ResearchDepth;
  executiveSummary: string;
  keyFindings: KeyFindingSection[];
  themes: ThemedSection[];
  contradictions: ContradictionSection;
  uncertainties: string[];
  sourceNotes: string[];
  openQuestions: string[];
  recommendations?: string;
  limitations: string[];
  durationMs: number;
  sourceCount: number;
  findingCount: number;
  confidenceDistribution: Record<ConfidenceLabel, number>;
}
```

### Worker 2: Progressive Renderer (`src/research/progress.ts`)

```typescript
class ProgressTracker {
  private timeline: ResearchProgress[];

  record(event: ResearchProgress): void;
  getTimeline(): ResearchProgress[];
  getLastUpdate(): ResearchProgress | undefined;

  // Convenience builders
  decompositionComplete(plan: ResearchPlan): void;
  sourcesDiscovered(subQuestionId: string, count: number): void;
  extractionProgress(completed: number, total: number): void;
  findingsExtracted(findings: Finding[]): void;
  taxonomyRevised(taxonomy: ResearchTaxonomy): void;
  contradictionsFound(contradictions: Contradiction[]): void;
  gapsIdentified(gaps: GapRecord[]): void;
  synthesisOutlined(outline: string): void;
  limitationsIdentified(limitations: string[]): void;
  researchComplete(): void;
}
```

### Worker 3: Tool Registration (`src/tools/deepResearch.ts`)

```typescript
import { z } from 'zod/v4';
import { registerTool } from '../server.js';

// Schema
const deepResearchSchema = z.object({
  query: z.string().min(10).max(2000).describe('The research query'),
  depth: z
    .enum(['quick', 'standard', 'deep'])
    .optional()
    .default('standard')
    .describe('Research depth profile'),
  maxTimeMs: z
    .number()
    .int()
    .min(10000)
    .max(600000)
    .optional()
    .describe('Maximum execution time in ms'),
});

// Handler
async function handleDeepResearch(
  query: string,
  depth: ResearchDepth,
  maxTimeMs?: number,
): Promise<ToolResult<ResearchResult>> {
  const config = loadConfig().deepResearch;

  // 1. Initialize state engine
  const state = new ResearchStateEngine(config);
  const budget = new BudgetTracker(getBudgetProfile(depth, maxTimeMs));
  const progress = new ProgressTracker();
  const orchestrator = new ResearchOrchestrator(state, budget, progress);

  // 2. Run full pipeline
  const result = await orchestrator.run(query);

  // 3. Return with timeline
  return makeResult('deep_research', result, Date.now() - start, {
    timeline: progress.getTimeline(),
  });
}
```

### Worker 4: Orchestrator (`src/research/orchestrator.ts`)

```typescript
class ResearchOrchestrator {
  constructor(
    private state: ResearchStateEngine,
    private budget: BudgetTracker,
    private progress: ProgressTracker,
  );

  async run(query: string): Promise<ResearchResult> {
    // Phase 1: Decompose
    const decomposer = new QueryDecomposer();
    const { classification, subQuestions } = decomposer.decompose(query);
    this.state.initialize(query, depth);
    for (const sq of subQuestions) this.state.addSubQuestion(sq);
    this.progress.decompositionComplete({ ... });

    // Phase 2: Discover
    const discovery = new DiscoveryEngine(this.state, this.budget);
    const candidates = await discovery.discover(subQuestions);
    this.progress.sourcesDiscovered(...);

    // Phase 1.5: Taxonomy revision
    if (!this.state.flags.taxonomyRevised && candidates.length > 0) {
      const taxonomy = new TaxonomyRevision();
      const revised = taxonomy.revise(this.state.getTaxonomy(), candidates);
      this.state.setTaxonomy(revised);
      this.state.flags.taxonomyRevised = true;
      this.progress.taxonomyRevised(revised);
    }

    // Phase 3: Extract
    const extraction = new ExtractionEngine(this.state, this.budget);
    const findings = await extraction.extract(this.state.getTopSources());
    this.progress.findingsExtracted(findings);

    // Phase 4: State update (automatic via extraction)

    // Phase 5: Gap loop
    let loopCount = 0;
    while (loopCount < maxLoops && !this.budget.isExhausted()) {
      const analyzer = new GapAnalyzer(this.state);
      const gaps = analyzer.analyze();
      if (gaps.length === 0) break;

      this.progress.gapsIdentified(gaps);

      const filler = new GapFiller(this.state, this.budget);
      const { remaining } = await filler.fillGaps(gaps);

      if (remaining.length === 0) break;
      if (this.budget.isInformationGainWorthwhile(previousConfidence, currentConfidence)) break;

      loopCount++;
    }

    // Phase 6: Audit
    const auditor = new StateAuditor(this.state);
    const auditReport = auditor.audit();
    if (!auditReport.passed) {
      // Auto-fix critical issues, log warnings
    }

    // Phase 7: Synthesize
    const synthesizer = new ResearchSynthesizer(this.state);
    const report = synthesizer.synthesize();
    this.progress.researchComplete();

    return {
      report,
      timeline: this.progress.getTimeline(),
      meta: { ... },
    };
  }
}
```

### Review Gate

- Full integration test: mock all external tools → end-to-end research flow
- Tool registers correctly in `src/server.ts`
- Health check reports deep_research capability
- Budget enforcement: tool respects max sources, max time
- Progressive timeline included in response meta
- `typecheck` + `lint` + format clean

---

## Execution Flow

Each phase runs as a subagent chain:

```
Phase N:
  [Orchestrator] → dispatches Worker subagents
  [Worker 1]     → implements module, writes tests
  [Worker 2]     → implements module, writes tests (if parallel)
  [Reviewer]     → audits code, tests, types, lint
  [Integrator]   → merges, runs full suite, fixes regressions
                   → reports completion to next phase
```

### Subagent Roles

| Role       | Agent                | Task                                           |
| ---------- | -------------------- | ---------------------------------------------- |
| Worker     | `worker` (builtin)   | Implement specified modules + unit tests       |
| Reviewer   | `reviewer` (builtin) | Audit code quality, test coverage, type safety |
| Integrator | `delegate` (builtin) | Merge workers, run full suite, fix issues      |

---

## Dependencies

```
Phase 0 (scaffolding)
  └── Phase 1 (types + state)
       └── Phase 2 (decomposer + taxonomy)
            └── Phase 3 (discovery)
                 └── Phase 4 (extraction)
                      └── Phase 5 (gap analysis)
                           └── Phase 6 (audit)
                                └── Phase 7 (synthesis + tool)
```

Phases 1–2 can be parallelized. Phases 3–7 are sequential (each depends on prior state).

---

## Test Strategy

| Test Type           | Location                                          | Coverage                                       |
| ------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Unit (state engine) | `test/research/state.test.ts`                     | All state mutations, serialization, edge cases |
| Unit (budget)       | `test/research/budget.test.ts`                    | Budget exhaustion, profiles                    |
| Unit (decomposer)   | `test/research/decomposer.test.ts`                | All 8 classifications, edge cases              |
| Unit (discovery)    | `test/research/discovery.test.ts`                 | Tool dispatch, result merging, error handling  |
| Unit (extraction)   | `test/research/extraction.test.ts`                | Source selection, chunking, claim extraction   |
| Unit (gap analysis) | `test/research/gapAnalysis.test.ts`               | All 6 gap categories, loop control             |
| Unit (audit)        | `test/research/audit.test.ts`                     | All check types                                |
| Unit (synthesis)    | `test/research/synthesizer.test.ts`               | Confidence prose, section formatting           |
| Integration         | `test/research/pipeline.test.ts`                  | Full pipeline with mocked tools                |
| Regression          | `npm run typecheck` + `npm run lint` + `npm test` | No breakage in existing tools                  |

---

## Estimated Timeline

| Phase                     | Sessions | Workers    | Est. LOC   |
| ------------------------- | -------- | ---------- | ---------- |
| Phase 0: Scaffolding      | 1        | 1          | 150        |
| Phase 1: Types + State    | 1–2      | 2 parallel | 500        |
| Phase 2: Decomposer       | 1        | 1          | 300        |
| Phase 3: Discovery        | 1–2      | 2 parallel | 450        |
| Phase 4: Extraction       | 1–2      | 2 parallel | 450        |
| Phase 5: Gap Analysis     | 1        | 1          | 250        |
| Phase 6: Audit            | 1        | 1          | 200        |
| Phase 7: Synthesis + Tool | 1–2      | 3 parallel | 550        |
| **Total**                 | **8–12** | —          | **~3,180** |
