/**
 * Zod schemas for LLM response validation.
 *
 * Each schema corresponds to a prompt's expected JSON output structure.
 * These schemas are used to validate LLM responses before parsing, preventing
 * runtime errors from malformed JSON and providing structured error messages.
 */

import { z } from 'zod/v4';

// ── Common enums ─────────────────────────────────────────────────────────────

const evidenceDirectnessEnum = z.enum([
  'direct',
  'near-direct',
  'secondary',
  'anecdotal',
  'speculative',
]);
const claimTypeEnum = z.enum(['primary', 'secondary', 'anecdotal']);
const sourceTypeEnum = z.enum([
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
  'browser-interactive',
]);
const contradictionTypeEnum = z.enum([
  'factual_disagreement',
  'benchmark_disagreement',
  'terminology_mismatch',
  'time_version_mismatch',
  'scope_mismatch',
  'implementation_specific',
  'opinion_tradeoff',
  'vendor_vs_independent',
  'academic_vs_practitioner',
]);
const contradictionStatusEnum = z.enum([
  'unresolved',
  'partially_resolved',
  'resolved',
  'apparent_only',
]);

// ── Orchestrator: Evaluate ────────────────────────────────────────────────────

export const EvaluateResultSchema = z.object({
  evaluation: z.string().min(50).describe('2-3 paragraph overall assessment'),
  strengths: z.array(z.string()).min(1).describe('Specific aspects done well'),
  weaknesses: z.array(z.string()).min(1).describe('Specific deficiencies or gaps'),
  missingDimensions: z
    .array(z.string())
    .min(0)
    .describe('Dimensions, sub-questions, or perspectives not adequately explored'),
});

export type EvaluateResult = z.infer<typeof EvaluateResultSchema>;

// ── Orchestrator: Decide ───────────────────────────────────────────────────────

export const DecideResultSchema = z.object({
  action: z
    .enum([
      'decompose',
      'discover',
      'extract',
      'fill_gaps',
      'contradiction_scan',
      'audit',
      'synthesize',
      'complete',
    ])
    .describe('Single next action'),
  reasoning: z.string().min(50).describe('Explanation of why this action is optimal'),
  priority: z.number().min(1).max(5).describe('Priority level (1-5)'),
  subQuestionIds: z
    .array(z.string())
    .optional()
    .describe('Sub-question IDs this action should focus on'),
});

export type DecideResult = z.infer<typeof DecideResultSchema>;

// ── Worker: Extract ─────────────────────────────────────────────────────────────

export const ExtractResultSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z
          .string()
          .min(10)
          .describe('Verbatim or near-verbatim claim as stated in the source text'),
        evidenceExcerpt: z
          .string()
          .min(10)
          .describe('Direct quote (1-3 sentences) supporting the claim'),
        evidenceDirectness: evidenceDirectnessEnum.describe('Evidence directness level'),
        claimType: claimTypeEnum.describe('Claim type'),
      }),
    )
    .min(0)
    .describe('Extracted findings'),
});

export type ExtractResult = z.infer<typeof ExtractResultSchema>;

// ── Worker: Classify ────────────────────────────────────────────────────────────

export const ClassifyResultSchema = z.object({
  relevance: z.number().min(0).max(1).describe('Relevance score (0-1)'),
  quality: z.number().min(0).max(1).describe('Quality score (0-1)'),
  freshness: z.string().describe('ISO date string or "Unknown"'),
  sourceType: sourceTypeEnum.describe('Most specific applicable type'),
  reasonForInclusion: z.string().min(20).describe('1-2 sentence justification'),
});

export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;

// ── Orchestrator: Audit ────────────────────────────────────────────────────────

export const AuditResultSchema = z.object({
  passed: z.boolean().describe('Whether all checks passed'),
  issues: z
    .array(
      z.object({
        type: z
          .enum([
            'unsourced_claim',
            'hidden_contradiction',
            'low_diversity',
            'taxonomy_drift',
            'circular_evidence',
            'stale_finding',
            'missing_source_type',
          ])
          .describe('Issue category'),
        severity: z.enum(['error', 'warning', 'info']).describe('Issue severity'),
        description: z
          .string()
          .min(20)
          .describe('Detailed, specific description with IDs and quotes'),
        findingId: z.string().optional().describe('Optional finding ID if applicable'),
        sourceId: z.string().optional().describe('Optional source ID if applicable'),
      }),
    )
    .min(0)
    .describe('List of issues found'),
  stats: z
    .object({
      totalClaims: z.number().min(0).describe('Total number of claims'),
      unsourcedClaims: z.number().min(0).describe('Number of unsourced claims'),
      unresolvedContradictions: z.number().min(0).describe('Number of unresolved contradictions'),
      mergedDuplicates: z.number().min(0).describe('Number of merged duplicates'),
      sourceDiversity: z
        .array(
          z.object({
            type: sourceTypeEnum,
            count: z.number().min(0),
          }),
        )
        .describe('Per-type source breakdown'),
      taxonomyDrift: z.boolean().describe('Whether taxonomy has drifted'),
    })
    .describe('Audit statistics'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
});

export type AuditResult = z.infer<typeof AuditResultSchema>;

// ── Tree: Generate Queries ───────────────────────────────────────────────────────

export const TreeGenerateQueriesResultSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(5).describe('Search query string'),
        researchGoal: z.string().min(10).describe('What this query aims to discover'),
      }),
    )
    .min(1)
    .describe('Generated search queries'),
});

export type TreeGenerateQueriesResult = z.infer<typeof TreeGenerateQueriesResultSchema>;

// ── Tree: Process Results ────────────────────────────────────────────────────────

export const TreeProcessResultsResultSchema = z.object({
  learnings: z
    .array(
      z.object({
        text: z.string().min(10).describe('The key insight or finding'),
        sourceUrl: z.string().optional().describe('URL of the source if available'),
      }),
    )
    .min(0)
    .describe('Extracted learnings'),
  followUpQuestions: z.array(z.string()).min(0).describe('Follow-up questions that explore deeper'),
});

export type TreeProcessResultsResult = z.infer<typeof TreeProcessResultsResultSchema>;

// ── Worker: Failure Analysis ────────────────────────────────────────────────────────

export const FailureAnalysisSchema = z.object({
  recap: z.string().min(10).max(200).describe('1-2 sentence recap of what went wrong'),
  blame: z.string().min(10).describe('The specific cause of failure'),
  improvement: z.string().min(10).describe('The specific next action to fix it'),
});

export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;

// ── Worker Agent: Investigate ───────────────────────────────────────────────────────

export const WorkerAgentInvestigateSchema = z.object({
  queries: z.array(z.string()).min(1).describe('Optimized search queries'),
  sourceTypes: z.array(sourceTypeEnum).min(3).describe('Source types to search (at least 3)'),
  reasoning: z.string().min(20).describe('Brief explanation of the search strategy'),
});

export type WorkerAgentInvestigateResult = z.infer<typeof WorkerAgentInvestigateSchema>;

// ── Orchestrator: Synthesis (V4.0.0) ────────────────────────────────────────────

export const ResearchReportSchema = z.object({
  query: z.string().describe('The original research question'),
  classification: z
    .enum([
      'explainer',
      'comparative',
      'technical',
      'applied-practitioner',
      'current-events',
      'historical-timeline',
      'market-ecosystem',
      'literature-review',
      'decision-support',
    ])
    .describe('Query classification'),
  depth: z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']).describe('Research depth'),
  executiveSummary: z
    .string()
    .min(100)
    .describe('2-4 paragraphs of flowing prose with inline [N] citations'),
  themes: z
    .array(
      z.object({
        title: z.string().min(5).describe('Theme name'),
        narrative: z
          .string()
          .min(100)
          .describe('2-4 paragraphs of flowing prose with inline citation markers'),
      }),
    )
    .min(1)
    .describe('Thematic analysis themes'),
  contradictions: z
    .array(
      z.object({
        id: z.string().describe('Contradiction id from the state'),
        claimA: z.string().min(10).describe('First claim'),
        claimB: z.string().min(10).describe('Second claim'),
        contradictionType: contradictionTypeEnum.describe('Contradiction type'),
        resolutionStatus: contradictionStatusEnum.describe('Resolution status'),
        likelyExplanation: z
          .string()
          .optional()
          .describe('Explanation if resolved or apparent only'),
      }),
    )
    .min(0)
    .describe('Contradictions and debates'),
  uncertainties: z.array(z.string()).min(0).describe('Specific uncertainties'),
  sourceNotes: z.array(z.string()).min(0).describe('Notes about source quality or diversity'),
  openQuestions: z.array(z.string()).min(0).describe('Legitimate unanswered questions'),
  recommendations: z.string().optional().describe('Optional actionable recommendations'),
  limitations: z.array(z.string()).min(0).describe('Specific limitations of this research'),
  sourceCount: z.number().min(0).describe('Total number of individual sources'),
  findingCount: z.number().min(0).describe('Total number of findings'),
});

export type ResearchReport = z.infer<typeof ResearchReportSchema>;

// ── Orchestrator: Synthesis (V5.0.0 — narrative variant) ────────────────────────────

export const ResearchReportV2Schema = z.object({
  query: z.string().describe('The original research query'),
  executiveSummary: z
    .string()
    .min(100)
    .describe('2-4 paragraphs of flowing prose with [Source N] citations'),
  keyFindings: z
    .array(
      z.object({
        theme: z.string().min(5).describe('Analytical theme name'),
        narrative: z.string().min(100).describe('2-4 paragraphs of flowing prose with citations'),
        evidenceQuality: z
          .object({
            strong: z.boolean().optional().describe('Whether evidence is strong'),
            thinEvidence: z.array(z.string()).optional().describe('Claims with thin evidence'),
          })
          .optional()
          .describe('Evidence quality assessment'),
        citations: z.array(z.string()).min(0).describe('Inline [Source N] citation markers used'),
      }),
    )
    .min(1)
    .describe('Key findings grouped by theme'),
  contradictionsDebates: z
    .array(
      z.object({
        id: z.string().describe('Contradiction id'),
        claimA: z.string().min(10).describe('First claim'),
        claimB: z.string().min(10).describe('Second claim'),
        resolutionStatus: contradictionStatusEnum.describe('Resolution status'),
        explanation: z.string().optional().describe('What this means for the overall answer'),
      }),
    )
    .min(0)
    .describe('Contradictions and debates'),
  sourceQualityAssessment: z
    .object({
      diversity: z
        .object({
          types: z.array(sourceTypeEnum).describe('Source types found'),
          domainCount: z.number().min(0).describe('Number of distinct domains'),
        })
        .describe('Source diversity'),
      contentDepth: z.string().describe('Content depth assessment'),
      promotionalContentDetected: z
        .boolean()
        .optional()
        .describe('Whether promotional content was detected'),
      qualityConcerns: z.array(z.string()).optional().describe('Systematic quality concerns'),
    })
    .describe('Source quality assessment'),
  uncertaintiesLimitations: z
    .array(
      z.object({
        type: z.enum(['uncertainty', 'limitation']).describe('Category'),
        description: z.string().min(10).describe('What is not known or limitations'),
      }),
    )
    .min(0)
    .describe('Uncertainties and limitations'),
  openQuestions: z.array(z.string()).min(0).describe('Legitimate questions remaining'),
  recommendations: z
    .string()
    .optional()
    .describe('Actionable recommendations if decision-oriented'),
  metadata: z
    .object({
      totalSourceCount: z.number().min(0).describe('Total individual sources'),
      sourceTypeCount: z.number().min(0).describe('Distinct source types'),
      findingCount: z.number().min(0).describe('Total findings'),
      timestamp: z.string().describe('ISO timestamp'),
    })
    .describe('Report metadata'),
});

export type ResearchReportV2 = z.infer<typeof ResearchReportV2Schema>;

// ── Worker: Summarize Single Page ─────────────────────────────────────────────────

export const SummarizeSinglePageSchema = z.object({
  url: z.url().describe('Source URL'),
  title: z.string().min(1).describe('Source title'),
  sourceType: sourceTypeEnum.describe('Source type'),
  domain: z.string().min(1).describe('Domain name'),
  summary: z.string().min(20).describe('2-3 sentence summary'),
  keyExcerpts: z.array(z.string()).min(1).describe('3-5 verbatim excerpts'),
  qualityScore: z.number().min(0).max(1).optional().describe('Quality assessment (0-1)'),
});

export type SummarizeSinglePageResult = z.infer<typeof SummarizeSinglePageSchema>;

// ── Worker Agent: Think/Reflect ─────────────────────────────────────────────────────

export const ThinkReflectSchema = z.object({
  shouldContinue: z.boolean().describe('Whether to continue the investigation'),
  reflection: z.string().min(10).describe('Brief reflection on progress and next steps'),
});

export type ThinkReflectResult = z.infer<typeof ThinkReflectSchema>;
