/**
 * V4.0.0 Deep Research — LLM-based synthesis subagent.
 *
 * Calls the orchestrator LLM to generate a narrative ResearchReport from the
 * full research state, with fallback to the rule-based ResearchSynthesizer.
 */

import { DeepResearchLlmClient } from './chat.js';
import { ORCHESTRATOR_SYNTHESIS } from './prompts.js';
import { logger } from '../../logger.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import type {
  ResearchState,
  ResearchReport,
  ResearchDepth,
  ConfidenceLabel,
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
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  evidenceDirectness: string;
  sourceCount: number;
  corroborationCount: number;
  contradictsCount: number;
  caveats?: string;
}

interface SummarySource {
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
  confidenceDistribution: Record<string, number>;
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
    if (!Array.isArray(theme.findings)) return false;
    for (const f of theme.findings) {
      if (typeof f !== 'string') return false;
    }
    if (typeof theme.confidence !== 'string') return false;
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

  if (r.confidenceDistribution === null || typeof r.confidenceDistribution !== 'object')
    return false;

  return true;
}

// ── LlmSynthesizer ───────────────────────────────────────────────────────────

export class LlmSynthesizer {
  constructor(private readonly llm: DeepResearchLlmClient) {}

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
        { role: 'system' as const, content: ORCHESTRATOR_SYNTHESIS },
        {
          role: 'user' as const,
          content: `Research state summary:\n${summary}`,
        },
      ],
      maxTokens,
    });

    if (!result.success) {
      logger.warn(
        { error: result.response.error },
        'LLM synthesis failed; falling back to rule-based synthesizer',
      );
      return this.fallback(state);
    }

    if (!isResearchReport(result.data)) {
      logger.warn(
        { data: JSON.stringify(result.data).slice(0, 200) },
        'LLM synthesis returned invalid report shape; falling back to rule-based synthesizer',
      );
      return this.fallback(state);
    }

    return result.data;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Build a compact JSON summary of the research state.
   *
   * Excludes full text content (evidenceExcerpts, full source bodies) to stay
   * under ~8000 characters for the LLM context window.
   */
  private buildStateSummary(state: ResearchState): string {
    const confidenceDist = this.computeConfidenceDistribution(state.findings);

    const depth = this.inferDepth(state.sources.length);

    const summary: ResearchStateSummary = {
      query: state.query,
      depth,
      claimEdgeCount: state.claimGraph.length,
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
        confidence: f.confidence,
        confidenceLabel: f.confidenceLabel,
        evidenceDirectness: f.evidenceDirectness,
        sourceCount: f.sourceIds.length,
        corroborationCount: f.corroboratingSourceIds.length,
        contradictsCount: f.contradictingSourceIds.length,
        ...(f.caveats !== undefined ? { caveats: f.caveats } : {}),
      })),
      sources: state.sources.map((s: SourceEntry) => ({
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
      confidenceDistribution: confidenceDist,
    };

    return JSON.stringify(summary);
  }

  /**
   * Compute confidence-label distribution from findings.
   */
  private computeConfidenceDistribution(findings: Finding[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const f of findings) {
      dist[f.confidenceLabel] = (dist[f.confidenceLabel] ?? 0) + 1;
    }
    return dist;
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
