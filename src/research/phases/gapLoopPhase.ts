/**
 * GapLoopPhase — EDA (Evaluate-Decide-Act) loop for adaptive gap filling.
 *
 * The most complex phase: contradiction detection, gap analysis, adaptive band extension,
 * worker spawning, and compaction. Extracted from PipelineStrategy.analyze() lines 219-406.
 *
 * PRESERVES ALL BUDGET INTERACTIONS, LOOP TERMINATION CONDITIONS, AND CONTRADICTION MERGING LOGIC.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { GapAnalyzer, GapFiller } from '../gapAnalysis.js';
import { generateFromEvidencePool, mergeContradictions } from '../contradictionGenerator.js';
import { ContradictionDetector } from '../contradictionDetector.js';
import { researchJobManager } from '../jobManager.js';
import { PruningEngine } from '../pruning.js';
import { logger } from '../../logger.js';
import type { GapRecord, SubQuestion } from '../types.js';

export class GapLoopPhase extends BasePhase {
  readonly name = 'gap_analysis';
  readonly requiresLlm = true;

  async execute(_query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    if (!ctx.llm || ctx.deterministic) {
      // Gap loop only runs in LLM mode
      return;
    }

    const initialMaxLoops = ctx.budget.profile.maxGapLoops;
    let maxLoops = initialMaxLoops;
    const gapFiller = new GapFiller(ctx.state, ctx.budget);
    let skipExtension = false;

    // Hoisted WorkerPoolManager (persists ingestedReportIds across iterations)
    const { WorkerPoolManager } = await import('../pool/workerPool.js');
    const gapWorkerPool = new WorkerPoolManager({
      concurrency: 3,
      perWorkerToolCalls: 35,
      tokenBudget: {
        recordTokens: (count: number) => {
          ctx.budget.recordTokens(count);
          return !ctx.budget.isExhausted();
        },
      },
    });

    for (let loopIdx = 0; loopIdx < maxLoops; loopIdx++) {
      if (ctx.budget.isExhausted()) break;
      this.checkAborted(ctx);

      const coverage = ctx.state.computeSubQuestionCoverage();
      const contentQuality = ctx.state.getAllContentQuality();

      // ── Contradiction detection (runs inside each gap loop) ──────
      // 1. Rule-based: detectContradictions() from state engine (always runs)
      const ruleContradictions = ctx.state.detectContradictions();
      if (ruleContradictions.length > 0) {
        logger.info(
          { loop: loopIdx + 1, contradictions: ruleContradictions.length },
          'Rule-based contradictions detected in gap loop',
        );
      }

      // 2. LLM-powered: shared ContradictionDetector for contradictions + open questions
      //    (runs on even iterations like the old runLlmContradictionScan)
      if (loopIdx % 2 === 0) {
        const detector = new ContradictionDetector(ctx.llm);
        const existingContradictions = ctx.state.getState().contradictions;
        const llmResult = await detector.analyze(
          ctx.state.getFindings(),
          ctx.state.getSources(),
          existingContradictions,
          ctx.state.getState().query,
        );

        if (llmResult.contradictions.length > 0) {
          const merged = mergeContradictions(existingContradictions, llmResult.contradictions);
          ctx.state.setContradictions(merged);
          logger.info(
            { loop: loopIdx + 1, added: llmResult.contradictions.length },
            'LLM contradiction detector: contradictions added in gap loop',
          );
        }

        if (llmResult.openQuestions.length > 0) {
          for (const q of llmResult.openQuestions) {
            ctx.state.addOpenQuestion(q);
          }
          logger.info(
            { loop: loopIdx + 1, added: llmResult.openQuestions.length },
            'LLM open-questions generator: questions added in gap loop',
          );
        }
      }

      // 3. Evidence-pool: generateFromEvidencePool() for date/version/benchmark conflicts (supplement)
      const evidenceGenerated = generateFromEvidencePool(
        ctx.state.getFindings(),
        ctx.state.getSources(),
        ctx.state.getState().query,
      );
      if (evidenceGenerated.contradictions.length > 0) {
        const existing = ctx.state.getState().contradictions;
        const merged = mergeContradictions(existing, evidenceGenerated.contradictions);
        ctx.state.setContradictions(merged);
        logger.info(
          { loop: loopIdx + 1, added: evidenceGenerated.contradictions.length },
          'Evidence-pool contradictions added in gap loop',
        );
      }
      if (evidenceGenerated.uncertainties.length > 0) {
        for (const u of evidenceGenerated.uncertainties) {
          ctx.state.addOpenQuestion(u);
        }
      }

      const analyzer = new GapAnalyzer(ctx.state);
      const gaps = analyzer.analyze(coverage, contentQuality);

      // Add contradiction-derived gaps: each unresolved contradiction becomes a gap
      const unresolvedContradictions = ctx.state.getUnresolvedContradictions();
      const contradictionGaps: GapRecord[] = unresolvedContradictions.map((c) => ({
        id: c.id,
        category: 'unresolvable_contradiction' as const,
        priority: 2,
        status: 'open' as const,
        description: `Contradictory claims: "${c.claimA.slice(0, 120)}" vs "${c.claimB.slice(0, 120)}"`,
        suggestedActions: [
          `Seek additional evidence to resolve contradiction between sources ${c.sourceIdsA.length > 0 ? c.sourceIdsA.join(', ') : 'multiple findings'} and ${c.sourceIdsB.length > 0 ? c.sourceIdsB.join(', ') : 'multiple findings'}`,
          'Look for authoritative sources to arbitrate (official docs, meta-analyses, benchmarks)',
          c.followUpSearchRecommended ?? '',
        ].filter(Boolean),
      }));

      const allGaps = [...gaps, ...contradictionGaps];

      const { filled, remaining } = await gapFiller.fillGaps(allGaps);
      const jobId = ctx.jobId;
      if (jobId) researchJobManager.incrementGapLoops(jobId);
      logger.info(
        { loop: loopIdx + 1, gaps: allGaps.length, filled, remaining: remaining.length },
        'Gap analysis loop',
      );

      if (ctx.budget.isConfidencePlateau(ctx.state.findingCount())) {
        logger.info({ loop: loopIdx + 1 }, 'Confidence plateau detected, ending gap loop');
        break;
      }

      if (!gapFiller.shouldContinueLoop()) {
        logger.info({ loop: loopIdx + 1 }, 'Gap filler stop heuristics met');
        break;
      }

      const minGapLoops = ctx.budget.profile.minGapLoops;
      const currentGapLoops = ctx.budget.snapshot().gapLoopsUsed;
      const criticalGaps =
        currentGapLoops < minGapLoops
          ? (allGaps.length > 0 ? allGaps : ctx.state.getOpenGaps()).filter((g) => g.priority <= 5)
          : allGaps.filter((g) => g.priority <= 2);
      if (criticalGaps.length === 0) break;

      // ── Adaptive band extension: extend loop budget for complex topics ───
      const totalContradictions = ctx.state.getState().contradictions.length;
      const sourceTypeCount = this.getSourceTypeCount(ctx);
      const totalFindings = ctx.state.findingCount();

      // Band triggers: contradictions found + low source diversity + thin findings
      if (totalContradictions >= 2 && sourceTypeCount < 4 && loopIdx + 1 >= maxLoops - 1) {
        maxLoops += 2;
        maxLoops = Math.min(maxLoops, ctx.budget.profile.maxGapLoops);
        logger.info(
          {
            contradictions: totalContradictions,
            sourceTypes: sourceTypeCount,
            newMaxLoops: maxLoops,
          },
          'Adaptive band: extending gap loop budget (contradictions + low diversity)',
        );
      } else if (totalFindings < 15 && loopIdx + 1 >= maxLoops - 1) {
        maxLoops += 2;
        maxLoops = Math.min(maxLoops, ctx.budget.profile.maxGapLoops);
        logger.info(
          { findings: totalFindings, newMaxLoops: maxLoops },
          'Adaptive band: extending gap loop budget (thin coverage)',
        );
      }

      const findingsBeforeExtension = ctx.state.findingCount();

      // Extend job timeout for gap-fill work
      const unansweredCount = criticalGaps.filter(
        (g) => g.category === 'unanswered_sub_question',
      ).length;
      const extensionMs =
        unansweredCount * 120_000 + (criticalGaps.length - unansweredCount) * 60_000;
      if (!skipExtension && jobId && extensionMs > 0) {
        if (researchJobManager.extendRuntime(jobId, extensionMs)) {
          ctx.budget.extendTimeBudget(extensionMs);
        }
      }
      const loopProgress = 50 + Math.round((loopIdx / initialMaxLoops) * 10);
      await this.reportProgress(
        ctx,
        loopProgress,
        `Gap loop ${String(loopIdx + 1)}/${String(maxLoops)}: investigating ${String(criticalGaps.length)} gap(s)`,
        'gap_filling',
        { gapLoopCount: loopIdx + 1 },
      );

      const followUpQuestions = criticalGaps.map((g) => g.description);
      const followUpSubQuestions: SubQuestion[] = criticalGaps
        .filter((g) => g.subQuestionId)
        .map((g) => ctx.state.getSubQuestions().find((sq) => sq.id === g.subQuestionId))
        .filter((sq): sq is SubQuestion => sq !== undefined);

      await gapWorkerPool.spawnWorkers(ctx, followUpQuestions, {
        ...(followUpSubQuestions.length > 0 ? { contextSubQuestions: followUpSubQuestions } : {}),
      });

      const findingsAfterLoop = ctx.state.findingCount();
      ctx.budget.recordFindingsAddedThisLoop(findingsAfterLoop - findingsBeforeExtension);

      const findingsAdded = findingsAfterLoop - findingsBeforeExtension;
      if (extensionMs > 0) {
        const rate = findingsAdded / extensionMs;
        if (rate < 0.001) {
          logger.warn(
            { findingsAdded, extensionMs, rate },
            'Gap-fill yield below threshold, skipping further extensions',
          );
          skipExtension = true;
        }
      }

      const lowPriorityGaps = gaps.filter((g) => g.priority >= 3 && g.priority <= 5);
      if (lowPriorityGaps.length > 0) {
        const batchedQuery = lowPriorityGaps.map((g) => g.description).join(' ');
        const { createResearchTools: createTools } = await import('../researchTools.js');
        const tools = createTools({
          onToolCall: () => {
            ctx.budget.recordToolCall();
          },
        });
        await tools.webSearch(batchedQuery, 5);
      }

      try {
        const pruning = new PruningEngine();
        pruning.enforceStateGuard(ctx.state, ctx.budget);
      } catch (e) {
        logger.warn({ err: e }, 'Pruning/compaction after gap loop failed');
      }
    }

    await this.reportProgress(
      ctx,
      60,
      `Investigation complete: ${String(ctx.state.workerReportCount())} workers, ${String(ctx.state.findingCount())} findings`,
      'gap_analysis',
    );
  }

  private getSourceTypeCount(ctx: StrategyContext): number {
    const sources = ctx.state.getSources();
    return new Set(sources.map((s) => s.sourceType)).size;
  }
}
