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

    let maxLoops = ctx.budget.profile.maxGapLoops;
    const gapFiller = new GapFiller(ctx.state, ctx.budget);
    let skipExtension = false;

    // Hoisted WorkerPoolManager (persists ingestedReportIds across iterations)
    const { WorkerPoolManager } = await import('../pool/workerPool.js');
    const gapWorkerPool = new WorkerPoolManager({
      concurrency: 3,
      perWorkerToolCalls: 15,
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
      // 1. Rule-based: detectContradictions() from state engine
      const ruleContradictions = ctx.state.detectContradictions();
      if (ruleContradictions.length > 0) {
        logger.info(
          { loop: loopIdx + 1, contradictions: ruleContradictions.length },
          'Rule-based contradictions detected in gap loop',
        );
      }

      // 2. Evidence-pool: generateFromEvidencePool() for date/version/benchmark conflicts
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

      // 3. LLM-powered: semantic contradiction scanner (batched, every 2nd loop)
      await this.runLlmContradictionScan(ctx, loopIdx);

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
          ? (allGaps.length > 0 ? allGaps : ctx.state.getOpenGaps()).filter(
              (g) => g.priority <= 5,
            )
          : gaps.filter((g) => g.priority <= 2);
      if (criticalGaps.length === 0) break;

      // ── Adaptive band extension: extend loop budget for complex topics ───
      const totalContradictions = ctx.state.getState().contradictions.length;
      const sourceTypeCount = this.getSourceTypeCount(ctx);
      const totalFindings = ctx.state.findingCount();

      // Band triggers: contradictions found + low source diversity + thin findings
      if (totalContradictions >= 2 && sourceTypeCount < 4 && loopIdx + 1 >= maxLoops - 1) {
        maxLoops += 2;
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
      const loopProgress = 50 + Math.round((loopIdx / maxLoops) * 10);
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

  private async runLlmContradictionScan(ctx: StrategyContext, loopIdx: number): Promise<void> {
    if (!ctx.llm || ctx.deterministic) return;

    // Only run on even-numbered iterations (0, 2, 4, ...) to halve cost
    if (loopIdx % 2 !== 0) return;

    const state = ctx.state.getState();
    const findings = state.findings;
    if (findings.length < 6) return;

    // Group findings by sub-question
    const bySubQuestion = new Map<string, import('../types.js').Finding[]>();
    for (const f of findings) {
      for (const sqId of f.subQuestionIds) {
        const group = bySubQuestion.get(sqId) ?? [];
        group.push(f);
        bySubQuestion.set(sqId, group);
      }
    }

    // Filter: only sub-questions with >= 3 findings (enough density for contradictions)
    const qualifying = [...bySubQuestion.entries()]
      .filter(([, group]) => group.length >= 3)
      .sort(([, a], [, b]) => b.length - a.length);

    if (qualifying.length === 0) return;

    // Batch: take up to 20 findings total across qualifying sub-questions
    const MAX_FINDINGS_PER_BATCH = 20;
    const batched: import('../types.js').Finding[] = [];
    for (const [, group] of qualifying) {
      for (const f of group) {
        if (batched.length >= MAX_FINDINGS_PER_BATCH) break;
        batched.push(f);
      }
      if (batched.length >= MAX_FINDINGS_PER_BATCH) break;
    }

    if (batched.length < 6) return;

    // Build existing contradiction set for dedup
    const existingContradictions = state.contradictions;
    const existingPairs = new Set<string>();
    for (const c of existingContradictions) {
      existingPairs.add(`${c.claimA}|||${c.claimB}`);
      existingPairs.add(`${c.claimB}|||${c.claimA}`);
    }

    const findingsInput = batched
      .map(
        (f) =>
          `[${f.id}] ${f.claim} (sources: ${String(f.sourceIds.length)}, sub-questions: ${f.subQuestionIds.join(', ')})`,
      )
      .join('\n');

    const existingContradictionSummary =
      existingContradictions.length > 0
        ? `\nExisting contradictions already recorded (DO NOT re-flag these):\n${existingContradictions.map((c) => `- "${c.claimA.slice(0, 80)}" vs "${c.claimB.slice(0, 80)}"`).join('\n')}`
        : '';

    const { randomUUID } = await import('node:crypto');
    const makeId = () => randomUUID().slice(0, 12);

    try {
      const result = await ctx.llm.callJSON<{
        contradictions: {
          claimA: string;
          claimB: string;
          contradictionType: string;
          explanation: string;
          followUpSearchRecommended?: string;
        }[];
      }>({
        model: 'orchestrator',
        messages: [
          { role: 'system', content: 'Scan findings for contradictions.' },
          {
            role: 'user',
            content: `Scan the following findings for hidden contradictions:\n\n${findingsInput}${existingContradictionSummary}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 2000,
        responseFormat: 'json_object',
      });

      if (result.success && result.data.contradictions.length > 0) {
        let added = 0;
        for (const c of result.data.contradictions) {
          const pairKey = `${c.claimA}|||${c.claimB}`;
          if (existingPairs.has(pairKey)) continue;

          const id = makeId();
          ctx.state.addContradiction({
            id,
            claimA: c.claimA,
            claimB: c.claimB,
            sourceIdsA: [],
            sourceIdsB: [],
            contradictionType: c.contradictionType as import('../types.js').ContradictionType,
            likelyExplanation: c.explanation,
            resolutionStatus: 'unresolved',
            ...(c.followUpSearchRecommended !== undefined
              ? { followUpSearchRecommended: c.followUpSearchRecommended }
              : {}),
          });
          existingPairs.add(pairKey);
          added++;
        }

        if (added > 0) {
          logger.info(
            {
              loop: loopIdx + 1,
              scanned: batched.length,
              found: result.data.contradictions.length,
              added,
            },
            'LLM contradiction scanner: new contradictions detected',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, loop: loopIdx + 1 },
        'LLM contradiction scanner failed; continuing without it',
      );
    }
  }

}
