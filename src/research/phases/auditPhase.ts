/**
 * AuditPhase — Phase 6 of the research pipeline.
 *
 * Runs state audit (rule-based + LLM merge) and contradiction detection.
 * Extracted from PipelineStrategy.analyze() lines 590-636.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { StateAuditor } from '../audit.js';
import { ORCHESTRATOR_AUDIT } from '../llm/prompts.js';
import type { AuditReport } from '../types.js';
import { logger } from '../../logger.js';

export class AuditPhase extends BasePhase {
  readonly name = 'audit';
  readonly requiresLlm = false;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    logger.info('Phase 6: State audit');
    await this.reportProgress(ctx, 65, 'Auditing research quality', 'audit');

    const auditor = new StateAuditor(ctx.state);
    const ruleAudit = auditor.audit();
    let mergedAuditReport = ruleAudit;

    if (ctx.llm && !ctx.deterministic) {
      try {
        const llmAudit = await this.auditState(ctx);
        if (llmAudit) {
          const normalizeDesc = (d: string) =>
            d
              .toLowerCase()
              .trim()
              .replace(/[^\w\s]/g, '');
          const existingDescs = new Set(llmAudit.issues.map((i) => normalizeDesc(i.description)));
          const newIssues = ruleAudit.issues.filter(
            (i) => !existingDescs.has(normalizeDesc(i.description)),
          );
          mergedAuditReport = {
            ...llmAudit,
            passed: llmAudit.passed && ruleAudit.passed,
            issues: [...llmAudit.issues, ...newIssues],
          };
        }
      } catch (auditErr) {
        logger.warn({ err: auditErr }, 'LLM audit failed; using rule-based audit only');
      }
    }

    ctx.state.markAudited();
    logger.info(
      { passed: mergedAuditReport.passed, issues: mergedAuditReport.issues.length },
      'Audit complete',
    );
    await this.reportProgress(ctx, 90, 'Audit complete', 'audit');

    const contradictions = ctx.state.detectContradictions();
    if (contradictions.length > 0) {
      logger.info({ contradictions: contradictions.length }, 'Contradictions detected');
    }
  }

  private async auditState(ctx: StrategyContext): Promise<AuditReport | undefined> {
    if (!ctx.llm) return undefined;
    const summary = this.buildStateSummary(ctx);
    type LlmAuditResponse = Record<string, unknown>;
    const result = await ctx.llm.callJSONWithFallback<LlmAuditResponse>({
      messages: [
        { role: 'system' as const, content: ORCHESTRATOR_AUDIT },
        { role: 'user' as const, content: `Research state to audit:\n${summary}` },
      ],
      temperature: 0.3,
    });
    if (!result.success) return undefined;
    const data = result.data;
    if (typeof data.passed !== 'boolean' || !Array.isArray(data.issues)) {
      logger.warn({ data }, 'LLM returned invalid AuditReport — missing required fields');
      return undefined;
    }
    return data as unknown as AuditReport;
  }

  private buildStateSummary(ctx: StrategyContext): string {
    const state = ctx.state.getState();
    const summary = {
      query: state.query,
      phase: state.currentPhase,
      subQuestions: state.subQuestions.map((sq) => ({
        id: sq.id,
        text: sq.text,
        status: sq.status,
      })),
      sources: state.sources.map((s) => ({
        title: s.title,
        url: s.url,
        sourceType: s.sourceType,
        extractionStatus: s.extractionStatus,
      })),
      findings: state.findings.map((f) => ({
        claim: f.claim,
        evidenceDirectness: f.evidenceDirectness,
        sourceCount: f.sourceIds.length,
      })),
      contradictions: state.contradictions.map((c) => ({
        claimA: c.claimA,
        claimB: c.claimB,
        resolutionStatus: c.resolutionStatus,
      })),
      gaps: state.gaps.map((g) => ({
        description: g.description,
        status: g.status,
        priority: g.priority,
      })),
      openQuestions: state.openQuestions,
      claimEdgeCount: state.claimGraph.length,
      budgetRemaining: {
        toolCalls: state.budget.maxToolCalls - state.budget.toolCallsUsed,
        tokens: state.budget.maxTokens - state.budget.tokensUsed,
        extractions: state.budget.maxExtractions - state.budget.extractionsUsed,
        gapLoops: state.budget.maxGapLoops - state.budget.gapLoopsUsed,
        timeMs: Math.max(0, state.budget.maxTimeMs - (Date.now() - state.budget.startTime)),
      },
    };
    return JSON.stringify(summary);
  }
}
