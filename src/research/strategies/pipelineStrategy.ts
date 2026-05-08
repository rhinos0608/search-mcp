/**
 * PipelineStrategy — implements the fixed 7-phase research pipeline.
 *
 * Phases:
 *   1 → Decompose query into sub-questions
 *   2 → Parallel broad discovery
 *   1.5 → Revise taxonomy after early discovery
 *   3 → Deep sequential extraction (LLM or rule-based)
 *   EDA → Evaluate-Decide-Act loop for adaptive gap filling
 *   6 → State audit (LLM + rule-based)
 *   7 → Source-weighted synthesis (LLM or rule-based)
 *
 * This strategy works with or without an LLM. When an LLM is available,
 * it uses WorkerAgent for enhanced search and extraction.
 */

import { logger } from '../../logger.js';
import { randomUUID } from 'node:crypto';
import type { ResearchStrategy, StrategyContext } from './types.js';
import { QueryDecomposer } from '../decomposer.js';
import { TaxonomyRevision } from '../taxonomy.js';
import { DiscoveryEngine } from '../discovery.js';
import { ExtractionEngine } from '../extraction.js';
import { GapAnalyzer, GapFiller } from '../gapAnalysis.js';
import { StateAuditor } from '../audit.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import { ProgressTracker } from '../progress.js';
import { ORCHESTRATOR_AUDIT, ORCHESTRATOR_CONTRADICTION_SCAN } from '../llm/prompts.js';
import { LlmSynthesizer } from '../llm/synthesis.js';
import { DeepTreeResearchEngine } from '../treeEngine.js';
import { WorkerAgent } from '../workerAgent.js';
import { generateFromEvidencePool, mergeContradictions } from '../contradictionGenerator.js';
import { createResearchTools } from '../researchTools.js';
import { researchJobManager } from '../jobManager.js';
import { PruningEngine } from '../pruning.js';
import { InFlightCompactor } from '../compactionInFlight.js';
import { validateUrls } from '../urlHealth.js';
import { scoreAllFindings } from '../relevanceClassifier.js';
import { processAndSplitFindings } from '../findingSplitter.js';
import type {
  ResearchResult,
  ResearchReport,
  Finding,
  AuditReport,
  SubQuestion,
  WorkerReport,
  SourceType,
  GapRecord,
  Perspective,
  EpistemicStatus,
} from '../types.js';

export type PipelineRunnerFn = (query: string, ctx: StrategyContext) => Promise<ResearchResult>;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeId(): string {
  return randomUUID().slice(0, 12);
}

/**
 * Build prior knowledge string from decomposition metadata for worker agents.
 */
function buildPriorKnowledge(
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

/**
 * Infer the source perspective from the source type.
 * Used to help contradiction detection identify epistemic tension.
 */
function inferPerspective(sourceType: SourceType): Perspective {
  switch (sourceType) {
    case 'academic':
      return 'academic';
    case 'reddit':
    case 'hackernews':
    case 'stackoverflow':
      return 'community';
    case 'youtube':
    case 'news':
      return 'media';
    case 'github':
      return 'practitioner';
    case 'documentation':
    case 'wikipedia':
    case 'pubmed':
      return 'official';
    case 'web':
    default:
      return 'unknown';
  }
}

// ── PipelineStrategy ──────────────────────────────────────────────────────

export class PipelineStrategy implements ResearchStrategy {
  readonly name = 'pipeline';
  readonly description =
    'Fixed 7-phase pipeline: decompose → discover → extract → gap → audit → synthesize. Works with or without LLM.';
  readonly requiresLlm = false;

  private progress = new ProgressTracker();
  private pruning = new PruningEngine();
  private compactor: InFlightCompactor | null = null;
  private report: ResearchReport | null = null;
  private ingestedReportIds = new Set<string>();

  constructor(private runner?: PipelineRunnerFn) {
    // Logic moved from orchestrator
  }

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    if (this.runner) {
      return this.runner(query, ctx);
    }
    const startTime = Date.now();
    const effectiveDepth = ctx.depth;
    const jobId = ctx.jobId;

    this.compactor = new InFlightCompactor(ctx.state, ctx.budget);

    logger.info({ query, depth: effectiveDepth }, 'Pipeline research started');

    try {
      // ── Phase 1: Decomposition (rule-based, always) ──────────────────────
      ctx.state.transitionTo('decomposition');
      logger.info('Phase 1: Decomposing query');

      const decomposer = new QueryDecomposer();
      const { classification, subQuestions, disambiguationNote, extractedEntities } =
        decomposer.decompose(query);

      for (const sq of subQuestions) {
        if (classification === 'current-events' || classification === 'market-ecosystem') {
          sq.freshnessIntent = 'recent';
        } else if (classification === 'historical-timeline') {
          sq.freshnessIntent = 'historical';
        } else {
          sq.freshnessIntent = 'any';
        }
        ctx.state.addSubQuestion(sq);
      }

      this.progress.decompositionComplete(classification, subQuestions);
      logger.info({ subQuestions: subQuestions.length, classification }, 'Query decomposed');
      await this.reportProgress(
        ctx,
        10,
        `Query decomposed: ${String(subQuestions.length)} sub-questions`,
        'decomposition',
      );

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
        this.checkAborted(ctx);

        if (ctx.llm && !ctx.deterministic) {
          const priorKnowledge = buildPriorKnowledge(disambiguationNote, extractedEntities);
          await this.runWorkerAgentPhase(ctx, subQuestions, effectiveDepth, priorKnowledge);
          try {
            this.compactor.compact();
          } catch (e) {
            logger.warn({ err: e }, 'Compaction after worker phase failed');
          }
          if (ctx.budget.isExhausted()) {
            logger.warn('Budget exhausted after worker agent phase');
            return await this.synthesizePartial(ctx);
          }

          // ── Gap analysis retry loop ───────────────────────────────
          let maxLoops = ctx.budget.profile.maxGapLoops;
          const gapFiller = new GapFiller(ctx.state, ctx.budget);
          let skipExtension = false;

          for (let loopIdx = 0; loopIdx < maxLoops; loopIdx++) {
            if (ctx.budget.isExhausted()) break;
            this.checkAborted(ctx);

            const coverage = ctx.state.computeSubQuestionCoverage();
            const contentQuality = ctx.state.getAllContentQuality();

            // ── Contradiction detection (runs inside each gap loop) ──────
            // 1. Rule-based: detectContradictions() from state engine
            const ruleContradictions = ctx.state.detectContradictions();
            if (ruleContradictions.length > 0) {
               this.progress.contradictionsFound(ruleContradictions);
               logger.info({ loop: loopIdx + 1, contradictions: ruleContradictions.length }, 'Rule-based contradictions detected in gap loop');
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
               logger.info({ loop: loopIdx + 1, added: evidenceGenerated.contradictions.length }, 'Evidence-pool contradictions added in gap loop');
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
            this.progress.gapsIdentified(allGaps);

            const { filled, remaining } = await gapFiller.fillGaps(allGaps);
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

            const criticalGaps = gaps.filter((g) => g.priority <= 2);
            if (criticalGaps.length === 0) break;

            // ── Adaptive band extension: extend loop budget for complex topics ───
            const totalContradictions = ctx.state.getState().contradictions.length;
            const sourceTypeCount = this.getSourceTypeCount(ctx);
            const totalFindings = ctx.state.findingCount();

            // Band triggers: contradictions found + low source diversity + thin findings
            if (totalContradictions >= 2 && sourceTypeCount < 4 && loopIdx + 1 >= maxLoops - 1) {
               maxLoops += 2;
               logger.info(
                  { contradictions: totalContradictions, sourceTypes: sourceTypeCount, newMaxLoops: maxLoops },
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
            if (jobId) researchJobManager.incrementGapLoops(jobId);

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

            await this.spawnWorkers(
              ctx,
              followUpQuestions,
              'gap_fill',
              effectiveDepth,
              followUpSubQuestions,
            );

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
              const tools = createResearchTools({
                onToolCall: () => {
                  ctx.budget.recordToolCall();
                },
              });
              await tools.webSearch(batchedQuery, 5);
            }

            try {
              this.pruning.enforceStateGuard(ctx.state, ctx.budget);
              this.compactor.compact();
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
        } else {
          // ── Phase 2: Discovery (tool-based, always) ──────────────────────────
          ctx.state.transitionTo('discovery');
          logger.info('Phase 2: Broad discovery');

          const discovery = new DiscoveryEngine(ctx.state, ctx.budget, undefined, ctx.llm, ctx.abortSignal);
          const candidates = await discovery.discover(subQuestions);

          const sqSourceCounts = subQuestions.map((sq) => ({
            subQuestionId: sq.id,
            count: ctx.state.getSources(sq.id).length,
          }));
          this.progress.sourcesDiscovered(sqSourceCounts);

          logger.info(
            { sources: ctx.state.sourceCount(), candidates: candidates.length },
            'Discovery complete',
          );
          await this.reportProgress(
            ctx,
            25,
            `Discovery complete: ${String(ctx.state.sourceCount())} sources`,
            'discovery',
          );

          try {
            this.pruning.evictSources(ctx.state, ctx.budget);
            this.pruning.enforceStateGuard(ctx.state, ctx.budget);
          } catch (e) {
            logger.warn({ err: e }, 'Pruning after discovery failed');
          }

          if (ctx.budget.isExhausted()) {
            logger.warn('Budget exhausted after discovery');
            return await this.synthesizePartial(ctx);
          }

          // ── Phase 1.5: Taxonomy revision ─────────────────
          if (!ctx.state.isTaxonomyRevised() && candidates.length > 0) {
            const taxonomy = new TaxonomyRevision();
            const { taxonomy: revisedTaxonomy } = taxonomy.revise(
              ctx.state.getTaxonomy(),
              candidates,
            );
            if (revisedTaxonomy.revised) {
              ctx.state.reviseTaxonomy(revisedTaxonomy);
              this.progress.taxonomyRevised(revisedTaxonomy);
              logger.info('Taxonomy revised after early discovery');
              await this.reportProgress(ctx, 30, 'Taxonomy revised', 'taxonomy_revision');
            }
          }

          // ── Phase 3: Extraction ─────────────────────────────
          ctx.state.transitionTo('extraction');
          logger.info('Phase 3: Deep extraction (rule-based)');

          const extractionTargets = ctx.state.getTopSources(ctx.budget.profile.maxExtractions);
          if (extractionTargets.length > 0) {
            const extraction = new ExtractionEngine(ctx.state, ctx.budget);
            const findingIds = await extraction.extract(extractionTargets);
            const findings: Finding[] = findingIds
              .map((id) => ctx.state.getFinding(id))
              .filter((f): f is Finding => f !== undefined);

            this.progress.extractionProgress(extractionTargets.length, extractionTargets.length);
            this.progress.findingsExtracted(findings);

            logger.info(
              { findings: findings.length, extracted: extractionTargets.length },
              'Extraction complete',
            );
            await this.reportProgress(
              ctx,
              50,
              `Extraction complete: ${String(findings.length)} findings`,
              'extraction',
            );

            try {
              this.pruning.enforceStateGuard(ctx.state, ctx.budget);
            } catch (e) {
              logger.warn({ err: e }, 'Pruning after extraction failed');
            }

            if (ctx.budget.isExhausted()) {
              logger.warn('Budget exhausted after extraction — going to synthesis');
              return await this.synthesizePartial(ctx);
            }

            const postResults = ctx.state.postProcessFindings();
            logger.info(
              { merged: postResults.merged, contradictions: postResults.contradictions },
              'Post-extraction processing complete',
            );
            this.progress.contradictionsFound(ctx.state.getUnresolvedContradictions());
          }
        }
      }

      // ── Post-extraction processing: relevance classifier + splitter + contradictions ──
      // Runs for both LLM and rule-based paths before audit/synthesis
      const allFindings = ctx.state.getFindings();
      if (allFindings.length > 0) {
        // 1. Relevance classify all findings against the original query
        const relevanceScores = scoreAllFindings(query, allFindings);
        for (const f of allFindings) {
          const scored = relevanceScores.get(f.id);
          if (scored) {
            f.relevanceScore = scored.score;
            f.relevanceReason = scored.reason;
          }
        }
        const admissibleCount = [...relevanceScores.values()].filter((r) => r.admissible).length;
        logger.info(
          { total: allFindings.length, admissible: admissibleCount, inadmissible: allFindings.length - admissibleCount },
          'Relevance classification applied to findings',
        );

        // 2. Split multi-claim findings into atomic ones
        const { updated, newSplits } = processAndSplitFindings(allFindings);
        // Replace original findings with updated versions (preserving id)
        for (const f of ctx.state.getFindings()) {
          const updatedData = updated.get(f.id);
          if (updatedData) {
            Object.assign(f, updatedData);
          }
        }
        // Add split findings to state
        let splitAdded = 0;
        for (const split of newSplits) {
          ctx.state.addFinding(split);
          splitAdded++;
        }
        if (splitAdded > 0) {
          logger.info({ splitAdded }, 'Finding splitter: atomic findings added');
        }

        // 3. Generate contradictions and uncertainties from the evidence pool
        const generated = generateFromEvidencePool(
          ctx.state.getFindings(),
          ctx.state.getSources(),
          query,
        );
        if (generated.contradictions.length > 0) {
          const merged = mergeContradictions(
            ctx.state.getState().contradictions,
            generated.contradictions,
          );
          // Replace contradictions in state
          const state = (ctx.state as any).getState();
          state.contradictions = merged;
          logger.info(
            { added: generated.contradictions.length, total: merged.length },
            'Contradiction generator: evidence-pool contradictions added',
          );
        }
        if (generated.uncertainties.length > 0) {
          for (const u of generated.uncertainties) {
            ctx.state.addOpenQuestion(u);
          }
          logger.info(
            { uncertainties: generated.uncertainties.length },
            'Contradiction generator: uncertainties added to open questions',
          );
        }
      }

      // ── Phase 6: Audit ──────────────────────
      ctx.state.transitionTo('audit');
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
      this.progress.reportAction('audit', 'Audit complete');

      const contradictions = ctx.state.detectContradictions();
      if (contradictions.length > 0) {
        this.progress.contradictionsFound(contradictions);
        logger.info({ contradictions: contradictions.length }, 'Contradictions detected');
      }

      // ── Phase 7: Synthesis ────────────────
      await this.reportProgress(ctx, 95, 'Synthesizing research report', 'synthesis');
      const result = await this.synthesizeResults(
        ctx,
        startTime,
        mergedAuditReport.issues
          .filter((i) => i.severity === 'warning')
          .slice(0, 3)
          .map((i) => i.description),
      );

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

  private async runWorkerAgentPhase(
    ctx: StrategyContext,
    subQuestions: SubQuestion[],
    depth: string,
    priorKnowledge?: string,
  ): Promise<void> {
    ctx.state.transitionTo('discovery');
    logger.info({ subQuestions: subQuestions.length }, 'V5: Worker agent phase starting');
    await this.reportProgress(
      ctx,
      20,
      `Launching ${String(subQuestions.length)} worker agent(s)`,
      'worker_investigation',
    );

    await this.spawnWorkers(
      ctx,
      subQuestions.map((sq) => sq.text),
      'initial',
      depth,
      subQuestions,
      priorKnowledge,
    );
    logger.info(
      { reports: ctx.state.workerReportCount(), findings: ctx.state.findingCount() },
      'V5: Worker agent phase complete',
    );
  }

  private async spawnWorkers(
    ctx: StrategyContext,
    questions: string[],
    _source: string,
    _depth: string,
    contextSubQuestions?: SubQuestion[],
    priorKnowledge?: string,
  ): Promise<void> {
    if (!ctx.llm && !ctx.deterministic) return;

    // ── Per-worker tool call budget ─────────────────────────────────────
    // Pre-allocate a tool call pool so worker diversity doesn't starve gap loops.
    // Workers use their own pool; only over-budget calls hit the global budget.
    const PER_WORKER_TOOL_CALLS = 15;
    const globalRemaining = Math.max(
      0,
      ctx.budget.profile.maxToolCalls - ctx.budget.snapshot().toolCallsUsed,
    );
    const workerPool = Math.min(questions.length * PER_WORKER_TOOL_CALLS, globalRemaining);
    let workerToolCallsUsed = 0;

    const tools = createResearchTools({
      onToolCall: (tool, query) => {
        workerToolCallsUsed++;
        logger.debug({ tool, query: query.slice(0, 60) }, `Worker tool: ${tool}`);
      },
    });

    const tokenBudget = {
      recordTokens: (count: number) => {
        ctx.budget.recordTokens(count);
        return !ctx.budget.isExhausted();
      },
    };

    const concurrency = 3;

    for (let i = 0; i < questions.length; i += concurrency) {
      if (ctx.budget.isExhausted()) break;
      this.checkAborted(ctx);

      const batch = questions.slice(i, i + concurrency);
      const batchSubQuestions = contextSubQuestions?.slice(i, i + concurrency);
      const llm = ctx.llm;

      const workerPromises = batch.map(async (question, batchIdx) => {
        // WorkerAgent handles undefined llm when deterministicMode is true
        const worker = new WorkerAgent(llm, tools, tokenBudget, {
          deterministicMode: ctx.deterministic ?? false,
        });
        try {
          const parentId = batchSubQuestions?.[batchIdx]?.id;
          const report = await worker.investigate(question, {
            ...(parentId !== undefined ? { parentSubQuestionId: parentId } : {}),
            ...(contextSubQuestions !== undefined ? { subQuestions: contextSubQuestions } : {}),
            ...(priorKnowledge !== undefined ? { priorKnowledge } : {}),
            onProgress: (stage, detail) => {
              void this.reportProgress(
                ctx,
                20 + Math.round((i / questions.length) * 30),
                `[${stage}] ${detail}`,
                'worker_investigation',
              );
            },
          });
          ctx.state.addWorkerReport(report);
          for (const [url, quality] of Object.entries(report.contentQuality)) {
            ctx.state.setContentQuality(url, quality);
          }
          return report;
        } catch (err) {
          logger.warn({ err, question: question.slice(0, 60) }, 'Worker agent failed');
          return null;
        }
      });

      await Promise.allSettled(workerPromises);

      const completed = Math.min(i + batch.length, questions.length);
      const pct = 20 + Math.round((completed / questions.length) * 30);
      const firstQuestion = batch[0] ?? '';
      await this.reportProgress(
        ctx,
        pct,
        `Worker ${String(completed)}/${String(questions.length)}: ${firstQuestion.slice(0, 50)}`,
        'worker_investigation',
        {
          subQuestionCount: ctx.state.getSubQuestions().length,
        },
      );
    }

    // Batch-report consumed worker tool calls to global budget after all work done.
    // Workers track their own count during execution; we record now as a batch.
    for (let t = 0; t < workerToolCallsUsed; t++) {
      ctx.budget.recordToolCall();
    }
    logger.info(
      { allocated: workerPool, consumed: workerToolCallsUsed },
      'Worker tool call budget: batch report',
    );

    this.ingestWorkerReports(ctx);
  }

  private ingestWorkerReports(ctx: StrategyContext): void {
    const allReports = ctx.state.getAllWorkerReports();
    const reports = allReports.filter((r) => !this.ingestedReportIds.has(r.id));
    if (reports.length === 0) return;

    for (const report of reports) {
      this.ingestedReportIds.add(report.id);
    }

    for (const report of reports) {
      for (const ws of report.sources) {
        this.ensureSourceExists(ctx, ws.url, report);
      }
    }

    let unattributedCount = 0;
    let inferredCount = 0;
    for (const report of reports) {
      for (const wf of report.findings) {
        if (wf.citationConfidence === 'unattributed') unattributedCount++;
        else if (wf.citationConfidence === 'inferred') inferredCount++;

        const allSourceIds: string[] = [];
        const allSources = ctx.state.getSources();
        for (const url of wf.sourceUrls) {
          const existing = allSources.find((s) => s.url === url);
          if (existing) {
            allSourceIds.push(existing.id);
          } else {
            const fallbackId = this.ensureSourceExists(ctx, url, report);
            allSourceIds.push(fallbackId);
          }
        }

        const firstSourceQuality =
          wf.sourceUrls.length > 0 ? report.contentQuality[wf.sourceUrls[0] ?? ''] : undefined;

        // Infer source perspective from the primary source type
        const primarySource = allSources.find((s) => s.url === wf.sourceUrls[0]);
        const perspective = primarySource
          ? inferPerspective(primarySource.sourceType)
          : (('unknown') as Perspective);

        // Epistemic status: derived from worker report confidence + content quality
        const epistemicStatus: EpistemicStatus =
          firstSourceQuality && firstSourceQuality.contentDepth < 0.4
            ? 'speculative'
            : wf.citationConfidence === 'unattributed'
              ? 'unknown'
              : 'emerging';

        ctx.state.addFinding({
          claim: wf.claim,
          normalizedClaim: wf.claim
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .trim(),
          subQuestionIds: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
          sourceIds: [...new Set(allSourceIds)],
          evidenceSummary: wf.evidence,
          evidenceExcerpt: wf.evidence.slice(0, 500),
          evidenceDirectness: this.deriveEvidenceDirectness(wf, firstSourceQuality),
          ...(wf.caveats !== undefined ? { caveats: wf.caveats } : {}),
          ...(wf.citationConfidence === 'unattributed'
            ? {
                caveats:
                  (wf.caveats ? wf.caveats + ' ' : '') +
                  '[Citation: unattributed — no source could be verified for this claim]',
              }
            : wf.citationConfidence === 'inferred'
              ? {
                  caveats:
                    (wf.caveats ? wf.caveats + ' ' : '') +
                    '[Citation: inferred — source mapping may be imprecise]',
                }
              : {}),
          freshnessSensitive: false,
          lastUpdated: new Date().toISOString(),
          claimType: 'primary' as const,
          perspective,
          ...(perspective === 'vendor' || perspective === 'official' ? { conflictOfInterest: true } : {}),
          epistemicStatus,
        });
      }
    }

    if (unattributedCount > 0) {
      ctx.state.addOpenQuestion(
        `${String(unattributedCount)} finding(s) have unattributed citations. Treat these claims as low-confidence.`,
      );
    }
    if (inferredCount > 0) {
      ctx.state.addOpenQuestion(
        `${String(inferredCount)} finding(s) have inferred citations. Verify before relying on these claims.`,
      );
    }

    // ── V5.1.0: Extraction accounting for LLM worker path ───────────────────
    // Worker agent synthesis replaces per-source extraction in the traditional
    // path. Track extraction-equivalent budget consumption to prevent the
    // budget tracker from thinking no extraction work happened.
    //
    // Count: 1 extraction per substantive source the worker visited.
    // This is proportional to real work done (fetch + quality assess + synthesize).
    let extractionsTracked = 0;
    for (const report of reports) {
      for (const ws of report.sources) {
        // Only count sources that contributed substantively (not promotional filler)
        if (ws.quality?.isSubstantive) {
          ctx.budget.recordExtraction();
          extractionsTracked++;
        }
      }
    }
    if (extractionsTracked > 0) {
      logger.info(
        { reports: reports.length, extractionsTracked },
        'V5: Extraction budget tracked for worker agent sources',
      );
    }
  }

  private ensureSourceExists(ctx: StrategyContext, url: string, report: WorkerReport): string {
    if (!url) return `src-${report.id}`;
    const existingSources = ctx.state.getSources();
    const existing = existingSources.find((s) => s.url === url);
    if (existing) return existing.id;

    const wsEntry = report.sources.find((s) => s.url === url);
    const sourceType: SourceType = wsEntry?.sourceType ?? 'web';
    const sourceId = `src-${url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(Date.now())}`;

    ctx.state.addSource({
      id: sourceId,
      title: wsEntry?.title ?? url,
      url,
      sourceType,
      domain: wsEntry?.domain ?? this.extractDomain(url),
      isPrimary: sourceType === 'academic',
      relevantSubQuestions: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      ...(wsEntry?.publishedDate !== undefined ? { publishedDate: wsEntry.publishedDate } : {}),
      subQuestionId: report.parentSubQuestionId ?? '',
    });

    return sourceId;
  }

  private deriveEvidenceDirectness(
    _wf: import('../types.js').WorkerFinding,
    quality: import('../types.js').ContentQualityAssessment | undefined,
  ): import('../types.js').EvidenceDirectness {
    if (!quality) return 'near-direct';
    if (quality.isSubstantive && quality.contentDepth >= 0.7) return 'direct';
    if (quality.isPromotional || quality.contentDepth < 0.4) return 'secondary';
    return 'near-direct';
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
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
    return result.data as unknown as AuditReport;
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

  private checkAborted(ctx: StrategyContext): void {
    if (ctx.abortSignal?.aborted) {
      throw new DOMException('Research cancelled', 'AbortError');
    }
  }

  private getSourceTypeCount(ctx: StrategyContext): number {
    const sources = ctx.state.getSources();
    return new Set(sources.map((s) => s.sourceType)).size;
  }

  private async reportProgress(
    ctx: StrategyContext,
    progress: number,
    message?: string,
    phase?: string,
    partials?: {
      sourceCount?: number;
      findingCount?: number;
      subQuestionCount?: number;
      sourceTypeCount?: number;
      gapLoopCount?: number;
      classification?: string;
    },
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, progress));
    const fullPartials = {
      sourceCount: ctx.state.sourceCount(),
      findingCount: ctx.state.findingCount(),
      subQuestionCount: ctx.state.getSubQuestions().length,
      sourceTypeCount: this.getSourceTypeCount(ctx),
      ...partials,
    };
    try {
      await ctx.onProgress?.(clamped, message, phase, fullPartials);
    } catch {}
  }

  private async synthesizeResults(
    ctx: StrategyContext,
    startTime: number,
    _auditWarnings: string[],
  ): Promise<ResearchResult> {
    ctx.state.transitionTo('synthesis');
    this.progress.reportAction('synthesize', 'Generating synthesis report');

    try {
      const state = ctx.state.getState();
      let report: ResearchReport;

      if (ctx.llm && !ctx.deterministic) {
        const llmSynth = new LlmSynthesizer(ctx.llm);
        report = await llmSynth.synthesize(state);
      } else {
        report = new ResearchSynthesizer(state).synthesize();
      }

      this.report = report;

      try {
        const allUrls = state.sources.map((s) => s.url);
        if (allUrls.length > 0) {
          const urlResults = await validateUrls(allUrls);
          const hallucinated = urlResults.filter((r) => r.status === 'LIKELY_HALLUCINATED');
          const dead = urlResults.filter((r) => r.status === 'DEAD');
          if (hallucinated.length > 0) {
            report.openQuestions.push(
              `${String(hallucinated.length)} cited URL(s) may be hallucinated.`,
            );
          }
          if (dead.length > 0) {
            report.sourceNotes.push(`${String(dead.length)} cited URL(s) appear to be dead.`);
          }
        }
      } catch (e) {
        logger.warn({ err: e }, 'Citation URL validation failed');
      }

      ctx.state.transitionTo('complete');
      this.progress.researchComplete();

      const elapsed = Date.now() - startTime;
      logger.info(
        { elapsedMs: elapsed, findings: report.findingCount },
        'Pipeline research complete',
      );
      await this.reportProgress(ctx, 100, 'Pipeline research complete', 'complete');

      return { report, timeline: this.progress.getTimeline() };
    } catch (synthErr) {
      logger.error({ err: synthErr }, 'Synthesis failed; returning partial results');
      const state = ctx.state.getState();
      const partialReport = new ResearchSynthesizer(state).synthesize();
      return { report: partialReport, timeline: this.progress.getTimeline() };
    }
  }

  // ── LLM Contradiction Scanner (batched, every 2nd gap loop) ───────────

  /**
   * Run the LLM-powered contradiction scanner on findings grouped by sub-question.
   *
   * Batching strategy:
   * - Only runs when LLM is available and not deterministic
   * - Only runs every 2nd gap loop iteration (halves cost)
   * - Only scans sub-questions with >= 3 findings (enough density for conflicts)
   * - Caps at 20 findings per batch (controls token cost)
   * - Skips if no qualifying findings exist
   *
   * Found contradictions are merged into the existing contradiction set.
   */
  private async runLlmContradictionScan(
    ctx: StrategyContext,
    loopIdx: number,
  ): Promise<void> {
    if (!ctx.llm || ctx.deterministic) return;

    // Only run on even-numbered iterations (0, 2, 4, ...) to halve cost
    if (loopIdx % 2 !== 0) return;

    const state = ctx.state.getState();
    const findings = state.findings;
    if (findings.length < 6) return; // need at least some findings for meaningful comparison

    // Group findings by sub-question
    const bySubQuestion = new Map<string, Finding[]>();
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
    const batched: Finding[] = [];
    for (const [, group] of qualifying) {
      for (const f of group) {
        if (batched.length >= MAX_FINDINGS_PER_BATCH) break;
        batched.push(f);
      }
      if (batched.length >= MAX_FINDINGS_PER_BATCH) break;
    }

    if (batched.length < 6) return; // need real density

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
          `[${f.id}] ${f.claim} (sources: ${f.sourceIds.length}, sub-questions: ${f.subQuestionIds.join(', ')})`,
      )
      .join('\n');

    const existingContradictionSummary =
      existingContradictions.length > 0
        ? `\nExisting contradictions already recorded (DO NOT re-flag these):\n${existingContradictions.map((c) => `- "${c.claimA.slice(0, 80)}" vs "${c.claimB.slice(0, 80)}"`).join('\n')}`
        : '';

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
          { role: 'system', content: ORCHESTRATOR_CONTRADICTION_SCAN },
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
            { loop: loopIdx + 1, scanned: batched.length, found: result.data.contradictions.length, added },
            'LLM contradiction scanner: new contradictions detected',
          );
        }
      }
    } catch (err) {
      logger.warn({ err, loop: loopIdx + 1 }, 'LLM contradiction scanner failed; continuing without it');
    }
  }

  private async synthesizePartial(ctx: StrategyContext): Promise<ResearchResult> {
    const state = ctx.state.getState();
    const report = new ResearchSynthesizer(state).synthesize();
    return { report, timeline: this.progress.getTimeline() };
  }

  async close(): Promise<void> {
    this.ingestedReportIds.clear();
    this.report = null;
  }
}
