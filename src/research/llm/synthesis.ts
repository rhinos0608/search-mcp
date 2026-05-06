/**
 * V4.0.0 Deep Research — LLM-based synthesis subagent.
 *
 * Calls the orchestrator LLM to generate a narrative ResearchReport from the
 * full research state, with fallback to the rule-based ResearchSynthesizer.
 */

import { DeepResearchLlmClient } from './chat.js';
import { ORCHESTRATOR_SYNTHESIS_V2 } from './prompts.js';
import { logger } from '../../logger.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import type {
   ResearchState,
   ResearchReport,
   ResearchDepth,
   SubQuestion,
   Finding,
   SourceEntry,
   Contradiction,
   GapRecord,
} from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_SYNTHESIS_MAX_TOKENS = 8_000;

// ── State-summary helpers (avoids circular dep on full Finding/Source types) ──

interface SummarySubQuestion {
   id: string;
   text: string;
   status: string;
}

interface SummaryFinding {
   claim: string;
   evidenceDirectness: string;
   sourceCount: number;
   caveats?: string;
}

interface SummarySource {
   index: number;
   title: string;
   url: string;
   sourceType: string;
}

interface SummaryContradiction {
   claimA: string;
   claimB: string;
   resolutionStatus: string;
}

interface SummaryGap {
   description: string;
   status: string;
   priority: number;
}

interface ResearchStateSummary {
   query: string;
   depth: string;
   claimEdgeCount: number;
   totalSourceCount: number;
   sourceTypeCount: number;
   sourceDiversity: { type: string; count: number }[];
   budgetRemaining: {
      toolCalls: number;
      tokens: number;
      extractions: number;
      gapLoops: number;
      timeMs: number;
   };
   subQuestions: SummarySubQuestion[];
   findings: SummaryFinding[];
   sources: SummarySource[];
   contradictions: SummaryContradiction[];
   gaps: SummaryGap[];
   openQuestions: string[];
   conversationKnowledge?: { role: string; content: string }[];
   diary?: string[];
}

// ── Type guard ───────────────────────────────────────────────────────────────

/**
 * Validate that an unknown value conforms to the ResearchReport shape.
 *
 * Designed as a standalone type guard so the compiler narrows the type in
 * strict mode without forcing inline casts or assertions.
 */
function isResearchReport(value: unknown): value is ResearchReport {
   if (value === null || typeof value !== 'object') return false;

   const r = value as Record<string, unknown>;

   if (typeof r.query !== 'string') return false;
   if (typeof r.executiveSummary !== 'string') return false;

   if (!Array.isArray(r.themes)) return false;
   for (const t of r.themes) {
      if (t === null || typeof t !== 'object') return false;
      const theme = t as Record<string, unknown>;
      if (typeof theme.title !== 'string') return false;
      // Accept either 'narrative' (new) or 'findings' (backward compat)
      if (typeof theme.narrative !== 'string' && !Array.isArray(theme.findings)) {
         return false;
      }
      if (theme.findings !== undefined && !Array.isArray(theme.findings)) return false;
   }

   // contradictions can be an empty array — just check it's an array
   if (!Array.isArray(r.contradictions)) return false;

   if (typeof r.classification !== 'string') return false;
   if (typeof r.depth !== 'string') return false;

   // uncertainties, sourceNotes, openQuestions, limitations are string[]
   const stringArrayFields: (keyof ResearchReport)[] = [
      'uncertainties',
      'sourceNotes',
      'openQuestions',
      'limitations',
   ];
   for (const field of stringArrayFields) {
      if (!Array.isArray(r[field])) return false;
      for (const item of r[field] as unknown[]) {
         if (typeof item !== 'string') return false;
      }
   }

   if (typeof r.sourceCount !== 'number') return false;
   if (typeof r.findingCount !== 'number') return false;

   return true;
}

// ── LlmSynthesizer ───────────────────────────────────────────────────────────

export class LlmSynthesizer {
   constructor(private readonly llm: DeepResearchLlmClient) { }

   /**
    * Generate a synthesis report from the research state.
    *
    * Sends the orchestrator LLM a compact state summary with the
    * ORCHESTRATOR_SYNTHESIS prompt. On failure or invalid output, falls back
    * to the rule-based ResearchSynthesizer.
    */
   async synthesize(
      state: ResearchState,
      options?: { maxTokens?: number },
   ): Promise<ResearchReport> {
      const summary = this.buildStateSummary(state);
      const maxTokens = options?.maxTokens ?? DEFAULT_SYNTHESIS_MAX_TOKENS;

      const result = await this.llm.callJSON<ResearchReport>({
         model: 'orchestrator',
         messages: [
            { role: 'system' as const, content: ORCHESTRATOR_SYNTHESIS_V2 },
            {
               role: 'user' as const,
               content: `Research state summary:\n${summary}`,
            },
         ],
         maxTokens,
         timeoutMs: 180_000, // 3 min — synthesis prompts are large
      });

      if (!result.success) {
         logger.warn(
            { error: result.response.error },
            'LLM synthesis V2 failed; falling back to rule-based synthesizer',
         );
         return this.fallback(state);
      }

      // Ensure narrativeMarkdown is populated — if LLM returned empty, build from themes
      const data = result.data;
      if (!data.narrativeMarkdown || data.narrativeMarkdown.trim().length === 0) {
         data.narrativeMarkdown = this.buildNarrativeFromThemes(data);
      }

      if (!isResearchReport(data)) {
         logger.warn(
            { data: JSON.stringify(data).slice(0, 200) },
            'LLM synthesis returned invalid report shape; falling back to rule-based synthesizer',
         );
         return this.fallback(state);
      }

      return data;
   }

   // ── Private helpers ──────────────────────────────────────────────────────

   /**
    * Build narrativeMarkdown from themes when the LLM didn't produce one.
    * This is a fallback to ensure we always have a readable report.
    */
   private buildNarrativeFromThemes(report: ResearchReport): string {
      const parts: string[] = [];
      parts.push(`# Research Report: ${report.query}\n`);
      parts.push(`## Executive Summary\n${report.executiveSummary}\n`);

      for (const theme of report.themes) {
         parts.push(`## ${theme.title}\n`);
         if (theme.narrative) {
            parts.push(`${theme.narrative}\n`);
         } else if (theme.findings && theme.findings.length > 0) {
            parts.push(theme.findings.join('\n\n') + '\n');
         }
      }

      if (report.contradictions.length > 0) {
         parts.push('## Contradictions & Debates\n');
         for (const c of report.contradictions) {
            parts.push(`- **${c.claimA}** vs **${c.claimB}** (${c.resolutionStatus})\n`);
         }
         parts.push('');
      }

      if (report.uncertainties.length > 0) {
         parts.push('## Uncertainties & Limitations\n');
         for (const u of report.uncertainties) {
            parts.push(`- ${u}\n`);
         }
         parts.push('');
      }

      if (report.openQuestions.length > 0) {
         parts.push('## Open Questions\n');
         for (const q of report.openQuestions) {
            parts.push(`- ${q}\n`);
         }
         parts.push('');
      }

      if (report.recommendations) {
         parts.push(`## Recommendations\n${report.recommendations}\n`);
      }

      return parts.join('\n');
   }

   /**
    * Build a compact JSON summary of the research state.
    *
    * Excludes full text content (evidenceExcerpts, full source bodies) to stay
    * under ~8000 characters for the LLM context window.
    */
   private buildStateSummary(state: ResearchState): string {
      const depth = this.inferDepth(state.sources.length);

      // Compute source type breakdown for the LLM
      const typeMap = new Map<string, number>();
      for (const s of state.sources) {
         typeMap.set(s.sourceType, (typeMap.get(s.sourceType) ?? 0) + 1);
      }
      const sourceDiversity = [...typeMap.entries()]
         .map(([type, count]) => ({ type, count }))
         .sort((a, b) => b.count - a.count);

      const summary: ResearchStateSummary = {
         query: state.query,
         depth,
         claimEdgeCount: state.claimGraph.length,
         totalSourceCount: state.sources.length,
         sourceTypeCount: typeMap.size,
         sourceDiversity,
         budgetRemaining: {
            toolCalls: state.budget.maxToolCalls - state.budget.toolCallsUsed,
            tokens: state.budget.maxTokens - state.budget.tokensUsed,
            extractions: state.budget.maxExtractions - state.budget.extractionsUsed,
            gapLoops: state.budget.maxGapLoops - state.budget.gapLoopsUsed,
            timeMs: Math.max(0, state.budget.maxTimeMs - (Date.now() - state.budget.startTime)),
         },
         subQuestions: state.subQuestions.map((sq: SubQuestion) => ({
            id: sq.id,
            text: sq.text,
            status: sq.status,
         })),
         findings: state.findings.map((f: Finding) => ({
            claim: f.claim,
            evidenceDirectness: f.evidenceDirectness,
            sourceCount: f.sourceIds.length,
            ...(f.caveats !== undefined ? { caveats: f.caveats } : {}),
         })),
         sources: state.sources.map((s: SourceEntry, i: number) => ({
            index: i + 1,
            title: s.title,
            url: s.url,
            sourceType: s.sourceType,
         })),
         contradictions: state.contradictions.map((c: Contradiction) => ({
            claimA: c.claimA,
            claimB: c.claimB,
            resolutionStatus: c.resolutionStatus,
         })),
         gaps: state.gaps.map((g: GapRecord) => ({
            description: g.description,
            status: g.status,
            priority: g.priority,
         })),
         openQuestions: state.openQuestions,
      };

      // P3: Conversation knowledge pairs — findings as assistant messages
      if (state.findings.length > 0) {
         summary.conversationKnowledge = [];
         for (const f of state.findings) {
            // If a sub-question string is available from the research state, use it for the user entry
            const subQuestionText = f.subQuestionIds.length > 0
               ? state.subQuestions.find((sq) => sq.id === f.subQuestionIds[0])?.text
               : undefined;
            if (subQuestionText) {
               summary.conversationKnowledge.push({
                  role: 'user',
                  content: `Research sub-question: ${subQuestionText}`,
               });
            }
            summary.conversationKnowledge.push({
               role: 'assistant',
               content: `Finding: ${f.claim}`,
            });
            summary.conversationKnowledge.push({
               role: 'assistant',
               content: `Evidence from ${String(f.sourceIds.length)} source(s): ${f.evidenceExcerpt ?? f.evidenceSummary}`,
            });
         }
      }

      return JSON.stringify(summary);
   }

   /**
    * Infer depth tier from source count.
    */
   private inferDepth(sourceCount: number): ResearchDepth {
      if (sourceCount <= 10) return 'quick';
      if (sourceCount <= 25) return 'standard';
      if (sourceCount <= 60) return 'deep';
      return 'exhaustive';
   }

   /**
    * Fallback to the rule-based ResearchSynthesizer.
    */
   private fallback(state: ResearchState): ResearchReport {
      return new ResearchSynthesizer(state).synthesize();
   }
}
