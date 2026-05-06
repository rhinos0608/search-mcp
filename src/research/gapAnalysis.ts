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
import type { GapRecord, GapCategory, SourceType, ContentQualityAssessment, SubQuestionCoverage } from './types.js';
import { ResearchStateEngine, BudgetTracker } from './state.js';

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
      case 'thin_coverage':
         return 1;
      case 'single_source_dependency':
         return 1;
      case 'low_content_depth':
         return 2;
      case 'promotional_bias':
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

      case 'thin_coverage':
         return [
            `Search with broader terms for: "${ctx.subQuestionText ?? 'this topic'}"`,
            'Try alternative search backends (academic, GitHub, Reddit)',
         ];

      case 'low_content_depth':
         return [
            `Find more substantive sources about: "${ctx.claim ?? 'this topic'}"`,
            'Prefer long-form articles, documentation, or academic papers',
         ];

      case 'single_source_dependency':
         return [
            `Find independent sources beyond: "${ctx.subQuestionText ?? 'this topic'}"`,
            'Seek at least 2 more domains with relevant analysis',
         ];

      case 'promotional_bias':
         return [
            `Find independent/non-commercial sources about: "${ctx.subQuestionText ?? 'this topic'}"`,
            'Look for academic papers, official docs, or community discussions',
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
   analyze(
      coverage?: SubQuestionCoverage[],
      contentQuality?: Record<string, ContentQualityAssessment>,
   ): GapRecord[] {
      const gaps: GapRecord[] = [];

      gaps.push(...this.unansweredSubQuestions());

      gaps.push(...this.missingSourceTypes());
      gaps.push(...this.missingRecency());
      gaps.push(...this.overrepresentedViewpoints());

      if (coverage) {
         gaps.push(...this.thinCoverage(coverage));
      }
      if (coverage && contentQuality) {
         gaps.push(...this.lowContentDepth(coverage, contentQuality));
         gaps.push(...this.promotionalBias(coverage, contentQuality));
      }

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

   /**
    * Sub-questions with thin or no coverage that need more sources.
    * When coverage shows <2 sources or a single domain, flags as thin_coverage
    * or single_source_dependency respectively.
    */
   private thinCoverage(coverage: SubQuestionCoverage[]): GapRecord[] {
      const gaps: GapRecord[] = [];
      const dedupKeys = new Set<string>();
      const state = this.state.getState();

      for (const sq of coverage) {
         if (sq.status !== 'thin' && sq.status !== 'uncovered') continue;

         // Skip unresolvable sub-questions.
         const subQuestion = state.subQuestions.find((s) => s.id === sq.subQuestionId);
         if (subQuestion?.status === 'unresolvable') continue;

         const category =
            sq.uniqueDomainCount <= 1 ? 'single_source_dependency' : 'thin_coverage';
         const key = gapKey(category, sq.subQuestionId);
         if (dedupKeys.has(key)) continue;
         dedupKeys.add(key);

         gaps.push({
            id: gapId(),
            category,
            description: `Sub-question "${sq.subQuestionText}" has only ${String(sq.sourceCount)} source(s) from ${String(sq.uniqueDomainCount)} domain(s)`,
            subQuestionId: sq.subQuestionId,
            status: 'open' as const,
            suggestedActions: suggestActions(category, {
               subQuestionText: sq.subQuestionText,
            }),
            priority: defaultPriority(category),
         });
      }

      return gaps;
   }

   /**
    * Sub-questions whose average content depth is below 0.4, indicating
    * mostly surface-level sources with little analytical substance.
    */
   private lowContentDepth(
      coverage: SubQuestionCoverage[],
      _contentQuality: Record<string, ContentQualityAssessment>,
   ): GapRecord[] {
      const gaps: GapRecord[] = [];
      const dedupKeys = new Set<string>();

      for (const sq of coverage) {
         if (sq.averageContentDepth >= 0.4) continue;

         // Only flag if sources are from non-academic types (academic sources
         // are inherently substantive even if depth appears low).
         const hasNonAcademic = sq.sourceTypes.some((t) => t !== 'academic');
         if (!hasNonAcademic) continue;

         const key = gapKey('low_content_depth', sq.subQuestionId);
         if (dedupKeys.has(key)) continue;
         dedupKeys.add(key);

         gaps.push({
            id: gapId(),
            category: 'low_content_depth' as const,
            description: `Sub-question "${sq.subQuestionText}" has low average content depth (${sq.averageContentDepth.toFixed(2)})`,
            subQuestionId: sq.subQuestionId,
            status: 'open' as const,
            suggestedActions: suggestActions('low_content_depth', {
               claim: sq.subQuestionText,
            }),
            priority: defaultPriority('low_content_depth'),
         });
      }

      return gaps;
   }

   /**
    * Sub-questions where more than 30% of sources exhibit promotional
    * characteristics (marketing content, vendor pages, sponsored posts).
    */
   private promotionalBias(
      coverage: SubQuestionCoverage[],
      contentQuality: Record<string, ContentQualityAssessment>,
   ): GapRecord[] {
      const gaps: GapRecord[] = [];
      const dedupKeys = new Set<string>();
      const state = this.state.getState();

      for (const sq of coverage) {
         if (!sq.hasPromotionalSources) continue;

         // Count promotional sources for this sub-question.
         const sqSources = state.sources.filter(
            (s) => s.subQuestionId === sq.subQuestionId,
         );
         if (sqSources.length === 0) continue;

         let promoCount = 0;
         for (const src of sqSources) {
            const quality = contentQuality[src.url];
            if (quality?.isPromotional) promoCount++;
         }

         const ratio = promoCount / sqSources.length;
         if (ratio <= 0.3) continue;

         const key = gapKey('promotional_bias', sq.subQuestionId);
         if (dedupKeys.has(key)) continue;
         dedupKeys.add(key);

         gaps.push({
            id: gapId(),
            category: 'promotional_bias' as const,
            description: `Sub-question "${sq.subQuestionText}" has ${String(promoCount)} promotional source(s) out of ${String(sqSources.length)}`,
            subQuestionId: sq.subQuestionId,
            status: 'open' as const,
            suggestedActions: suggestActions('promotional_bias', {
               subQuestionText: sq.subQuestionText,
            }),
            priority: defaultPriority('promotional_bias'),
         });
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
    */
   shouldContinueLoop(): boolean {
      // 1. Budget exhausted?
      if (this.budget.isExhausted()) return false;

      // Thin-coverage override: if any sub-question has <2 sources from <2 domains,
      // continue the loop regardless of other stopping conditions.
      const state = this.state.getState();
      const hasThinCoverage = state.subQuestions.some((sq) => {
         const sqSources = state.sources.filter((s) => s.subQuestionId === sq.id);
         if (sqSources.length === 0) return true;
         const domains = new Set(sqSources.map((s) => s.domain));
         return sqSources.length < 2 || domains.size < 2;
      });
      if (hasThinCoverage) return true;

      // 2. No open gaps?
      const openGaps = this.state.getOpenGaps();
      if (openGaps.length === 0) return false;

      // 3. All open gaps are low priority?
      if (openGaps.every((g) => g.priority > 3)) return false;

      // 4. All sub-questions resolved?
      const allSubQuestionsResolved =
         state.subQuestions.length > 0 &&
         state.subQuestions.every((sq) => sq.status === 'sufficient' || sq.status === 'unresolvable');
      if (allSubQuestionsResolved) return false;



      return true;
   }

   // ── private helpers ────────────────────────────────────────────────────


}

// ── gap-level helpers (shared across both classes) ──────────────────────────

/**
 * Deterministic key for gap deduplication across loops.
 */
function gapKey(category: GapCategory, subQuestionId?: string, relatedFindingId?: string): string {
   return `${category}::${subQuestionId ?? ''}::${relatedFindingId ?? ''}`;
}

