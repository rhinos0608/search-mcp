/**
 * ResearchStateEngine — structured state for the deep research orchestrator.
 *
 * This is the durable working memory of a research run. It manages:
 */

import { randomUUID } from 'node:crypto';
import type {
   ResearchPhase,
   ResearchState,
   ResearchTaxonomy,
   SourceEntry,
   Finding,
   Contradiction,
   ContradictionStatus,
   ContradictionType,
   GapRecord,
   GapStatus,
   ClaimEdge,
   SubQuestion,
   SubQuestionStatus,
   BudgetProfile,
   BudgetState,
   ResearchDepth,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string {
   return new Date().toISOString();
}

function makeId(): string {
   return randomUUID().slice(0, 12);
}
/** Jaccard similarity over word sets for dedup. */
function jaccardSimilarity(a: string, b: string): number {
   const setA = new Set(
      a
         .toLowerCase()
         .split(/\s+/)
         .filter((w) => w.length > 0),
   );
   const setB = new Set(
      b
         .toLowerCase()
         .split(/\s+/)
         .filter((w) => w.length > 0),
   );
   if (setA.size === 0 && setB.size === 0) return 1;
   if (setA.size === 0 || setB.size === 0) return 0;
   let intersection = 0;
   for (const word of setA) {
      if (setB.has(word)) intersection++;
   }
   const union = setA.size + setB.size - intersection;
   return union === 0 ? 0 : intersection / union;
}



// ── Budget profiles ──────────────────────────────────────────────────────────

const BUDGET_PROFILES: Record<ResearchDepth, BudgetProfile> = {
   quick: {
      depth: 'quick',
      maxSources: 10,
      maxExtractions: 5,
      maxGapLoops: 1,
      maxToolCalls: 30,
      maxTokens: 100_000,
      maxTimeMs: 60_000,
      maxStateEntries: 200,
   },
   standard: {
      depth: 'standard',
      maxSources: 25,
      maxExtractions: 15,
      maxGapLoops: 2,
      maxToolCalls: 100,
      maxTokens: 300_000,
      maxTimeMs: 180_000,
      maxStateEntries: 500,
   },
   deep: {
      depth: 'deep',
      maxSources: 60,
      maxExtractions: 30,
      maxGapLoops: 3,
      maxToolCalls: 200,
      maxTokens: 500_000,
      maxTimeMs: 300_000,
      maxStateEntries: 1000,
   },
   exhaustive: {
      depth: 'exhaustive',
      maxSources: 100,
      maxExtractions: 50,
      maxGapLoops: 5,
      maxToolCalls: 400,
      maxTokens: 1_000_000,
      maxTimeMs: 600_000,
      maxStateEntries: 2000,
   },
   tree: {
      depth: 'tree',
      maxSources: 50,
      maxExtractions: 25,
      maxGapLoops: 999,
      maxToolCalls: 150,
      maxTokens: 400_000,
      maxTimeMs: 240_000,
      maxStateEntries: 500,
   },
};

/** Resolve a budget profile, with optional overrides. */
export function resolveBudgetProfile(
   depth: ResearchDepth,
   overrides?: { maxTimeMs?: number },
): BudgetProfile {
   const base = BUDGET_PROFILES[depth];
   return overrides?.maxTimeMs ? { ...base, maxTimeMs: overrides.maxTimeMs } : base;
}

// ── Budget Tracker ──────────────────────────────────────────────────────────

export class BudgetTracker {
   private state: BudgetState;
   readonly profile: BudgetProfile;

   constructor(profile: BudgetProfile) {
      this.profile = profile;
      this.state = {
         toolCallsUsed: 0,
         tokensUsed: 0,
         extractionsUsed: 0,
         gapLoopsUsed: 0,
         startTime: Date.now(),
         maxToolCalls: profile.maxToolCalls,
         maxTokens: profile.maxTokens,
         maxExtractions: profile.maxExtractions,
         maxGapLoops: profile.maxGapLoops,
         stateEntriesUsed: 0,
         maxStateEntries: profile.maxStateEntries,
         maxTimeMs: profile.maxTimeMs,
         stepCosts: {},
         findingsAddedPerLoop: [],
      };
   }

   /** Record a tool call. Returns false if over budget after this call. */
   recordToolCall(): boolean {
      this.state.toolCallsUsed++;
      return this.state.toolCallsUsed <= this.profile.maxToolCalls;
   }

   /** Record token consumption. Returns false if over budget. */
   recordTokens(count: number): boolean {
      this.state.tokensUsed += count;
      return this.state.tokensUsed <= this.profile.maxTokens;
   }

   /** Record an extraction. Returns false if over budget. */
   recordExtraction(): boolean {
      this.state.extractionsUsed++;
      return this.state.extractionsUsed <= this.profile.maxExtractions;
   }

   /** Record state entries (sources + findings + gaps). */
   incrementStateEntries(n: number): boolean {
      if (n < 0) n = 0;
      this.state.stateEntriesUsed += n;
      return this.state.stateEntriesUsed <= this.state.maxStateEntries;
   }

   /** Record a gap loop iteration. */
   recordGapLoop(): void {
      this.state.gapLoopsUsed++;
   }

   /** Record the number of findings added during this gap loop iteration. */
   recordFindingsAddedThisLoop(n: number): void {
      this.state.findingsAddedPerLoop.push(n);
   }

   /**
    * Returns true if the last 2 gap loops each added fewer than 5% of total findings,
    * indicating a confidence plateau. Returns false if fewer than 2 loops recorded.
    */
   isConfidencePlateau(totalFindings: number): boolean {
      const arr = this.state.findingsAddedPerLoop;
      if (arr.length < 2) return false;
      if (totalFindings <= 0) return false;
      const threshold = 0.05 * totalFindings;
      const last = arr[arr.length - 1];
      const secondLast = arr[arr.length - 2];
      if (last === undefined || secondLast === undefined) return false;
      return last < threshold && secondLast < threshold;
   }

   /** Extend the time budget by additionalMs (called when job runtime is extended). */
   extendTimeBudget(additionalMs: number): void {
      this.state.maxTimeMs += additionalMs;
   }

   /** Check if any budget dimension is exhausted. */
   isExhausted(): boolean {
      return (
         this.state.toolCallsUsed >= this.profile.maxToolCalls ||
         this.state.tokensUsed >= this.profile.maxTokens ||
         this.state.extractionsUsed >= this.profile.maxExtractions ||
         this.state.gapLoopsUsed >= this.profile.maxGapLoops ||
         this.state.stateEntriesUsed >= this.state.maxStateEntries ||
         this.elapsedMs() >= this.state.maxTimeMs
      );
   }

   /** Remaining capacity across all dimensions. */
   remaining(): {
      toolCalls: number;
      tokens: number;
      extractions: number;
      gapLoops: number;
      stateEntries: number;
      timeMs: number;
   } {
      return {
         toolCalls: Math.max(0, this.profile.maxToolCalls - this.state.toolCallsUsed),
         tokens: Math.max(0, this.profile.maxTokens - this.state.tokensUsed),
         extractions: Math.max(0, this.profile.maxExtractions - this.state.extractionsUsed),
         gapLoops: Math.max(0, this.profile.maxGapLoops - this.state.gapLoopsUsed),
         stateEntries: Math.max(0, this.state.maxStateEntries - this.state.stateEntriesUsed),
         timeMs: Math.max(0, this.state.maxTimeMs - this.elapsedMs()),
      };
   }

   /** Elapsed milliseconds since construction. */
   elapsedMs(): number {
      return Date.now() - this.state.startTime;
   }

   /** Snapshot for serialization. */
   snapshot(): BudgetState {
      return { ...this.state };
   }
   /** Record a cost against a named research step. */
   recordStepCost(step: string, cost: number): void {
      this.state.stepCosts[step] = (this.state.stepCosts[step] ?? 0) + cost;
   }

   /** Get recorded step costs. */
   getStepCosts(): Record<string, number> {
      return { ...this.state.stepCosts };
   }


}

// ── Research State Engine ────────────────────────────────────────────────────

export class ResearchStateEngine {
   private state: ResearchState;
   private budget: BudgetTracker;

   constructor(budget: BudgetTracker) {
      this.budget = budget;
      this.state = this.createInitialState();
   }

   // ── Initialization ─────────────────────────────────────────────────────

   private createInitialState(): ResearchState {
      return {
         query: '',
         taxonomy: { originalQuery: '', subQuestions: [], revised: false, revisionHistory: [] },
         subQuestions: [],
         sources: [],
         findings: [],
         contradictions: [],
         openQuestions: [],
         gaps: [],
         claimGraph: [],
         currentPhase: 'idle',
         budget: this.budget.snapshot(),
         flags: { taxonomyRevised: false, audited: false, loopCount: 0 },
         gapTargets: [],
         allQuestions: [],
         resolvedGaps: [],
         searchClusters: [],
         diary: [],
         searchAttempts: [],
         workerReports: {},
         contentQuality: {},
         subQuestionCoverage: [],
      };
   }

   initialize(query: string, budget: BudgetTracker): void {
      this.state = this.createInitialState();
      this.state.query = query;
      this.state.taxonomy.originalQuery = query;
      this.budget = budget;
      this.state.budget = this.budget.snapshot();
   }

   getState(): ResearchState {
      return { ...this.state, budget: this.budget.snapshot() };
   }

   getPhase(): ResearchPhase {
      return this.state.currentPhase;
   }

   transitionTo(phase: ResearchPhase): void {
      this.state.currentPhase = phase;
   }

   getBudget(): BudgetTracker {
      return this.budget;
   }

   // ── Sub-questions ──────────────────────────────────────────────────────

   setSubQuestions(questions: SubQuestion[]): void {
      this.state.subQuestions = questions;
      this.state.taxonomy.subQuestions = questions;
   }

   /** Remove sub-questions added at or after a given index (for tree research cleanup). */
   removeSubQuestionsFrom(index: number): void {
      if (index < this.state.subQuestions.length) {
         this.state.subQuestions = this.state.subQuestions.slice(0, index);
      }
      if (index < this.state.taxonomy.subQuestions.length) {
         this.state.taxonomy.subQuestions = this.state.taxonomy.subQuestions.slice(0, index);
      }
   }

   addSubQuestion(sq: SubQuestion): void {
      this.state.subQuestions.push(sq);
      this.state.taxonomy.subQuestions.push(sq);
   }

   getSubQuestions(status?: SubQuestionStatus): SubQuestion[] {
      if (!status) return [...this.state.subQuestions];
      return this.state.subQuestions.filter((sq) => sq.status === status);
   }

   updateSubQuestionStatus(id: string, status: SubQuestionStatus): void {
      const sq = this.state.subQuestions.find((s) => s.id === id);
      if (sq) sq.status = status;
   }

   // ── Taxonomy ───────────────────────────────────────────────────────────

   getTaxonomy(): ResearchTaxonomy {
      return { ...this.state.taxonomy };
   }

   reviseTaxonomy(taxonomy: ResearchTaxonomy): void {
      this.state.taxonomy = taxonomy;
      this.state.taxonomy.revised = true;
      this.state.taxonomy.revisionHistory.push(nowISO());
      this.state.flags.taxonomyRevised = true;
   }

   // ── Sources ────────────────────────────────────────────────────────────

   addSource(entry: SourceEntry): string {
      this.state.sources.push(entry);
      return entry.id;
   }

   getSources(subQuestionId?: string): SourceEntry[] {
      if (!subQuestionId) return [...this.state.sources];
      return this.state.sources.filter((s) => s.relevantSubQuestions.includes(subQuestionId));
   }

   getSourcesByIds(ids: string[]): SourceEntry[] {
      const idSet = new Set(ids);
      return this.state.sources.filter((s) => idSet.has(s.id));
   }

   getTopSources(limit?: number): SourceEntry[] {
      const pending = this.state.sources.filter((s) => s.extractionStatus === 'pending');
      return limit ? pending.slice(0, limit) : pending;
   }

   markSourceExtracted(id: string): void {
      const src = this.state.sources.find((s) => s.id === id);
      if (src) src.extractionStatus = 'extracted';
   }

   markSourceFailed(id: string): void {
      const src = this.state.sources.find((s) => s.id === id);
      if (src) src.extractionStatus = 'failed';
   }

   sourceCount(): number {
      return this.state.sources.length;
   }

   // ── Findings ───────────────────────────────────────────────────────────

   addFinding(finding: Omit<Finding, 'id' | 'createdAt'>): string {
      const id = makeId();
      this.state.findings.push({
         ...finding,
         id,
         createdAt: nowISO(),
      });
      return id;
   }

   getFindings(subQuestionId?: string): Finding[] {
      if (!subQuestionId) return [...this.state.findings];
      return this.state.findings.filter((f) => f.subQuestionIds.includes(subQuestionId));
   }

   getFindingsBySourceId(sourceId: string): Finding[] {
      return this.state.findings.filter((f) => f.sourceIds.includes(sourceId));
   }

   getFinding(id: string): Finding | undefined {
      return this.state.findings.find((f) => f.id === id);
   }

   /** Merge two findings (dedup). Keeps the older finding, absorbs the newer. */
   mergeFindings(keepId: string, absorbId: string): void {
      const keep = this.state.findings.find((f) => f.id === keepId);
      const absorb = this.state.findings.find((f) => f.id === absorbId);
      if (!keep || !absorb) return;

      // Merge source IDs
      keep.sourceIds = [...new Set([...keep.sourceIds, ...absorb.sourceIds])];

      // Merge sub-question IDs
      keep.subQuestionIds = [...new Set([...keep.subQuestionIds, ...absorb.subQuestionIds])];

      keep.lastUpdated = nowISO();

      // Remove absorbed finding
      this.state.findings = this.state.findings.filter((f) => f.id !== absorbId);
   }

   findingCount(): number {
      return this.state.findings.length;
   }

   getKnowledgeMessages(): { role: 'user' | 'assistant'; content: string }[] {
      const messages: { role: 'user' | 'assistant'; content: string }[] = [];
      for (const f of this.state.findings) {
         messages.push({
            role: 'user',
            content: `Research sub-question: ${f.claim}`,
         });
         messages.push({
            role: 'assistant',
            content: `Evidence from ${String(f.sourceIds.length)} source(s): ${f.evidenceExcerpt ?? f.evidenceSummary}`,
         });
      }
      return messages;
   }

   setLanguage(profile: { code: string; style: string }): void {
      this.state.language = { code: profile.code, style: profile.style };
   }

   getLanguage(): { code: string; style: string } | undefined {
      return this.state.language;
   }

   addSearchClusters(clusters: import('./types.js').SearchCluster[]): void {
      this.state.searchClusters.push(...clusters);
   }

   canCorroborate(findingId: string): boolean {
      const f = this.state.findings.find((f) => f.id === findingId);
      if (!f) return false;
      return f.sourceIds.length >= 2;
   }

   // ── V5.0.0: Worker reports ───────────────────────────────────────────────

   /** Store a worker agent's investigation report. */
   addWorkerReport(report: import('./types.js').WorkerReport): void {
      this.state.workerReports[report.id] = report;
   }

   /** Get a specific worker report by ID. */
   getWorkerReport(id: string): import('./types.js').WorkerReport | undefined {
      return this.state.workerReports[id];
   }

   /** Get all worker reports. */
   getAllWorkerReports(): import('./types.js').WorkerReport[] {
      return Object.values(this.state.workerReports);
   }

   /** Count worker reports. */
   workerReportCount(): number {
      return Object.keys(this.state.workerReports).length;
   }

   // ── V5.0.0: Content quality ──────────────────────────────────────────────

   /** Store content quality assessment for a URL. */
   setContentQuality(url: string, quality: import('./types.js').ContentQualityAssessment): void {
      this.state.contentQuality[url] = quality;
   }

   /** Get content quality for a URL. */
   getContentQuality(url: string): import('./types.js').ContentQualityAssessment | undefined {
      return this.state.contentQuality[url];
   }

   /** Get all content quality assessments. */
   getAllContentQuality(): Record<string, import('./types.js').ContentQualityAssessment> {
      return { ...this.state.contentQuality };
   }

   // ── V5.0.0: Sub-question coverage ────────────────────────────────────────

   /** Compute and store per-sub-question coverage metrics. */
   computeSubQuestionCoverage(): import('./types.js').SubQuestionCoverage[] {
      const coverage: import('./types.js').SubQuestionCoverage[] = [];
      for (const sq of this.state.subQuestions) {
         const sqSources = this.state.sources.filter((s) => s.relevantSubQuestions.includes(sq.id));
         const sqFindings = this.state.findings.filter((f) => f.subQuestionIds.includes(sq.id));
         const domains = new Set(sqSources.map((s) => s.domain));
         const contentDepths = sqSources
            .map((s) => this.state.contentQuality[s.url]?.contentDepth)
            .filter((d): d is number => d !== undefined);
         const avgDepth = contentDepths.length > 0
            ? contentDepths.reduce((a, b) => a + b, 0) / contentDepths.length
            : 0;
         const hasPromo = sqSources.some(
            (s) => this.state.contentQuality[s.url]?.isPromotional === true,
         );
         const sourceTypes = [...new Set(sqSources.map((s) => s.sourceType))];

         let status: import('./types.js').SubQuestionCoverage['status'];
         if (sqFindings.length === 0 && sqSources.length === 0) {
            status = 'uncovered';
         } else if (sqSources.length < 2 || domains.size < 2) {
            status = 'thin';
         } else if (hasPromo || avgDepth < 0.4) {
            status = 'risky';
         } else {
            status = 'adequate';
         }

         coverage.push({
            subQuestionId: sq.id,
            subQuestionText: sq.text,
            sourceCount: sqSources.length,
            uniqueDomainCount: domains.size,
            findingCount: sqFindings.length,
            averageContentDepth: avgDepth,
            hasPromotionalSources: hasPromo,
            sourceTypes,
            status,
         });
      }
      this.state.subQuestionCoverage = coverage;
      return coverage;
   }

   /** Get current sub-question coverage metrics. */
   getSubQuestionCoverage(): import('./types.js').SubQuestionCoverage[] {
      return [...this.state.subQuestionCoverage];
   }

   /** Check if all sub-questions have adequate coverage. */
   isCoverageAdequate(): boolean {
      return this.state.subQuestionCoverage.length > 0 &&
         this.state.subQuestionCoverage.every((c) => c.status === 'adequate');
   }

   // ── Post-processing ─────────────────────────────────────────────────

   /**
    * Post-process findings after extraction:
    * 1. Deduplicate near-identical findings by normalized claim similarity
    * 2. Merge duplicate findings (combine source IDs)
    * 3. Run contradiction detection
    * Returns counts of merged findings and total contradictions found.
    */
   postProcessFindings(): { merged: number; contradictions: number } {
      if (this.state.findings.length === 0) return { merged: 0, contradictions: 0 };
      const merged = this.deduplicateFindings();
      const contradictionCount = this.detectContradictions().length;
      return { merged, contradictions: contradictionCount };
   }

   /**
    * Deduplicate findings by normalized claim Jaccard similarity.
    * Merges pairs with similarity > 0.7 into the first finding, absorbing
    * source IDs.
    */
   private deduplicateFindings(): number {
      const findings = this.state.findings;
      const toMerge: { keepId: string; absorbId: string }[] = [];

      for (let i = 0; i < findings.length; i++) {
         const fi = findings[i];
         if (!fi) continue;
         let bestJ = -1;
         let bestSim = 0;
         for (let j = i + 1; j < findings.length; j++) {
            const fj = findings[j];
            if (!fj) continue;
            const sim = jaccardSimilarity(fi.normalizedClaim, fj.normalizedClaim);
            if (sim > 0.7 && sim > bestSim) {
               bestSim = sim;
               bestJ = j;
            }
         }
         if (bestJ >= 0) {
            const fj = findings[bestJ];
            if (fj) {
               toMerge.push({ keepId: fi.id, absorbId: fj.id });
            }
         }
      }

      // Apply merges in a separate pass (no mutation during iteration)
      for (const { keepId, absorbId } of toMerge) {
         this.mergeFindings(keepId, absorbId);
      }

      return toMerge.length;
   }



   // ── Contradictions ─────────────────────────────────────────────────────

   /** Scan for potential contradictions between findings on the same or related sub-questions. */
   detectContradictions(): Contradiction[] {
      const newContradictions: Contradiction[] = [];
      const directionPairs: [string, string][] = [
         ['increase', 'decrease'],
         ['improve', 'reduce'],
         ['faster', 'slower'],
         ['better', 'worse'],
         ['more', 'less'],
         ['higher', 'lower'],
         ['grow', 'shrink'],
         ['benefit', 'harm'],
         ['positive', 'negative'],
         ['superior', 'inferior'],
         ['advantage', 'disadvantage'],
         ['strengthen', 'weaken'],
         ['accelerate', 'decelerate'],
      ];
      const negateWords = new Set([
         'not',
         'cannot',
         "doesn't",
         "don't",
         "isn't",
         "aren't",
         "won't",
         "wouldn't",
         "shouldn't",
         "couldn't",
         'never',
      ]);
      const numberPattern = /\b(\d+(?:\.\d+)?)\s*(%|x|ms|s|gb|mb|tb|hz|gbps|mbps)?/gi;

      for (const f1 of this.state.findings) {
         for (const f2 of this.state.findings) {
            if (f1.id >= f2.id) continue; // skip self and already-checked pairs

            // Check if they share a sub-question or are semantically similar
            const sharedSq = f1.subQuestionIds.some((id) => f2.subQuestionIds.includes(id));
            const topicSimilar =
               !sharedSq && jaccardSimilarity(f1.normalizedClaim, f2.normalizedClaim) > 0.35;
            if (!sharedSq && !topicSimilar) continue;

            const f1Text = f1.claim.toLowerCase();
            const f2Text = f2.claim.toLowerCase();
            const f1Words = new Set(f1Text.split(/\s+/));
            const f2Words = new Set(f2Text.split(/\s+/));

            let contradictionType: ContradictionType | null = null;
            let explanation = '';

            // Check 1: Negation contradiction (one claim asserts, the other negates same topic)
            const f1Negates = [...negateWords].some((w) => f1Words.has(w));
            const f2Negates = [...negateWords].some((w) => f2Words.has(w));
            if (
               f1Negates !== f2Negates &&
               sharedSq &&
               jaccardSimilarity(f1.normalizedClaim, f2.normalizedClaim) > 0.3
            ) {
               contradictionType = 'factual_disagreement';
               explanation = `One claim negates the other on shared topic within sub-question`;
            }

            // Check 2: Directional contradiction (e.g. "improves X" vs "reduces X")
            if (!contradictionType && topicSimilar) {
               for (const [dirA, dirB] of directionPairs) {
                  const a1 = f1Text.includes(dirA) || f1Text.includes(dirB);
                  const a2 = f2Text.includes(dirA) || f2Text.includes(dirB);
                  if (
                     a1 &&
                     a2 &&
                     ((f1Text.includes(dirA) && f2Text.includes(dirB)) ||
                        (f1Text.includes(dirB) && f2Text.includes(dirA)))
                  ) {
                     contradictionType = 'factual_disagreement';
                     explanation = `Claims disagree on direction: "${dirA}" vs "${dirB}"`;
                     break;
                  }
               }
            }

            // Check 3: Numerical contradiction (significant number differences on same topic)
            if (!contradictionType) {
               const nums1: { val: number; unit: string }[] = [];
               const nums2: { val: number; unit: string }[] = [];
               f1Text.replace(numberPattern, (_m: string, val: string, unit?: string) => {
                  nums1.push({ val: parseFloat(val), unit: (unit ?? '').toLowerCase() });
                  return '';
               });
               f2Text.replace(numberPattern, (_m: string, val: string, unit?: string) => {
                  nums2.push({ val: parseFloat(val), unit: (unit ?? '').toLowerCase() });
                  return '';
               });
               if (nums1.length > 0 && nums2.length > 0 && sharedSq) {
                  for (const n1 of nums1) {
                     for (const n2 of nums2) {
                        if (
                           n1.unit === n2.unit &&
                           Math.abs(n1.val - n2.val) / Math.max(n1.val, n2.val) > 0.3
                        ) {
                           contradictionType = 'factual_disagreement';
                           explanation = `Claims have significantly different numerical values (${JSON.stringify(n1)} vs ${JSON.stringify(n2)})`;
                           break;
                        }
                     }
                     if (contradictionType) break;
                  }
               }
            }

            // Check 4: Scope mismatch
            if (!contradictionType && sharedSq) {
               const scopeWords = new Set([
                  'always',
                  'never',
                  'all',
                  'none',
                  'every',
                  'any',
                  'completely',
                  'entirely',
               ]);
               const quantifiers1 = [...scopeWords].filter((w) => f1Words.has(w));
               const quantifiers2 = [...scopeWords].filter((w) => f2Words.has(w));
               if (
                  quantifiers1.length > 0 &&
                  quantifiers2.length > 0 &&
                  jaccardSimilarity(f1.normalizedClaim, f2.normalizedClaim) > 0.25
               ) {
                  contradictionType = 'scope_mismatch';
                  explanation = 'Claims use absolute/universal quantifiers suggesting scope mismatch';
               }
            }

            if (contradictionType) {
               const id = makeId();
               newContradictions.push({
                  id,
                  claimA: f1.claim,
                  claimB: f2.claim,
                  sourceIdsA: [...f1.sourceIds],
                  sourceIdsB: [...f2.sourceIds],
                  contradictionType,
                  resolutionStatus: 'unresolved',
                  ...(explanation ? { likelyExplanation: explanation } : {}),
               });
            }
         }
      }

      // Add only new contradictions (not already tracked)
      for (const c of newContradictions) {
         const exists = this.state.contradictions.some(
            (existing) => existing.claimA === c.claimA && existing.claimB === c.claimB,
         );
         if (!exists) {
            this.state.contradictions.push(c);
         }
      }

      return this.state.contradictions;
   }

   addContradiction(c: Contradiction): void {
      this.state.contradictions.push(c);
   }

   resolveContradiction(id: string, status: ContradictionStatus, explanation?: string): void {
      const c = this.state.contradictions.find((c) => c.id === id);
      if (!c) return;
      c.resolutionStatus = status;
      if (explanation) c.likelyExplanation = explanation;
   }

   getUnresolvedContradictions(): Contradiction[] {
      return this.state.contradictions.filter((c) => c.resolutionStatus === 'unresolved');
   }

   contradictionCount(): number {
      return this.state.contradictions.length;
   }

   // ── Gaps ───────────────────────────────────────────────────────────────

   addGap(gap: GapRecord): string {
      this.state.gaps.push(gap);
      return gap.id;
   }

   getOpenGaps(): GapRecord[] {
      return this.state.gaps.filter(
         (g: GapRecord) => g.status === 'open' || g.status === 'in_progress',
      );
   }

   updateGapStatus(id: string, status: GapStatus): void {
      const g = this.state.gaps.find((g) => g.id === id);
      if (g) g.status = status;
   }

   closeGap(id: string): void {
      this.updateGapStatus(id, 'resolved');
   }

   /** Push a gap target description onto the FIFO queue, deduplicating against allQuestions. */
   addGapTarget(question: string, _parentQuestion?: string): void {
      if (this.state.allQuestions.includes(question)) return;
      this.state.allQuestions.push(question);
      this.state.gapTargets.push(question);
   }

   /** Pop the next pending gap target from the FIFO queue (or undefined if empty). */
   popNextGapTarget(): string | undefined {
      return this.state.gapTargets.shift();
   }

   /** Check if any gap targets remain in the queue. */
   hasPendingGapTargets(): boolean {
      return this.state.gapTargets.length > 0;
   }

   /** Append a human-readable diary entry, trimming to last 50 entries. */
   appendDiary(entry: string): void {
      this.state.diary.push(entry);
      if (this.state.diary.length > 50) {
         this.state.diary = this.state.diary.slice(-50);
      }
   }

   // ── Open questions ─────────────────────────────────────────────────────

   addOpenQuestion(question: string): void {
      this.state.openQuestions.push(question);
   }

   getOpenQuestions(): string[] {
      return [...this.state.openQuestions];
   }

   // ── Claim graph ────────────────────────────────────────────────────────

   addClaimEdge(edge: ClaimEdge): void {
      this.state.claimGraph.push(edge);
   }

   getRelatedClaims(findingId: string): ClaimEdge[] {
      return this.state.claimGraph.filter(
         (e) => e.sourceFindingId === findingId || e.targetFindingId === findingId,
      );
   }

   // ── Flags ──────────────────────────────────────────────────────────────

   isTaxonomyRevised(): boolean {
      return this.state.flags.taxonomyRevised;
   }

   markAudited(): void {
      this.state.flags.audited = true;
   }

   isAudited(): boolean {
      return this.state.flags.audited;
   }

   incrementLoop(): void {
      this.state.flags.loopCount++;
   }

   loopCount(): number {
      return this.state.flags.loopCount;
   }

   // ── Serialization ──────────────────────────────────────────────────────

   toJSON(): ResearchState {
      return this.getState();
   }

   /** Restore from a serialized state. Replaces current state entirely. */
   fromJSON(state: ResearchState): void {
      this.state = {
         query: state.query,
         taxonomy: state.taxonomy,
         subQuestions: state.subQuestions.map((sq: SubQuestion) => ({ ...sq })),
         sources: state.sources.map((s: SourceEntry) => ({ ...s })),
         findings: state.findings.map((f: Finding) => ({ ...f })),
         contradictions: state.contradictions.map((c: Contradiction) => ({ ...c })),
         openQuestions: [...state.openQuestions],
         gaps: state.gaps.map((g: GapRecord) => ({ ...g })),
         claimGraph: state.claimGraph.map((e: ClaimEdge) => ({ ...e })),
         currentPhase: state.currentPhase,
         budget: { ...state.budget },
         flags: { ...state.flags },
         gapTargets: [...state.gapTargets],
         allQuestions: [...state.allQuestions],
         resolvedGaps: state.resolvedGaps.map((g) => ({ ...g })),
         searchClusters: state.searchClusters.map((c) => ({ ...c })),
         diary: [...state.diary],
         searchAttempts: [...state.searchAttempts],
         workerReports: { ...state.workerReports },
         contentQuality: { ...state.contentQuality },
         subQuestionCoverage: state.subQuestionCoverage.map((c) => ({ ...c })),
         ...(state.language ? { language: { ...state.language } } : {}),
      };
   }

   /** Produce a compressed view for gap analysis (no full text, just summaries). */
   compress(): {
      phase: ResearchPhase;
      sourceCount: number;
      findingCount: number;
      contradictionCount: number;
      unresolvedContradictions: number;
      openGapCount: number;
      subQuestionStatuses: { id: string; text: string; status: SubQuestionStatus }[];
   } {
      return {
         phase: this.state.currentPhase,
         sourceCount: this.state.sources.length,
         findingCount: this.state.findings.length,
         contradictionCount: this.state.contradictions.length,
         unresolvedContradictions: this.getUnresolvedContradictions().length,
         openGapCount: this.getOpenGaps().length,
         subQuestionStatuses: this.state.subQuestions.map((sq: SubQuestion) => ({
            id: sq.id,
            text: sq.text,
            status: sq.status,
         })),
      };
   }

}