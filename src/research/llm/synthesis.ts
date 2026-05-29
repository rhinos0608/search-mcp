/**
 * V4.0.0 Deep Research — LLM-based synthesis subagent.
 *
 * Calls the orchestrator LLM to generate a narrative ResearchReport from the
 * full research state, with fallback to the rule-based ResearchSynthesizer.
 */

import { DeepResearchLlmClient } from './chat.js';
import { CLUSTERED_REVISION, ORCHESTRATOR_SYNTHESIS_V2 } from './prompts.js';
import { logger } from '../../logger.js';
import { embedTexts } from '../../rag/embedding.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import { extractSourceBlock, isExplicitNone } from '../../utils/citationExtractor.js';
import {
  applyReportValidation,
  enrichFindingsWithSemanticEvidenceAlignment,
  groundSynthesisClaims,
} from '../provenance.js';
import { buildFindingLinkageWithEmbeddings, clusterIdByFindingId } from '../findingLinkage.js';
import { applyClusterMerge, applyClusterSplit, applyClusterKeep, validateClusterDecisions } from '../clusterRevision.js';
import type {
  ResearchState,
  ResearchReport,
  ResearchDepth,
  SubQuestion,
  Finding,
  SourceEntry,
  Contradiction,
  GapRecord,
  ReportAuditResult,
  ClusterRevisionDecision,
  FindingCluster,
  FindingClusterEdge,
  GroundingResult,
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
  sourceIds: string[];
  clusterId?: string;
  evidenceAlignment?: Finding['evidenceAlignment'];
  caveats?: string;
}

interface SummarySource {
  index: number;
  title: string;
  url: string;
  sourceType: string;
  authorityClass?: string;
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
  findingClusters?: FindingCluster[];
  sources: SummarySource[];
  contradictions: SummaryContradiction[];
  gaps: SummaryGap[];
  openQuestions: string[];
  conversationKnowledge?: { role: string; content: string }[];
  diary?: string[];
}

// ── Internal types ───────────────────────────────────────────────────────────

interface InternalSynthesisData extends Partial<ResearchReport> {
  findings?: Finding[];
}

// ── LlmSynthesizer ───────────────────────────────────────────────────────────

export class LlmSynthesizer {
  constructor(private readonly llm: DeepResearchLlmClient) {}

  private async prepareFindingContext(
    findings: Finding[],
  ): Promise<{ findings: Finding[]; clusters: FindingCluster[]; edges: FindingClusterEdge[] }> {
    const semanticallyAligned = await enrichFindingsWithSemanticEvidenceAlignment(findings);
    const linkage = await buildFindingLinkageWithEmbeddings(semanticallyAligned);

    // Revise LLM-flagged clusters before final assignment
    const needsLlmReview = linkage.clusters.some(c => c.mergeStatus === 'needs_llm_review');
    let finalClusters = linkage.clusters;
    if (needsLlmReview) {
      try {
        const revision = await this.reviseClustersWithLLM(linkage.clusters, linkage.edges);
        finalClusters = revision.clusters;
      } catch (err) {
        logger.warn({ err }, 'Clustered LLM revision failed; using unrevised clusters');
      }
    }

    const clusterByFinding = clusterIdByFindingId(finalClusters);
    const clusteredFindings = semanticallyAligned.map((finding) => {
      const clusterId = clusterByFinding.get(finding.id);
      return clusterId ? { ...finding, clusterId } : finding;
    });
    return { findings: clusteredFindings, clusters: finalClusters, edges: linkage.edges };
  }

  /**
   * Revise clusters flagged for LLM review using the orchestrator model.
   *
   * Filters clusters with mergeStatus === 'needs_llm_review', batches them
   * in groups of 12, calls the LLM for merge/split/keep/abstain decisions,
   * and applies the decisions to the cluster list.
   */
  private async reviseClustersWithLLM(
    clusters: FindingCluster[],
    edges: FindingClusterEdge[],
  ): Promise<{ clusters: FindingCluster[]; decisions: ClusterRevisionDecision[] }> {
    const needsReview = clusters.filter(c => c.mergeStatus === 'needs_llm_review');
    if (needsReview.length === 0) return { clusters, decisions: [] };

    // Sort by confidence descending for most-confident-first batching
    needsReview.sort((a, b) => b.confidence - a.confidence);

    const allDecisions: ClusterRevisionDecision[] = [];

    // Batch in groups of 12 clusters per LLM call
    for (let i = 0; i < needsReview.length; i += 12) {
      const batch = needsReview.slice(i, i + 12);

      // Build the prompt payload for this batch
      // Cross-cluster edges: edges whose endpoints span different clusters within the batch
      const crossClusterEdges = edges.filter(e => {
        const leftCluster = batch.find(c => c.findingIds.includes(e.leftFindingId));
        const rightCluster = batch.find(c => c.findingIds.includes(e.rightFindingId));
        if (!leftCluster || !rightCluster) return false;
        return leftCluster.id !== rightCluster.id;
      });

      const clusterDetails = batch.map(cluster => ({
        clusterId: cluster.id,
        representativeClaim: cluster.representativeClaim,
        mergeStatus: cluster.mergeStatus,
        findingCount: cluster.findingIds.length,
        confidence: cluster.confidence,
        findings: cluster.findingIds.map(fid => ({
          findingId: fid,
          edgeCount: cluster.edges.filter(
            e => e.leftFindingId === fid || e.rightFindingId === fid,
          ).length,
        })),
      }));

      const crossClusterEdgeInfo = crossClusterEdges.map(e => ({
        left: e.leftFindingId,
        right: e.rightFindingId,
        score: e.score,
        relation: e.relation,
        rationale: e.rationale,
      }));

      const payload = {
        clusters: clusterDetails,
        crossClusterEdges: crossClusterEdgeInfo,
      };

      const result = await this.llm.callJSONWithFallback<{ decisions: ClusterRevisionDecision[] }>({
        messages: [
          { role: 'system' as const, content: CLUSTERED_REVISION },
          { role: 'user' as const, content: JSON.stringify(payload) },
        ],
        maxTokens: 4_000,
        timeoutMs: 120_000,
      });

      if (!result.success) {
        logger.warn(
          { error: result.response.error ?? result.parseError },
          'Clustered LLM revision batch failed; skipping batch',
        );
        continue;
      }

      allDecisions.push(...result.data.decisions);
    }

    // Validate and apply all decisions to a mutable copy of the cluster list
    const validatedDecisions = validateClusterDecisions(allDecisions);
    let finalClusters = [...clusters];
    for (const decision of validatedDecisions) {
      switch (decision.action) {
        case 'merge':
          finalClusters = applyClusterMerge(finalClusters, decision);
          break;
        case 'split':
          finalClusters = applyClusterSplit(finalClusters, decision);
          break;
        case 'keep':
          finalClusters = applyClusterKeep(finalClusters, decision);
          break;
        case 'abstain':
          // abstain: leave cluster unchanged, mergeStatus stays 'needs_llm_review'
          break;
        default:
          break;
      }
    }

    return { clusters: finalClusters, decisions: allDecisions };
  }

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
    const findingContext = await this.prepareFindingContext(state.findings);
    const preparedState: ResearchState = { ...state, findings: findingContext.findings };
    const summary = this.buildStateSummary(preparedState, findingContext.clusters);
    const maxTokens = options?.maxTokens ?? DEFAULT_SYNTHESIS_MAX_TOKENS;

    const result = await this.llm.callJSON<InternalSynthesisData>({
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
      // Attempt to salvage substantive but non-JSON response for synthesis
      if (result.response.content && result.response.content.length > 500) {
        logger.info(
          'LLM synthesis returned non-JSON content but it is substantive; parsing as raw narrative.',
        );
        const data: InternalSynthesisData = {
          query: state.query,
          executiveSummary:
            'Raw analysis provided below. Structure not recognized but content preserved.',
          narrativeMarkdown: result.response.content,
          findings: [],
          themes: [],
          uncertainties: ['Note: Synthesis was not structured as JSON; preserved as raw text.'],
        };
        return this.enrichReport(
          data,
          preparedState,
          findingContext.findings,
          findingContext.clusters,
          findingContext.edges,
        );
      }

      logger.error(
        { error: result.response.error ?? result.parseError },
        'LLM synthesis failed after retry; falling back to rule-based synthesizer',
      );
      return this.fallback(preparedState);
    }

    // Normalize and guide the data into the correct shape
    // We don't enforce a schema, we ensure the data is usable.
    const data: InternalSynthesisData = result.data;

    // Ensure critical collections exist so the UI/downstream doesn't crash
    data.findings ??= [];
    data.themes ??= [];
    data.uncertainties ??= [];

    if (!data.executiveSummary) {
      data.executiveSummary = 'Research complete. See sections for findings.';
    }

    // Ensure narrativeMarkdown is populated — if LLM returned empty, build from themes
    if (!data.narrativeMarkdown || data.narrativeMarkdown.trim().length === 0) {
      data.narrativeMarkdown = this.buildNarrativeFromThemes(data as ResearchReport);
    }

    return this.enrichReport(
      data,
      preparedState,
      findingContext.findings,
      findingContext.clusters,
      findingContext.edges,
    );
  }

  /**
   * Internal helper to enrich a report with citations and degradation info.
   */
  private async enrichReport(
    data: InternalSynthesisData,
    state: ResearchState,
    validationFindings: Finding[],
    findingClusters: FindingCluster[],
    findingClusterEdges: FindingClusterEdge[],
  ): Promise<ResearchReport> {
    // Validate citations in narrativeMarkdown: check [Source N] refs are in range
    const citationIssues = this.validateCitations(data as ResearchReport, state.sources.length);
    if (citationIssues.length > 0) {
      data.uncertainties = [...(data.uncertainties ?? []), ...citationIssues];
    }

    // ── Enrich with degradation mode and curated evidence sources ──
    data.degradationMode = (data.findings?.length ?? 0) === 0 ? 'source_note_synthesis' : 'deep';

    try {
      // Add curated evidence sources (tier-based, primary-preferring)
      const { curateEvidenceSources } = await import('../sourceQuality.js');
      const curated = curateEvidenceSources(state.sources, state.findings);
      data.evidenceSources = curated.map((c, i) => ({
        index: i + 1,
        title: c.source.title,
        url: c.source.url,
        sourceType: c.source.sourceType,
        ...(c.source.authorityClass ? { authorityClass: c.source.authorityClass } : {}),
        tier: c.tier,
        domain: c.source.domain,
      }));
    } catch (e) {
      logger.warn({ err: e }, 'Failed to enrich evidence sources; skipping enrichment');
    }

    data.findingClusters = findingClusters;
    data.findingClusterEdges = findingClusterEdges;
    const validated = applyReportValidation(
      data as ResearchReport,
      state.sources,
      validationFindings,
    );

    // ── Extract citations from SOURCES blocks in the LLM-generated narrative ──
    validated.extractedCitations = extractSourceBlock(validated.narrativeMarkdown);
    validated.noSourcesExplicit = isExplicitNone(validated.narrativeMarkdown);

    // ── Ground synthesis claims against source evidence ──
    try {
      // Build per-source chunks from finding evidence text
      const sourceTextMap = new Map<string, string[]>();
      for (const finding of validationFindings) {
        for (const sourceId of finding.sourceIds) {
          const existing = sourceTextMap.get(sourceId) ?? [];
          existing.push(finding.evidenceSummary);
          if (finding.evidenceExcerpt) existing.push(finding.evidenceExcerpt);
          sourceTextMap.set(sourceId, existing);
        }
      }

      if (sourceTextMap.size > 0) {
        const sourceEntries = [...sourceTextMap.entries()];
        const texts = sourceEntries.map(([, excerpts]) => excerpts.join('\n'));
        const response = await embedTexts({
          texts,
          mode: 'document',
          dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
        });

        const sourceChunks: { id: string; text: string; embedding: number[] }[] = sourceEntries.map(
          ([id], index) => ({
            id,
            text: texts[index] ?? '',
            embedding: response.embeddings[index] ?? [],
          }),
        );

        const groundingResult: GroundingResult = await groundSynthesisClaims(
          validated.narrativeMarkdown,
          sourceChunks,
        );

        // Append grounding warnings as uncertainties
        if (groundingResult.warnings.length > 0) {
          validated.uncertainties = [...validated.uncertainties, ...groundingResult.warnings];
        }

        // If more than 30% of claims are ungrounded, add a high-severity warning
        if (
          groundingResult.ungroundedCount > 0 &&
          groundingResult.ungroundedCount / groundingResult.claims.length > 0.3
        ) {
          validated.uncertainties = [
            ...validated.uncertainties,
            `High ungrounded claim rate (${String(groundingResult.ungroundedCount)}/${String(groundingResult.claims.length)}). The synthesis narrative should be reviewed for unsupported assertions.`,
          ];
        }
      }
    } catch (err) {
      logger.warn(
        { err },
        'Synthesis claim grounding failed; report returned without grounding validation',
      );
    }

    return await this.reviseIfAuditFailed(validated, state, validationFindings);
  }

  private async reviseIfAuditFailed(
    report: ResearchReport,
    state: ResearchState,
    validationFindings: Finding[],
  ): Promise<ResearchReport> {
    const audit = report.reportAudit;
    if (!audit || audit.pass || audit.requiredRevisions.length === 0) return report;

    const highSeverityIssues = audit.issues.filter(
      (issue) => issue.severity === 'critical' || issue.severity === 'high',
    );
    if (highSeverityIssues.length === 0) return report;

    const revision = await this.requestAuditRevision(report, audit, state);
    if (!revision) return report;

    if (report.findingClusters) revision.findingClusters = report.findingClusters;
    if (report.findingClusterEdges) revision.findingClusterEdges = report.findingClusterEdges;
    const revised = applyReportValidation(revision, state.sources, validationFindings);
    const previousSeverity = this.auditSeverityScore(report.reportAudit);
    const revisedSeverity = this.auditSeverityScore(revised.reportAudit);
    if (revisedSeverity <= previousSeverity) {
      if (!revised.reportAudit?.pass) {
        revised.uncertainties = [
          ...revised.uncertainties,
          'Audit-guided synthesis revision ran, but unresolved provenance issues remain. See reportAudit for required revisions.',
        ];
      }
      return revised;
    }

    return {
      ...report,
      uncertainties: [
        ...report.uncertainties,
        'Audit-guided synthesis revision was attempted but rejected because it worsened provenance audit severity.',
      ],
    };
  }

  private async requestAuditRevision(
    report: ResearchReport,
    audit: ReportAuditResult,
    state: ResearchState,
  ): Promise<ResearchReport | null> {
    const revisionPayload = {
      instructions:
        'Revise the report to satisfy required provenance revisions. Do not add new factual claims. Preserve only claims grounded in the provided findings and cited sources. Return the complete ResearchReport JSON shape.',
      requiredRevisions: audit.requiredRevisions,
      issues: audit.issues
        .filter((issue) => issue.severity === 'critical' || issue.severity === 'high')
        .slice(0, 20),
      sourceRegistry: report.sourceRegistry,
      claimLedger: report.claimLedger,
      currentReport: {
        query: report.query,
        classification: report.classification,
        depth: report.depth,
        degradationMode: report.degradationMode,
        executiveSummary: report.executiveSummary,
        narrativeMarkdown: report.narrativeMarkdown,
        themes: report.themes,
        contradictions: report.contradictions,
        uncertainties: report.uncertainties,
        sourceNotes: report.sourceNotes,
        openQuestions: report.openQuestions,
        recommendations: report.recommendations,
        limitations: report.limitations,
        sourceCount: report.sourceCount,
        findingCount: report.findingCount,
        sourceTypeCount: report.sourceTypeCount,
        sourceDiversity: report.sourceDiversity,
        evidenceSources: report.evidenceSources,
        findingClusters: report.findingClusters,
      },
      stateSummary: JSON.parse(
        this.buildStateSummary(state, report.findingClusters ?? []),
      ) as ResearchStateSummary,
    };

    const result = await this.llm.callJSON<InternalSynthesisData>({
      model: 'orchestrator',
      messages: [
        { role: 'system' as const, content: ORCHESTRATOR_SYNTHESIS_V2 },
        {
          role: 'user' as const,
          content: `Revise this synthesis after provenance audit failure:\n${JSON.stringify(revisionPayload)}`,
        },
      ],
      maxTokens: DEFAULT_SYNTHESIS_MAX_TOKENS,
      timeoutMs: 180_000,
    });

    if (!result.success) {
      logger.warn(
        { error: result.response.error ?? result.parseError },
        'Audit-guided LLM synthesis revision failed; retaining validated/sanitized report',
      );
      return null;
    }

    const data = result.data;
    data.findings ??= [];
    data.themes ??= [];
    data.uncertainties ??= [];
    data.executiveSummary ??= report.executiveSummary;
    data.narrativeMarkdown ??= report.narrativeMarkdown;
    data.contradictions ??= report.contradictions;
    data.sourceNotes ??= report.sourceNotes;
    data.openQuestions ??= report.openQuestions;
    data.limitations ??= report.limitations;
    data.evidenceSources ??= report.evidenceSources;

    return {
      ...report,
      ...data,
      query: report.query,
      classification: report.classification,
      depth: report.depth,
      sourceCount: report.sourceCount,
      findingCount: report.findingCount,
      sourceTypeCount: report.sourceTypeCount,
      sourceDiversity: report.sourceDiversity,
      evidenceSources: data.evidenceSources,
    };
  }

  private auditSeverityScore(audit: ReportAuditResult | undefined): number {
    if (!audit) return 0;
    const issueScore = audit.issues.reduce((sum, issue) => {
      switch (issue.severity) {
        case 'critical':
          return sum + 100;
        case 'high':
          return sum + 25;
        case 'medium':
          return sum + 5;
        case 'low':
          return sum + 1;
        default:
          logger.warn({ severity: issue.severity }, 'Unexpected audit severity');
          return sum + 0;
      }
    }, 0);
    return issueScore + (audit.pass ? 0 : 10);
  }

  /**
   * Validate that [Source N] references in the narrative are in range.
   * Returns citation issues as uncertainty strings.
   */
  private validateCitations(report: ResearchReport, totalSources: number): string[] {
    const issues: string[] = [];
    const narrative = report.narrativeMarkdown;

    // Extract all [Source N] references
    const refRegex = /\[Source (\d+)\]/g;
    const refs = new Set<number>();
    let match: RegExpExecArray | null;
    while ((match = refRegex.exec(narrative)) !== null) {
      const numString = match[1];
      if (numString) {
        const num = parseInt(numString, 10);
        if (num > 0) refs.add(num);
      }
    }

    if (refs.size === 0) {
      issues.push(
        'No [Source N] citations found in the synthesis narrative. Claims may not be properly attributed to sources.',
      );
      return issues;
    }

    // Check for out-of-range references
    const outOfRange = [...refs].filter((n) => n > totalSources);
    if (outOfRange.length > 0) {
      issues.push(
        `${String(outOfRange.length)} citation(s) reference non-existent sources (indices ${outOfRange.join(', ')} exceed ${String(totalSources)} total sources).`,
      );
    }

    // Check for stale (source #1) overuse — if >50% of citations are source 1
    if (refs.size <= 2 && refs.has(1) && totalSources > 3) {
      issues.push(
        'Citation diversity is low — most claims cite only Source 1. This may indicate fallback/default citation behavior rather than genuine source attribution.',
      );
    }

    return issues;
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
  private buildStateSummary(state: ResearchState, findingClusters: FindingCluster[] = []): string {
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
        sourceIds: f.sourceIds,
        ...(f.clusterId ? { clusterId: f.clusterId } : {}),
        ...(f.evidenceAlignment ? { evidenceAlignment: f.evidenceAlignment } : {}),
        ...(f.caveats !== undefined ? { caveats: f.caveats } : {}),
      })),
      ...(findingClusters.length > 0 ? { findingClusters } : {}),
      sources: state.sources.map((s: SourceEntry, i: number) => ({
        index: i + 1,
        title: s.title,
        url: s.url,
        sourceType: s.sourceType,
        ...(s.authorityClass ? { authorityClass: s.authorityClass } : {}),
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
        const subQuestionText =
          f.subQuestionIds.length > 0
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
