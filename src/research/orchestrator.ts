/**
 * ResearchOrchestrator — state machine with EVALUATE-DECIDE-ACT control loop.
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
 * The orchestrator tracks budget, manages LLM-based modules when configured,
 * and surfaces progressive rendering updates throughout.
 */

import { logger } from '../logger.js';

import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from './state.js';
import { QueryDecomposer } from './decomposer.js';
import { TaxonomyRevision } from './taxonomy.js';
import { DiscoveryEngine } from './discovery.js';
import { ExtractionEngine } from './extraction.js';
import { GapAnalyzer } from './gapAnalysis.js';
import { StateAuditor } from './audit.js';
import { ResearchSynthesizer } from './synthesizer.js';
import { ProgressTracker } from './progress.js';
import { DeepResearchLlmClient, type TokenBudget } from './llm/chat.js';
import { ORCHESTRATOR_AUDIT } from './llm/prompts.js';
import { LlmSynthesizer } from './llm/synthesis.js';
import { LanguageDetector } from './language.js';
import { DeepTreeResearchEngine } from './treeEngine.js';
import { WorkerAgent } from './workerAgent.js';
import { createResearchTools } from './researchTools.js';
import { researchJobManager } from './jobManager.js';
import { GapFiller } from './gapAnalysis.js';
import { PruningEngine } from './pruning.js';
import { InFlightCompactor } from './compactionInFlight.js';
import { validateUrls } from './urlHealth.js';
import type {
   ResearchDepth,
   ResearchResult,
   ResearchReport,
   Finding,
   AuditReport,
   SubQuestion,
   WorkerReport,
   SourceType,
} from './types.js';
import type { DeepResearchConfig } from '../config.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OrchestratorLlmConfig {
   baseUrl: string;
   model: string;
   workerModel: string;
   apiToken?: string;
}

/** Progress notification callback. Optional phase overrides derivePhase in the handler. */
export type ProgressCallback = (
   progress: number,
   message?: string,
   phase?: string,
   partials?: {
      sourceCount?: number;
      findingCount?: number;
      subQuestionCount?: number;
      classification?: string;
   },
) => void | Promise<void>;

/**
 * Build prior knowledge string from decomposition metadata for worker agents.
 * Provides disambiguation context and known entities to guide search planning.
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

// OrchestratorDecision, OrchestratorEvaluation, ActionGates removed together with EDA loop

// ── Default config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<DeepResearchConfig> = {
   enabled: true,
   defaultDepth: 'standard',
   maxDepth: 'deep',
   maxToolCalls: 200,
   maxTokens: 500_000,
   maxTimeMs: 300_000,
   baseUrl: '',
   model: '',
   workerModel: '',
   apiToken: '',
   treeBreadth: 4,
   treeDepth: 2,
   treeConcurrency: 2,
   treeContextWordLimit: 25000,
};

function normalizeConfig(cfg?: Partial<DeepResearchConfig>): Required<DeepResearchConfig> {
   if (!cfg) return DEFAULT_CONFIG;
   return {
      enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
      defaultDepth: cfg.defaultDepth ?? DEFAULT_CONFIG.defaultDepth,
      maxDepth: cfg.maxDepth ?? DEFAULT_CONFIG.maxDepth,
      maxToolCalls: cfg.maxToolCalls ?? DEFAULT_CONFIG.maxToolCalls,
      maxTokens: cfg.maxTokens ?? DEFAULT_CONFIG.maxTokens,
      maxTimeMs: cfg.maxTimeMs ?? DEFAULT_CONFIG.maxTimeMs,
      baseUrl: cfg.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      model: cfg.model ?? DEFAULT_CONFIG.model,
      workerModel: cfg.workerModel ?? DEFAULT_CONFIG.workerModel,
      apiToken: cfg.apiToken ?? DEFAULT_CONFIG.apiToken,
      treeBreadth: cfg.treeBreadth ?? DEFAULT_CONFIG.treeBreadth,
      treeDepth: cfg.treeDepth ?? DEFAULT_CONFIG.treeDepth,
      treeConcurrency: cfg.treeConcurrency ?? DEFAULT_CONFIG.treeConcurrency,
      treeContextWordLimit: cfg.treeContextWordLimit ?? DEFAULT_CONFIG.treeContextWordLimit,
   };
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

// ── FailureAnalyzer (removed — EDA loop was removed with LLM extraction changes)

export class ResearchOrchestrator {
   private state: ResearchStateEngine;
   private budget: BudgetTracker;
   private progress: ProgressTracker;
   private config: Required<DeepResearchConfig>;
   private llm: DeepResearchLlmClient | undefined;
   private report: ResearchReport | null = null;
   private abortSignal: AbortSignal | undefined;
   /**
    * Optional progress callback, set by run().
    */
   private pruning: PruningEngine;
   private compactor: InFlightCompactor;

   private onProgress: ProgressCallback = () => {
      // Default empty callback
   };

   constructor(config?: Partial<DeepResearchConfig>, llmConfig?: OrchestratorLlmConfig) {
      this.config = normalizeConfig(config);
      const depth = this.config.defaultDepth;
      const profile = resolveBudgetProfile(depth, {
         maxTimeMs: this.config.maxTimeMs,
      });
      this.budget = new BudgetTracker(profile);
      this.state = new ResearchStateEngine(this.budget);
      this.progress = new ProgressTracker();
      this.llm = this.createLlmClient(llmConfig);
      this.pruning = new PruningEngine();
      this.compactor = new InFlightCompactor(this.state, this.budget);
   }

   /** Create LLM client when config is fully populated, else return undefined. */
   private createLlmClient(llmConfig?: OrchestratorLlmConfig): DeepResearchLlmClient | undefined {
      if (!llmConfig) return undefined;
      if (!llmConfig.baseUrl || !llmConfig.model) return undefined;

      const tokenBudget: TokenBudget = {
         recordTokens: (count: number) => {
            this.budget.recordTokens(count);
            return !this.budget.isExhausted();
         },
      };

      return new DeepResearchLlmClient(
         {
            baseUrl: llmConfig.baseUrl,
            model: llmConfig.model,
            workerModel: llmConfig.workerModel,
            ...(llmConfig.apiToken !== undefined ? { apiToken: llmConfig.apiToken } : {}),
         },
         tokenBudget,
      );
   }

   /** Build a fresh TokenBudget adapter wrapping the current budget tracker. */
   private makeTokenBudget(): TokenBudget {
      return {
         recordTokens: (count: number) => {
            this.budget.recordTokens(count);
            return !this.budget.isExhausted();
         },
      };
   }

   /**
    * Run the full research pipeline for a query.
    * @param abortSignal - Optional AbortSignal to cancel research externally (MCP cancellation).
    * @param onProgress - Optional callback invoked at phase boundaries with (percentage, message).
    * @param jobId - Optional job ID for adaptive timeout extension during gap filling.
    */
   async run(
      query: string,
      depth?: ResearchDepth,
      maxTimeMs?: number,
      _abortSignal?: AbortSignal,
      onProgress?: ProgressCallback,
      jobId?: string,
   ): Promise<ResearchResult> {
      const effectiveDepth = depth ?? this.config.defaultDepth;
      this.onProgress = onProgress ?? (() => {
         // Default empty callback
      });
      this.abortSignal = _abortSignal;
      await this.reportProgress(0, `Starting deep research: ${query.slice(0, 80)}`, 'initializing');
      // Build budget from effective depth and optional time override
      const maxTimeOverride =
         maxTimeMs && maxTimeMs < this.config.maxTimeMs ? { maxTimeMs } : undefined;
      const profile = resolveBudgetProfile(effectiveDepth, maxTimeOverride);
      this.budget = new BudgetTracker(profile);
      this.state.initialize(query, this.budget);

      // P8: Language detection
      try {
         const langProfile = await LanguageDetector.detect(query, this.llm);
         this.state.setLanguage(langProfile);
      } catch {
         this.state.setLanguage({ code: 'en', style: 'formal' });
      }

      const startTime = Date.now();

      logger.info({ query, depth: effectiveDepth }, 'Deep research started');

      try {
         // ── Phase 1: Decomposition (rule-based, always) ──────────────────────
         this.state.transitionTo('decomposition');
         logger.info('Phase 1: Decomposing query');

         const decomposer = new QueryDecomposer();
         const { classification, subQuestions, disambiguationNote, extractedEntities } = await decomposer.llmDecompose(query, this.llm ?? undefined, this.state);

         for (const sq of subQuestions) {
            // Phase 6: Set freshness intent based on query classification
            if (classification === 'current-events' || classification === 'market-ecosystem') {
               sq.freshnessIntent = 'recent';
            } else if (classification === 'historical-timeline') {
               sq.freshnessIntent = 'historical';
            } else {
               sq.freshnessIntent = 'any';
            }
            this.state.addSubQuestion(sq);
         }

         this.progress.decompositionComplete(classification, subQuestions);
         logger.info({ subQuestions: subQuestions.length, classification }, 'Query decomposed');
         await this.reportProgress(10, `Query decomposed: ${String(subQuestions.length)} sub-questions`, 'decomposition');

         // Budget check after phase 1
         if (this.budget.isExhausted()) {
            logger.warn('Budget exhausted after decomposition');
            return await this.synthesizePartial();
         }

         // ── Tree research path replaces Phases 2-5 for 'tree' depth ─────────
         const isTreeMode = effectiveDepth === 'tree';
         if (isTreeMode) {
            this.state.transitionTo('tree_research');
            logger.info('Phase Tree: Running breadth×depth tree research');
            const treeEngine = new DeepTreeResearchEngine({
               state: this.state,
               budget: this.budget,
               ...(this.llm !== undefined ? { llm: this.llm } : {}),
               onProgress: this.onProgress,
               contextWordLimit: this.config.treeContextWordLimit,
               ...(_abortSignal !== undefined ? { abortSignal: _abortSignal } : {}),
            });
            await treeEngine.run(
               query,
               this.config.treeBreadth,
               this.config.treeDepth,
               this.config.treeConcurrency,
            );
            logger.info(
               { sources: this.state.sourceCount(), findings: this.state.findingCount() },
               'Tree research complete, proceeding to audit/synthesis',
            );
            if (this.budget.isExhausted()) {
               logger.warn('Budget exhausted after tree research');
               return await this.synthesizePartial();
            }
         }
         if (!isTreeMode) {
            this.checkAborted();

            // ── V5.0.0: Worker Agent path when LLM is available ────────────
            if (this.llm) {
               const priorKnowledge = buildPriorKnowledge(disambiguationNote, extractedEntities);
               await this.runWorkerAgentPhase(subQuestions, effectiveDepth, priorKnowledge);
               // In-flight compaction after worker agent phase
               try { this.compactor.compact(); } catch (e) { logger.warn({ err: e }, 'Compaction after worker phase failed'); }
               if (this.budget.isExhausted()) {
                  logger.warn('Budget exhausted after worker agent phase');
                  return await this.synthesizePartial();
               }

               // ── Gap analysis retry loop ───────────────────────────────
               const maxLoops = this.budget.profile.maxGapLoops;
               const gapFiller = new GapFiller(this.state, this.budget);
               let skipExtension = false;

               for (let loopIdx = 0; loopIdx < maxLoops; loopIdx++) {
                  if (this.budget.isExhausted()) break;
                  this.checkAborted();

                  // Compute coverage and run enhanced gap analysis
                  const coverage = this.state.computeSubQuestionCoverage();
                  const contentQuality = this.state.getAllContentQuality();
                  const analyzer = new GapAnalyzer(this.state);
                  const gaps = analyzer.analyze(coverage, contentQuality);
                  this.progress.gapsIdentified(gaps);

                  const { filled, remaining } = await gapFiller.fillGaps(gaps);
                  logger.info(
                     { loop: loopIdx + 1, gaps: gaps.length, filled, remaining: remaining.length },
                     'Gap analysis loop',
                  );

                  // Check confidence plateau — stop if diminishing returns
                  if (this.budget.isConfidencePlateau(this.state.findingCount())) {
                     logger.info({ loop: loopIdx + 1 }, 'Confidence plateau detected, ending gap loop');
                     break;
                  }

                  // Stop if nothing left to chase
                  if (!gapFiller.shouldContinueLoop()) {
                     logger.info({ loop: loopIdx + 1 }, 'Gap filler stop heuristics met');
                     break;
                  }

                  // Follow-up for critical gaps (priority <= 2)
                  const criticalGaps = gaps.filter((g) => g.priority <= 2);
                  if (criticalGaps.length === 0) break;

                  // ── D3: Track findings before extension for progress check ──
                  const findingsBeforeExtension = this.state.findingCount();

                  // Extend job timeout for gap-fill work (skip if previous extension yielded too little)
                  const unansweredCount = criticalGaps.filter(
                     (g) => g.category === 'unanswered_sub_question',
                  ).length;
                  const extensionMs = unansweredCount * 120_000 + (criticalGaps.length - unansweredCount) * 60_000;
                  if (!skipExtension && jobId && extensionMs > 0) {
                     if (researchJobManager.extendRuntime(jobId, extensionMs)) {
                        this.budget.extendTimeBudget(extensionMs);
                     }
                  }
                  if (jobId) researchJobManager.incrementGapLoops(jobId);

                  // Progress: spread 50-60% across gap loops
                  const loopProgress = 50 + Math.round((loopIdx / maxLoops) * 10);
                  await this.reportProgress(
                     loopProgress,
                     `Gap loop ${String(loopIdx + 1)}/${String(maxLoops)}: investigating ${String(criticalGaps.length)} gap(s)`,
                     'gap_filling',
                  );

                  const followUpQuestions = criticalGaps.map((g) => g.description);
                  const followUpSubQuestions: SubQuestion[] = criticalGaps
                     .filter((g) => g.subQuestionId)
                     .map((g) => this.state.getSubQuestions().find((sq) => sq.id === g.subQuestionId))
                     .filter((sq): sq is SubQuestion => sq !== undefined);
                  await this.spawnWorkers(followUpQuestions, 'gap_fill', effectiveDepth, followUpSubQuestions);

                  // Record findings added this loop for confidence plateau detection
                  const findingsAfterLoop = this.state.findingCount();
                  this.budget.recordFindingsAddedThisLoop(
                     findingsAfterLoop - findingsBeforeExtension,
                  );

                  // ── D3: Progress check — skip further extensions if yield is too low ──
                  const findingsAdded = findingsAfterLoop - findingsBeforeExtension;
                  if (extensionMs > 0) {
                     const rate = findingsAdded / extensionMs;
                     if (rate < 0.001) {
                        logger.warn(
                           { findingsAdded, extensionMs, rate },
                           'Gap-fill yield below threshold, skipping further runtime extensions',
                        );
                        skipExtension = true;
                     }
                  }

                  // ── D2: Priority-based budget for low-priority gaps (3-5) ──────────
                  // Low-priority gaps are batched into a single web search pass without
                  // spawning full worker agents. This avoids the overhead of LLM worker
                  // orchestration for marginal topics while still attempting lightweight discovery.
                  const lowPriorityGaps = gaps.filter((g) => g.priority >= 3 && g.priority <= 5);
                  if (lowPriorityGaps.length > 0) {
                     const batchedQuery = lowPriorityGaps
                        .map((g) => g.description)
                        .join(' ');
                     const tools = createResearchTools({
                        onToolCall: (_tool, _query) => {
                           this.budget.recordToolCall();
                        },
                     });
                     await tools.webSearch(batchedQuery, 5);
                  }

                  // Pruning after gap loop
                  try {
                     this.pruning.enforceStateGuard(this.state, this.budget);
                     this.compactor.compact();
                  } catch (e) {
                     logger.warn({ err: e }, 'Pruning/compaction after gap loop failed');
                  }
               }

               await this.reportProgress(
                  60,
                  `Investigation complete: ${String(this.state.workerReportCount())} workers, ${String(this.state.findingCount())} findings`,
                  'gap_analysis',
                  {
                     sourceCount: this.state.sourceCount(),
                     findingCount: this.state.findingCount(),
                     subQuestionCount: this.state.getSubQuestions().length,
                  },
               );
            } else {
               // ── Phase 2: Discovery (tool-based, always) ──────────────────────────

               this.state.transitionTo('discovery');
               logger.info('Phase 2: Broad discovery');

               const discovery = new DiscoveryEngine(this.state, this.budget, undefined, this.llm);
               const candidates = await discovery.discover(subQuestions);

               const sqSourceCounts = subQuestions.map((sq) => ({
                  subQuestionId: sq.id,
                  count: this.state.getSources(sq.id).length,
               }));
               this.progress.sourcesDiscovered(sqSourceCounts);

               logger.info(
                  {
                     sources: this.state.sourceCount(),
                     candidates: candidates.length,
                  },
                  'Discovery complete',
               );

               await this.reportProgress(25, `Discovery complete: ${String(this.state.sourceCount())} sources`, 'discovery');

               // Pruning after discovery
               try {
                  this.pruning.evictSources(this.state, this.budget);
                  this.pruning.enforceStateGuard(this.state, this.budget);
               } catch (e) {
                  logger.warn({ err: e }, 'Pruning after discovery failed');
               }

               // Budget check after phase 2
               if (this.budget.isExhausted()) {
                  logger.warn('Budget exhausted after discovery');
                  return await this.synthesizePartial();
               }

               // ── Phase 1.5: Taxonomy revision (rule-based, always) ─────────────────
               if (!this.state.isTaxonomyRevised() && candidates.length > 0) {
                  const taxonomy = new TaxonomyRevision();
                  const { taxonomy: revisedTaxonomy } = taxonomy.revise(this.state.getTaxonomy(), candidates);
                  if (revisedTaxonomy.revised) {
                     this.state.reviseTaxonomy(revisedTaxonomy);
                     this.progress.taxonomyRevised(revisedTaxonomy);
                     logger.info('Taxonomy revised after early discovery');
                     await this.reportProgress(30, 'Taxonomy revised', 'taxonomy_revision');
                  }
               }

               // ── Phase 3: Extraction (rule-based only) ─────────────────────────────
               // LLM per-source extraction removed — all extraction is algorithmic via ExtractionEngine
               this.state.transitionTo('extraction');
               logger.info('Phase 3: Deep extraction (rule-based)');

               const extractionTargets = this.state.getTopSources(this.budget.profile.maxExtractions);
               if (extractionTargets.length > 0) {
                  const extraction = new ExtractionEngine(this.state, this.budget);
                  const findingIds = await extraction.extract(extractionTargets);
                  const findings: Finding[] = findingIds
                     .map((id) => this.state.getFinding(id))
                     .filter((f): f is Finding => f !== undefined);

                  this.progress.extractionProgress(extractionTargets.length, extractionTargets.length);
                  this.progress.findingsExtracted(findings);

                  logger.info(
                     { findings: findings.length, extracted: extractionTargets.length },
                     'Extraction complete',
                  );

                  await this.reportProgress(50, `Extraction complete: ${String(findings.length)} findings`, 'extraction');

                  // Pruning after extraction
                  try {
                     this.pruning.enforceStateGuard(this.state, this.budget);
                  } catch (e) {
                     logger.warn({ err: e }, 'Pruning after extraction failed');
                  }

                  // Budget check
                  if (this.budget.isExhausted()) {
                     logger.warn('Budget exhausted after extraction — going to synthesis');
                     return await this.synthesizePartial();
                  }

                  // ── Post-extraction processing ──
                  const postResults = this.state.postProcessFindings();
                  logger.info(
                     { merged: postResults.merged, contradictions: postResults.contradictions },
                     'Post-extraction processing complete',
                  );
                  this.progress.contradictionsFound(this.state.getUnresolvedContradictions());
               }
            } // close else (legacy pipeline)
         } // end if (!isTreeMode)

         // ── Phase 6: Audit (LLM + rule-based combined) ──────────────────────
         this.state.transitionTo('audit');
         logger.info('Phase 6: State audit');
         await this.reportProgress(65, 'Auditing research quality', 'audit');

         const auditor = new StateAuditor(this.state);
         const ruleAudit = auditor.audit();
         let mergedAuditReport = ruleAudit;

         if (this.llm) {
            try {
               const llmAudit = await this.auditState();
               if (llmAudit) {
                  // Merge: deduplicate issues by description
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
               logger.warn(
                  {
                     err: auditErr instanceof Error ? auditErr.message : String(auditErr),
                  },
                  'LLM audit failed; using rule-based audit only',
               );
            }
         }

         this.state.markAudited();

         if (!mergedAuditReport.passed) {
            const errors = mergedAuditReport.issues.filter((i) => i.severity === 'error');
            const warnings = mergedAuditReport.issues.filter((i) => i.severity === 'warning');
            if (errors.length > 0) {
               logger.warn({ errors: errors.length, warnings: warnings.length }, 'Audit found issues');
            }
         }

         logger.info(
            {
               passed: mergedAuditReport.passed,
               issues: mergedAuditReport.issues.length,
            },
            'Audit complete',
         );

         await this.reportProgress(90, 'Audit complete', 'audit');
         // P10: streaming action
         this.progress.reportAction('audit', 'Audit complete');

         // ── Detect contradictions ───────────────────────────────────────────
         const contradictions = this.state.detectContradictions();
         if (contradictions.length > 0) {
            this.progress.contradictionsFound(contradictions);
            logger.info({ contradictions: contradictions.length }, 'Contradictions detected');
         }

         // ── Phase 7: Synthesis (LLM or rule-based, terminal) ────────────────
         await this.reportProgress(95, 'Synthesizing research report', 'synthesis');
         const result = await this.synthesizeResults(
            startTime,
            mergedAuditReport.issues
               .filter((i) => i.severity === 'warning')
               .slice(0, 3)
               .map((i) => i.description),
         );

         // Pruning final cleanup (not in tree mode — tree engine handles its own state)
         if (!isTreeMode) {
            try {
               this.pruning.enforceStateGuard(this.state, this.budget);
               this.compactor.compact();
            } catch (e) {
               logger.warn({ err: e }, 'Pruning/compaction final cleanup failed');
            }
         }
         return result;
      } catch (err) {
         logger.error({ err }, 'Deep research failed');
         this.state.transitionTo('complete');

         // Return partial results if we have them
         if (this.report) {
            return {
               report: this.report,
               timeline: this.progress.getTimeline(),
            };
         }

         throw err;
      }
   }

   // ── V5.0.0: Worker Agent Methods ───────────────────────────────────────────

   /** Spawn worker agents for each sub-question and collect reports. */
   private async runWorkerAgentPhase(
      subQuestions: SubQuestion[],
      depth: string,
      priorKnowledge?: string,
   ): Promise<void> {
      this.state.transitionTo('discovery');
      logger.info({ subQuestions: subQuestions.length }, 'V5: Worker agent phase starting');
      await this.reportProgress(20, `Launching ${String(subQuestions.length)} worker agent(s)`, 'worker_investigation');

      await this.spawnWorkers(
         subQuestions.map((sq) => sq.text),
         'initial',
         depth,
         subQuestions,
         priorKnowledge,
      );

      logger.info(
         { reports: this.state.workerReportCount(), findings: this.state.findingCount() },
         'V5: Worker agent phase complete',
      );
   }

   /**
    * Spawn worker agents for a list of questions with concurrency control.
    * Findings are ingested into state at the end of this method.
    */
   private async spawnWorkers(
      questions: string[],
      _source: string,
      _depth: string,
      contextSubQuestions?: SubQuestion[],
      priorKnowledge?: string,
   ): Promise<void> {
      if (!this.llm) return;

      const tools = createResearchTools({
         onToolCall: (tool, query) => {
            this.budget.recordToolCall();
            logger.debug({ tool, query: query.slice(0, 60) }, `Worker tool: ${tool}`);
         },
      });

      const tokenBudget = this.makeTokenBudget();
      const concurrency = 3;

      for (let i = 0; i < questions.length; i += concurrency) {
         if (this.budget.isExhausted()) break;
         this.checkAborted();

         const batch = questions.slice(i, i + concurrency);
         const batchSubQuestions = contextSubQuestions?.slice(i, i + concurrency);
         const llm = this.llm;

         const workerPromises = batch.map(async (question, batchIdx) => {
            const worker = new WorkerAgent(llm, tools, tokenBudget);
            try {
               const parentId = batchSubQuestions?.[batchIdx]?.id;
               const report = await worker.investigate(question, {
                  ...(parentId !== undefined ? { parentSubQuestionId: parentId } : {}),
                  ...(contextSubQuestions !== undefined ? { subQuestions: contextSubQuestions } : {}),
                  ...(priorKnowledge !== undefined ? { priorKnowledge } : {}),
                  onProgress: (stage, detail) => {
                     // Fire-and-forget: surface worker sub-steps as progress messages
                     void this.reportProgress(
                        20 + Math.round((i / questions.length) * 30),
                        `[${stage}] ${detail}`,
                        'worker_investigation',
                     );
                  },
               });
               this.state.addWorkerReport(report);
               for (const [url, quality] of Object.entries(report.contentQuality)) {
                  this.state.setContentQuality(url, quality);
               }
               return report;
            } catch (err) {
               logger.warn({ err, question: question.slice(0, 60) }, 'Worker agent failed');
               return null;
            }
         });

         await Promise.allSettled(workerPromises);

         const completed = Math.min(i + batch.length, questions.length);
         // Spread worker progress from 20% to 50%
         const pct = 20 + Math.round((completed / questions.length) * 30);
         const firstQuestion = batch[0] ?? '';
         await this.reportProgress(
            pct,
            `Worker ${String(completed)}/${String(questions.length)}: ${firstQuestion.slice(0, 50)}`,
            'worker_investigation',
            {
               sourceCount: this.state.sourceCount(),
               findingCount: this.state.findingCount(),
               subQuestionCount: questions.length,
            },
         );
      }

      this.ingestWorkerReports();
   }

   /**
    * Convert worker report findings into the legacy Finding format.
    *
    * Phase 1 fix: Two-pass ingestion.
    * Pass 1 — ingest all WorkerReport.sources (preserving actual sourceType) before findings.
    * Pass 2 — ingest findings linking ALL sourceUrls, not just the first.
    */
   private ingestWorkerReports(): void {
      const reports = this.state.getAllWorkerReports();

      // ── Pass 1: Ingest all sources from every worker report ─────────────
      for (const report of reports) {
         for (const ws of report.sources) {
            this.ensureSourceExists(ws.url, report);
         }
      }

      // ── Pass 2: Ingest findings with all sourceUrls linked ──────────────
      let unattributedCount = 0;
      let inferredCount = 0;
      for (const report of reports) {
         for (const wf of report.findings) {
            // Track citation quality
            if (wf.citationConfidence === 'unattributed') unattributedCount++;
            else if (wf.citationConfidence === 'inferred') inferredCount++;

            // Resolve all source URLs to state source IDs
            const allSourceIds: string[] = [];
            const allSources = this.state.getSources();
            for (const url of wf.sourceUrls) {
               const existing = allSources.find((s) => s.url === url);
               if (existing) {
                  allSourceIds.push(existing.id);
               } else {
                  // Fallback: create a minimal source entry for unknown URLs
                  const fallbackId = this.ensureSourceExists(url, report);
                  allSourceIds.push(fallbackId);
               }
            }

            // Use the first source's quality for evidence directness
            const firstSourceQuality = wf.sourceUrls.length > 0
               ? report.contentQuality[wf.sourceUrls[0] ?? '']
               : undefined;

            this.state.addFinding({
               claim: wf.claim,
               normalizedClaim: wf.claim.toLowerCase().replace(/[^\w\s]/g, '').trim(),
               subQuestionIds: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
               sourceIds: [...new Set(allSourceIds)],
               evidenceSummary: wf.evidence,
               evidenceExcerpt: wf.evidence.slice(0, 500),
               evidenceDirectness: this.deriveEvidenceDirectness(wf, firstSourceQuality),
               // Surface citation confidence in caveats when unattributed/inferred
               ...(wf.caveats !== undefined ? { caveats: wf.caveats } : {}),
               ...(wf.citationConfidence === 'unattributed'
                  ? { caveats: (wf.caveats ? wf.caveats + ' ' : '') + '[Citation: unattributed — no source could be verified for this claim]' }
                  : wf.citationConfidence === 'inferred'
                     ? { caveats: (wf.caveats ? wf.caveats + ' ' : '') + '[Citation: inferred — source mapping may be imprecise]' }
                     : {}),
               freshnessSensitive: false,
               lastUpdated: new Date().toISOString(),
               claimType: 'primary' as const,
            });
         }
      }

      // Surface citation quality issues as open questions for the report
      if (unattributedCount > 0) {
         this.state.addOpenQuestion(
            `${String(unattributedCount)} finding(s) have unattributed citations — claims could not be verified against any source. Treat these claims as low-confidence.`,
         );
      }
      if (inferredCount > 0) {
         this.state.addOpenQuestion(
            `${String(inferredCount)} finding(s) have inferred citations — source mapping was estimated rather than explicitly provided. Verify before relying on these claims.`,
         );
      }
   }

   /**
    * Ensure a source entry exists for a URL. Returns the source ID.
    *
    * Phase 1 fix: Uses actual sourceType from WorkerReport.sources instead of
    * hard-coding 'web'. Falls back to the report's first matching source, then
    * to 'web' only if no metadata is available.
    */
   private ensureSourceExists(url: string, report: WorkerReport): string {
      if (!url) return `src-${report.id}`;
      const existingSources = this.state.getSources();
      const existing = existingSources.find((s) => s.url === url);
      if (existing) return existing.id;

      // Look up real source type from the worker report's sources
      const wsEntry = report.sources.find((s) => s.url === url);
      const sourceType: SourceType = wsEntry?.sourceType ?? 'web';
      const sourceId = `src-${url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(Date.now())}`;

      this.state.addSource({
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

   /** Derive evidenceDirectness from worker finding + content quality. */
   private deriveEvidenceDirectness(
      _wf: import('./types.js').WorkerFinding,
      quality: import('./types.js').ContentQualityAssessment | undefined,
   ): import('./types.js').EvidenceDirectness {
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

   // ── Private helpers ─────────────────────────────────────────────────────────







   // ── LLM evaluate / decide / audit methods ─────────────────────────────────





   /**
    * Call the orchestrator LLM with ORCHESTRATOR_AUDIT to surface subtle
    * quality issues the rule-based auditor might miss.
    */
   private async auditState(): Promise<AuditReport | undefined> {
      if (!this.llm) return undefined;

      const summary = this.buildStateSummary();

      // Use a record-compatible shape for the JSON response to avoid
      // importing AuditReport full type in the strict mode pass-through.
      type LlmAuditResponse = Record<string, unknown>;

      const result = await this.llm.callJSONWithFallback<LlmAuditResponse>({
         messages: [
            { role: 'system' as const, content: ORCHESTRATOR_AUDIT },
            {
               role: 'user' as const,
               content: `Research state to audit:\n${summary}`,
            },
         ],
         temperature: 0.3,
      });

      if (!result.success) {
         logger.warn({ error: result.response.error }, 'LLM audit call failed');
         return undefined;
      }

      const data = result.data as unknown as AuditReport;
      if (!Array.isArray(data.issues)) {
         logger.warn({ data: JSON.stringify(data).slice(0, 200) }, 'LLM audit returned unexpected shape');
         return undefined;
      }

      return data;
   }

   // ── State summary ─────────────────────────────────────────────────────────

   /**
    * Build a compact JSON-serialized summary of the current research state
    * for LLM consumption.
    */
   private buildStateSummary(): string {
      const state = this.state.getState();

      const summary: Record<string, unknown> = {
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

   // ── Report progress ──────────────────────────────────────────────────────

   /** Throw if the abort signal has been fired. */
   private checkAborted(): void {
      if (this.abortSignal?.aborted) {
         throw new DOMException('Research cancelled', 'AbortError');
      }
   }

   /**
    * Surface percentage + message + optional phase + optional bounded partials
    * via the onProgress callback. Clamped to 0-100.
    * When phase is provided the downstream handler uses it directly
    * instead of deriving from the progress percentage.
    */
   private async reportProgress(
      progress: number,
      message?: string,
      phase?: string,
      partials?: {
         sourceCount?: number;
         findingCount?: number;
         subQuestionCount?: number;
         classification?: string;
      },
   ): Promise<void> {
      const clamped = Math.max(0, Math.min(100, progress));
      try {
         await this.onProgress(clamped, message, phase, partials);
      } catch {
         // Callback errors are non-fatal
      }
   }

   // ── Synthesis ──────────────────────────────────────────────────────────────

   /**
    * Run LLM or rule-based synthesis with the accumulated research state.
    */
   private async synthesizeResults(
      startTime: number,
      _auditWarnings: string[],
   ): Promise<ResearchResult> {
      this.state.transitionTo('synthesis');
      this.progress.reportAction('synthesize', 'Generating synthesis report');

      try {
         const state = this.state.getState();

         let report: ResearchReport;

         if (this.llm) {
            const llmSynth = new LlmSynthesizer(this.llm);
            report = await llmSynth.synthesize(state);
         } else {
            report = new ResearchSynthesizer(state).synthesize();
         }

         this.report = report;

         // Validate citation URLs (Phase F: URL health)
         try {
            const allUrls = state.sources.map((s) => s.url);
            if (allUrls.length > 0) {
               const urlResults = await validateUrls(allUrls);
               const hallucinated = urlResults.filter((r) => r.status === 'LIKELY_HALLUCINATED');
               const dead = urlResults.filter((r) => r.status === 'DEAD');
               const live = urlResults.filter((r) => r.status === 'LIVE');
               logger.info({ live: live.length, dead: dead.length, hallucinated: hallucinated.length }, 'Citation URL validation complete');

               // Annotate hallucinated sources in report
               if (hallucinated.length > 0) {
                  const urls = hallucinated.map((r) => r.url).join(', ');
                  report.openQuestions.push(
                     `${hallucinated.length} cited URL(s) could not be verified and may be hallucinated. Unverified URLs: ${urls}`,
                  );
               }
               if (dead.length > 0) {
                  const deadUrls = dead.map((r) => r.url).join(', ');
                  report.sourceNotes.push(
                     `${dead.length} cited URL(s) appear to be dead (no longer accessible): ${deadUrls}`,
                  );
               }
            }
         } catch (e) {
            logger.warn({ err: e }, 'Citation URL validation failed');
         }

         this.state.transitionTo('complete');
         this.progress.researchComplete();

         const elapsed = Date.now() - startTime;
         logger.info({ elapsedMs: elapsed, findings: report.findingCount }, 'Deep research complete');
         await this.reportProgress(100, 'Deep research complete', 'complete');

         return {
            report,
            timeline: this.progress.getTimeline(),
         };
      } catch (synthErr) {
         logger.error({ err: synthErr }, 'Synthesis failed; returning partial results');

         // Return whatever state we have
         const state = this.state.getState();
         const partialReport = new ResearchSynthesizer(state).synthesize();

         return {
            report: partialReport,
            timeline: this.progress.getTimeline(),
         };
      }
   }

   /**
    * Quick partial synthesis when budget is exhausted mid-research.
    * Returns whatever findings have been accumulated so far.
    */
   private async synthesizePartial(): Promise<ResearchResult> {
      const state = this.state.getState();
      const report = new ResearchSynthesizer(state).synthesize();

      logger.info(
         {
            sources: state.sources.length,
            findings: state.findings.length,
         },
         'Partial synthesis (budget exhausted)',
      );

      return {
         report,
         timeline: this.progress.getTimeline(),
      };
   }
}
