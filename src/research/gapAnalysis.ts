/**
 * V4.0.0 — Phase 5: Adaptive Gap Analysis.
 *
 * After extraction, identifies knowledge gaps and generates targeted
 * follow-up tasks.  Provides two classes:
 *
 *   GapAnalyzer – inspects current state and produces GapRecord[]
 *   GapFiller   – stores gaps in state engine and implements loop
 *                 stop heuristics.
 * The orchestrator calls analyze() → fillGaps() → shouldContinueLoop()
 * to drive the discovery loop.
 */

import { randomUUID } from 'node:crypto';
import type { GapRecord, GapCategory, SourceType, ConfidenceLabel } from './types.js';
import { ResearchStateEngine, BudgetTracker, labelToConfidence } from './state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const RECENCY_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function gapId(): string {
   return randomUUID().slice(0, 12);
}

/** Default priority per gap category.  1 = highest, 5 = lowest. */
function defaultPriority(category: GapCategory): number {
   switch (category) {
      case 'unanswered_sub_question':
         return 1;
      case 'low_confidence':
         return 2;
      case 'missing_source_type':
         return 3;
      case 'missing_recency':
         return 4;
      case 'overrepresented_viewpoint':
         return 3;
      case 'unresolvable_contradiction':
         return 2;
   }
}

/** Human-readable, actionable follow-up suggestions per gap type. */
function suggestActions(
   category: GapCategory,
   ctx: {
      subQuestionText?: string;
      claim?: string;
      preferredSources?: SourceType[];
      underrepresentedTypes?: SourceType[];
      overrepresentedType?: SourceType;
   },
): string[] {
   switch (category) {
      case 'unanswered_sub_question':
         return [
            `Search for "${ctx.subQuestionText ?? 'this topic'}" using web and preferred sources`,
            ...(ctx.preferredSources?.length
               ? [`Prioritise source types: ${ctx.preferredSources.join(', ')}`]
               : []),
         ];

      case 'low_confidence':
         return [
            `Find corroborating evidence for: "${ctx.claim ?? 'unknown claim'}"`,
            'Seek multiple independent sources to triangulate',
         ];

      case 'missing_source_type': {
         const suggestions = ['Expand search to include underrepresented source categories'];
         if (ctx.underrepresentedTypes?.length) {
            suggestions.push(`Try: ${ctx.underrepresentedTypes.slice(0, 4).join(', ')}`);
         }
         return suggestions;
      }

      case 'missing_recency':
         return [
            `Search for recent updates about: "${ctx.claim ?? 'this topic'}"`,
            'Apply date filters to find sources from the last 12 months',
         ];

      case 'overrepresented_viewpoint':
         return [
            `Balance over-represented type "${ctx.overrepresentedType ?? 'primary type'}"`,
            'Actively seek alternative viewpoints from other source categories',
         ];

      case 'unresolvable_contradiction':
         return [
            `Seek additional evidence to resolve contradiction: "${ctx.claim ?? 'disputed claim'}"`,
            'Look for authoritative sources (official docs, meta-analyses, benchmarks)',
         ];
   }
}

// ── GapAnalyzer ──────────────────────────────────────────────────────────────

export class GapAnalyzer {
   constructor(private state: ResearchStateEngine) { }

   /**
    * Analyse the current research state and produce gap records for every
    * detected deficiency.  Does **not** mutate state — the caller (typically
    * `GapFiller.fillGaps()`) is responsible for persisting.
    */
   analyze(): GapRecord[] {
      const gaps: GapRecord[] = [];

      gaps.push(...this.unansweredSubQuestions());
      gaps.push(...this.lowConfidenceClaims());
      gaps.push(...this.missingSourceTypes());
      gaps.push(...this.missingRecency());
      gaps.push(...this.overrepresentedViewpoints());

      return gaps;
   }

   // ── detection methods ───────────────────────────────────────────────────

   /**
    * Sub-questions whose status is still `'pending'` — never touched by
    * any discovery iteration.
    */
   private unansweredSubQuestions(): GapRecord[] {
      const state = this.state.getState();
      const pending = state.subQuestions.filter((sq) => sq.status === 'pending');

      return pending.map((sq) => ({
         id: gapId(),
         category: 'unanswered_sub_question' as const,
         description: `Sub-question has not been addressed yet: "${sq.text}"`,
         subQuestionId: sq.id,
         status: 'open' as const,
         suggestedActions: suggestActions('unanswered_sub_question', {
            subQuestionText: sq.text,
            preferredSources: sq.preferredSources,
         }),
         priority: defaultPriority('unanswered_sub_question'),
      }));
   }

   /**
    * Findings with confidence < 0.5 (speculative or unsupported) that need
    * corroboration from additional sources.
    */
   private lowConfidenceClaims(): GapRecord[] {
      const state = this.state.getState();
      return state.findings
         .filter((f) => f.confidence < 0.5)
         .map((f) => ({
            id: gapId(),
            category: 'low_confidence' as const,
            description: `Low-confidence finding (${(f.confidence * 100).toFixed(0)}%) needs corroboration: "${f.claim}"`,
            relatedFindingId: f.id,
            status: 'open' as const,
            suggestedActions: suggestActions('low_confidence', { claim: f.claim }),
            priority: defaultPriority('low_confidence'),
         }));
   }

   /**
    * When only 1–2 distinct source types are present in the source registry,
    * signal a diversity gap and suggest the missing categories.
    */
   private missingSourceTypes(): GapRecord[] {
      const state = this.state.getState();
      if (state.sources.length === 0) return [];

      const present = new Set(state.sources.map((s) => s.sourceType));
      if (present.size >= 3) return []; // already diverse enough

      const allTypes: SourceType[] = [
         'academic',
         'web',
         'github',
         'reddit',
         'hackernews',
         'stackoverflow',
         'documentation',
         'news',
         'patent',
         'podcast',
         'producthunt',
         'youtube',
      ];
      const underrepresented = allTypes.filter((t) => !present.has(t));

      return [
         {
            id: gapId(),
            category: 'missing_source_type' as const,
            description: `Only ${String(present.size)} source type(s) represented (${[...present].join(', ')}). Need more diversity.`,
            status: 'open' as const,
            suggestedActions: suggestActions('missing_source_type', {
               underrepresentedTypes: underrepresented,
            }),
            priority: defaultPriority('missing_source_type'),
         },
      ];
   }

   /**
    * Findings that are `freshnessSensitive` whose every backing source is
    * older than 1 year (or carries no published date).
    */
   private missingRecency(): GapRecord[] {
      const state = this.state.getState();
      const now = Date.now();
      const threshold = now - RECENCY_THRESHOLD_MS;
      const gaps: GapRecord[] = [];

      for (const finding of state.findings) {
         if (!finding.freshnessSensitive) continue;
         if (finding.sourceIds.length === 0) continue;

         const sources = state.sources.filter((s) => finding.sourceIds.includes(s.id));

         const allOld =
            sources.length > 0 &&
            sources.every((s) => {
               if (!s.publishedDate) return true; // unknown → treat as stale
               return new Date(s.publishedDate).getTime() < threshold;
            });

         if (allOld) {
            gaps.push({
               id: gapId(),
               category: 'missing_recency' as const,
               description: `Freshness-sensitive finding relies on sources >1 year old: "${finding.claim}"`,
               relatedFindingId: finding.id,
               status: 'open' as const,
               suggestedActions: suggestActions('missing_recency', {
                  claim: finding.claim,
               }),
               priority: defaultPriority('missing_recency'),
            });
         }
      }

      return gaps;
   }

   /**
    * When >70 % of all sources belong to a single type, flag it as an
    * over-represented viewpoint that may bias the synthesis.
    */
   private overrepresentedViewpoints(): GapRecord[] {
      const state = this.state.getState();
      if (state.sources.length === 0) return [];

      const typeCounts: Record<string, number> = {};
      for (const s of state.sources) {
         typeCounts[s.sourceType] = (typeCounts[s.sourceType] ?? 0) + 1;
      }

      const total = state.sources.length;
      const gaps: GapRecord[] = [];

      for (const [type, count] of Object.entries(typeCounts)) {
         const fraction = count / total;
         if (fraction > 0.7) {
            gaps.push({
               id: gapId(),
               category: 'overrepresented_viewpoint' as const,
               description: `Source type "${type}" dominates (${(fraction * 100).toFixed(0)}% of all sources). Bias risk.`,
               status: 'open' as const,
               suggestedActions: suggestActions('overrepresented_viewpoint', {
                  overrepresentedType: type as SourceType,
               }),
               priority: defaultPriority('overrepresented_viewpoint'),
            });
         }
      }

      return gaps;
   }
}

// ── GapFiller ────────────────────────────────────────────────────────────────

export class GapFiller {
   constructor(
      private state: ResearchStateEngine,
      private budget: BudgetTracker,
   ) { }

   /**
    * Persist detected gaps into the state engine (deduplicating against
    * already-open gaps) and record a gap-loop iteration.
    *
    * Returns:
    *   `filled`   – number of gaps newly added to state
    *   `remaining` – gaps that already existed (caller may choose to retry
    *                  or ignore)
    */
   async fillGaps(gaps: GapRecord[]): Promise<{ filled: number; remaining: GapRecord[] }> {
      // Build a set of already-tracked gap keys so we don't duplicate.
      const existingKeys = new Set(
         this.state.getOpenGaps().map((g) => gapKey(g.category, g.subQuestionId, g.relatedFindingId)),
      );

      let filled = 0;
      const remaining: GapRecord[] = [];

      for (const gap of gaps) {
         const key = gapKey(gap.category, gap.subQuestionId, gap.relatedFindingId);

         if (existingKeys.has(key)) {
            remaining.push(gap);
            continue;
         }

         this.state.addGap(gap);
         existingKeys.add(key);
         filled++;
      }

      this.budget.recordGapLoop();

      return { filled, remaining };
   }

   /**
    * Stop heuristics checked before entering each gap-filling loop.
    *
    * Returns `false` (stop) when any of these conditions hold:
    *   - Budget exhausted
    *   - No open gaps
    *   - All open gaps are low-priority (priority > 3)
    *   - All sub-questions are `'sufficient'` or `'unresolvable'`
    *   - The average confidence improvement since the last loop is below
    *     the information-gain threshold
    *
    * @param previousConfidenceDistribution – distribution from the state
    *    snapshot taken **before** the most recent gap loop.  When provided,
    *    the method computes the current distribution and compares averages
    *    via `BudgetTracker.isInformationGainWorthwhile`.
    */
   shouldContinueLoop(previousConfidenceDistribution?: Record<ConfidenceLabel, number>): boolean {
      // 1. Budget exhausted?
      if (this.budget.isExhausted()) return false;

      // 2. No open gaps?
      const openGaps = this.state.getOpenGaps();
      if (openGaps.length === 0) return false;

      // 3. All open gaps are low priority?
      if (openGaps.every((g) => g.priority > 3)) return false;

      // 4. All sub-questions resolved?
      const state = this.state.getState();
      const allSubQuestionsResolved =
         state.subQuestions.length > 0 &&
         state.subQuestions.every((sq) => sq.status === 'sufficient' || sq.status === 'unresolvable');
      if (allSubQuestionsResolved) return false;

      // 5. Confidence improvement worthwhile?
      if (previousConfidenceDistribution) {
         const currentDist = this.computeConfidenceDistribution();
         const prevAvg = weightedAverageConfidence(previousConfidenceDistribution);
         const currAvg = weightedAverageConfidence(currentDist);

         if (!this.budget.isInformationGainWorthwhile(prevAvg, currAvg)) {
            return false;
         }
      }

      return true;
   }

   /**
    * Push new gap target questions to the state engine with dedup.
    */
   pushGapTargets(questions: string[]): number {
      let count = 0;
      for (const q of questions) {
         const id = this.state.addGapTarget(q);
         if (id) count++;
      }
      return count;
   }

   // ── private helpers ────────────────────────────────────────────────────

   /** Delegate to `state.compress()` and return only the distribution map. */
   private computeConfidenceDistribution(): Record<string, number> {
      return this.state.compress().confidenceDistribution;
   }
}

// ── FailureAnalyzer ───────────────────────────────────────────────────────────

/**
 * Analyzes why an answer failed evaluation and produces an improvement plan.
 */
export class FailureAnalyzer {
   constructor(
      private llm?: import('./llm/chat.js').DeepResearchLlmClient,
   ) { }

   /**
    * Analyze a failed answer and produce a failure analysis.
    */
   async analyzeFailure(
      question: string,
      answer: string,
      evaluationFeedback: string,
   ): Promise<import('./types.js').FailureAnalysis> {
      if (this.llm) {
         try {
            const { WORKER_FAILURE_ANALYSIS } = await import('./llm/prompts.js');
            const result = await this.llm.callJSON<import('./types.js').FailureAnalysis>({
               model: 'worker',
               messages: [
                  { role: 'system', content: WORKER_FAILURE_ANALYSIS },
                  {
                     role: 'user',
                     content: `Question: ${question}\nFailed answer: ${answer}\nEvaluation feedback: ${evaluationFeedback}`,
                  },
               ],
               temperature: 0.3,
            });
            if (result.success) return result.data;
         } catch {
            // fall through to rule-based
         }
      }

      // Rule-based fallback
      return {
         recap: 'Answer was insufficient given the available evidence',
         blame: 'Missing or insufficient evidence',
         improvement: 'Search with different keywords or consult additional source types',
      };
   }
}

// ── gap-level helpers (shared across both classes) ──────────────────────────

/**
 * Deterministic key for gap deduplication across loops.
 */
function gapKey(category: GapCategory, subQuestionId?: string, relatedFindingId?: string): string {
   return `${category}::${subQuestionId ?? ''}::${relatedFindingId ?? ''}`;
}

/**
 * Compute a weighted average confidence from a label-count distribution,
 * reusing `labelToConfidence` from the state engine for the label→value
 * mapping.
 */
function weightedAverageConfidence(distribution: Record<string, number>): number {
   let totalWeight = 0;
   let sum = 0;

   for (const [label, count] of Object.entries(distribution)) {
      const value = labelToConfidence(label as ConfidenceLabel);
      sum += value * count;
      totalWeight += count;
   }

   return totalWeight > 0 ? sum / totalWeight : 0;
}
