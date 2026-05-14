/**
 * PipelineStrategy — implements the fixed 7-phase research pipeline using composable phases.
 *
 * This strategy works with or without an LLM. When an LLM is available,
 * it uses the GapLoopPhase for adaptive gap filling.
 * Otherwise, it uses DiscoveryPhase + ExtractionPhase for rule-based research.
 */

import { logger } from '../../logger.js';
import type { ResearchStrategy, StrategyContext } from './types.js';
import type { ResearchResult, ResearchReport } from '../types.js';
import {
  DecompositionPhase,
  DiscoveryPhase,
  ExtractionPhase,
  GapLoopPhase,
  PostProcessingPhase,
  AuditPhase,
  SynthesisPhase,
} from '../phases/index.js';
import { DeepTreeResearchEngine } from '../treeEngine.js';
import { PruningEngine } from '../pruning.js';
import { InFlightCompactor } from '../compactionInFlight.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import { ProgressTracker } from '../progress.js';

export class PipelineStrategy implements ResearchStrategy {
  readonly name = 'pipeline';
  readonly description =
    'Fixed 7-phase pipeline: decompose → discover → extract → gap → audit → synthesize. Works with or without LLM.';
  readonly requiresLlm = false;

  private progress = new ProgressTracker();
  private pruning = new PruningEngine();
  private compactor: InFlightCompactor | null = null;
  private report: ResearchReport | null = null;

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    const startTime = Date.now();
    const effectiveDepth = ctx.depth;

    this.compactor = new InFlightCompactor(ctx.state, ctx.budget);

    logger.info({ query, depth: effectiveDepth }, 'Pipeline research started');

    try {
      // ── Phase 1: Decomposition (rule-based, always) ──────────────────────
      const decompositionPhase = new DecompositionPhase();
      await decompositionPhase.execute(query, ctx);

      if (ctx.budget.isExhausted()) {
        logger.warn('Budget exhausted after decomposition');
        return await this.synthesizePartial(ctx);
      }

      // ── Tree research path ─────────
      const isTreeMode = effectiveDepth === 'tree';
      if (isTreeMode) {
        ctx.state.transitionTo('tree_research');
        logger.info('Phase Tree: Running breadth×depth tree research');
        const treeEngine = new DeepTreeResearchEngine({
          state: ctx.state,
          budget: ctx.budget,
          ...(ctx.llm !== undefined ? { llm: ctx.llm } : {}),
          ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
          contextWordLimit: ctx.config.treeContextWordLimit,
          ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
        });
        await treeEngine.run(
          query,
          ctx.config.treeBreadth,
          ctx.config.treeDepth,
          ctx.config.treeConcurrency,
        );
        logger.info(
          { sources: ctx.state.sourceCount(), findings: ctx.state.findingCount() },
          'Tree research complete, proceeding to audit/synthesis',
        );
        if (ctx.budget.isExhausted()) {
          logger.warn('Budget exhausted after tree research');
          return await this.synthesizePartial(ctx);
        }
      }

      if (!isTreeMode) {
        if (ctx.abortSignal?.aborted) {
          throw new DOMException('Research cancelled', 'AbortError');
        }

        if (ctx.llm && !ctx.deterministic) {
          // ── LLM path: Worker agent phase + Gap loop ───────────────────
          await this.runWorkerAgentPhase(ctx, query);

          try {
            this.compactor.compact();
          } catch (e) {
            logger.warn({ err: e }, 'Compaction after worker phase failed');
          }

          if (ctx.budget.isExhausted()) {
            logger.warn('Budget exhausted after worker agent phase');
            return await this.synthesizePartial(ctx);
          }

          // ── Gap analysis loop ───────────────────────────────
          const gapLoopPhase = new GapLoopPhase();
          await gapLoopPhase.execute(query, ctx);

          await this.reportProgress(
            ctx,
            60,
            `Investigation complete: ${String(ctx.state.workerReportCount())} workers, ${String(ctx.state.findingCount())} findings`,
            'gap_analysis',
          );
        } else {
          // ── Rule-based path: Discovery → Extraction ───────────────────
          const discoveryPhase = new DiscoveryPhase();
          await discoveryPhase.execute(query, ctx);

          if (ctx.budget.isExhausted()) {
            logger.warn('Budget exhausted after discovery');
            return await this.synthesizePartial(ctx);
          }

          const extractionPhase = new ExtractionPhase();
          await extractionPhase.execute(query, ctx);
        }
      }

      // ── Phase 3.5: Post-extraction processing ─────────────────────
      const postProcessingPhase = new PostProcessingPhase();
      await postProcessingPhase.execute(query, ctx);

      // ── Phase 6: Audit ──────────────────────
      const auditPhase = new AuditPhase();
      await auditPhase.execute(query, ctx);

      // ── Phase 7: Synthesis ────────────────
      const result = await this.synthesizeResults(ctx, startTime);

      if (!isTreeMode) {
        try {
          this.pruning.enforceStateGuard(ctx.state, ctx.budget);
          this.compactor.compact();
        } catch (e) {
          logger.warn({ err: e }, 'Pruning/compaction final cleanup failed');
        }
      }

      return result;
    } catch (err) {
      logger.error({ err }, 'Pipeline research failed');
      ctx.state.transitionTo('complete');
      if (this.report) {
        return {
          report: this.report,
          timeline: this.progress.getTimeline(),
        };
      }
      throw err;
    }
  }

  private async runWorkerAgentPhase(ctx: StrategyContext, query: string): Promise<void> {
    const decomposer = new (await import('../decomposer.js')).QueryDecomposer();
    const {
      classification: _classification,
      subQuestions,
      disambiguationNote,
      extractedEntities,
    } = decomposer.decompose(query);

    ctx.state.transitionTo('discovery');
    logger.info({ subQuestions: subQuestions.length }, 'V5: Worker agent phase starting');
    await this.reportProgress(
      ctx,
      20,
      `Launching ${String(subQuestions.length)} worker agent(s)`,
      'worker_investigation',
    );

    const priorKnowledge = buildPriorKnowledgeFn(disambiguationNote, extractedEntities);

    // Use WorkerPoolManager for worker spawning
    const { WorkerPoolManager } = await import('../pool/workerPool.js');
    const workerPool = new WorkerPoolManager({
      concurrency: 3,
      perWorkerToolCalls: 15,
      tokenBudget: {
        recordTokens: (count: number) => {
          ctx.budget.recordTokens(count);
          return !ctx.budget.isExhausted();
        },
      },
    });

    await workerPool.spawnWorkers(
      ctx,
      subQuestions.map((sq) => sq.text),
      {
        contextSubQuestions: subQuestions,
        ...(priorKnowledge !== undefined ? { priorKnowledge } : {}),
      },
    );

    logger.info(
      { reports: ctx.state.workerReportCount(), findings: ctx.state.findingCount() },
      'V5: Worker agent phase complete',
    );
  }

  private async reportProgress(
    ctx: StrategyContext,
    progress: number,
    message?: string,
    phase?: string,
    partials?: Record<string, unknown>,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, progress));
    try {
      await ctx.onProgress?.(clamped, message, phase, {
        sourceCount: ctx.state.sourceCount(),
        findingCount: ctx.state.findingCount(),
        subQuestionCount: ctx.state.getSubQuestions().length,
        ...partials,
      });
    } catch {
      // non-fatal
    }
  }

  private async synthesizeResults(
    ctx: StrategyContext,
    startTime: number,
  ): Promise<ResearchResult> {
    const synthesisPhase = new SynthesisPhase();
    await synthesisPhase.execute(ctx.state.getState().query, ctx);

    const state = ctx.state.getState();
    let report: ResearchReport;

    if (ctx.llm && !ctx.deterministic) {
      const { LlmSynthesizer } = await import('../llm/synthesis.js');
      const llmSynth = new LlmSynthesizer(ctx.llm);
      report = await llmSynth.synthesize(state);
    } else {
      report = new ResearchSynthesizer(state).synthesize();
    }

    this.report = report;

    ctx.state.transitionTo('complete');
    this.progress.researchComplete();

    const elapsed = Date.now() - startTime;
    logger.info(
      { elapsedMs: elapsed, findings: report.findingCount },
      'Pipeline research complete',
    );
    await this.reportProgress(ctx, 100, 'Pipeline research complete', 'complete');

    return {
      report,
      timeline: this.progress.getTimeline(),
      canonicalFindings: [...state.findings],
    };
  }

  private async synthesizePartial(ctx: StrategyContext): Promise<ResearchResult> {
    const state = ctx.state.getState();
    const report = new ResearchSynthesizer(state).synthesize();
    return {
      report,
      timeline: this.progress.getTimeline(),
      canonicalFindings: [...state.findings],
    };
  }

  async close(): Promise<void> {
    this.report = null;
  }
}

/**
 * Build prior knowledge string from decomposition metadata.
 */
function buildPriorKnowledgeFn(
  disambiguationNote?: string,
  extractedEntities?: { name: string; domain: string }[],
): string | undefined {
  const parts: string[] = [];
  if (disambiguationNote) {
    parts.push(`Topic disambiguation: ${disambiguationNote}`);
  }
  if (extractedEntities && extractedEntities.length > 0) {
    parts.push(
      `Key entities to research: ${extractedEntities.map((e) => `${e.name} (${e.domain})`).join(', ')}`,
    );
  }
  return parts.length > 0 ? parts.join('. ') : undefined;
}
