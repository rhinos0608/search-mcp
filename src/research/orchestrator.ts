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
import { GapAnalyzer, GapFiller, FailureAnalyzer } from './gapAnalysis.js';
import { StateAuditor } from './audit.js';
import { ResearchSynthesizer } from './synthesizer.js';
import { ProgressTracker } from './progress.js';
import { DeepResearchLlmClient, type TokenBudget } from './llm/chat.js';
import { ORCHESTRATOR_EVALUATE, ORCHESTRATOR_DECIDE, ORCHESTRATOR_AUDIT } from './llm/prompts.js';
import { LlmExtractor } from './llm/extractor.js';
import { LlmSynthesizer } from './llm/synthesis.js';
import { LanguageDetector } from './language.js';
import { DeepTreeResearchEngine } from './treeEngine.js';
import type {
   ResearchDepth,
   ResearchResult,
   ResearchReport,
   Finding,
   GapRecord,
   AuditReport,
} from './types.js';
import type { DeepResearchConfig } from '../config.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OrchestratorLlmConfig {
   baseUrl: string;
   model: string;
   workerModel: string;
   apiToken?: string;
}

/** Progress notification callback. */
export type ProgressCallback = (progress: number, message?: string) => void | Promise<void>;

interface OrchestratorDecision {
   action: string;
   reasoning?: string;
   priority?: number;
   subQuestionIds?: string[];
}

interface OrchestratorEvaluation {
   evaluation: string;
   strengths: string[];
   weaknesses: string[];
   missingDimensions: string[];
   confidenceAssessment: string;
}

/** P2: Action gates that restrict which actions the LLM can choose. */
interface ActionGates {
   allowAnswer: boolean;
   allowSearch: boolean;
   allowExtract: boolean;
   allowDiscover: boolean;
}

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

function normalizeConfig(cfg?: DeepResearchConfig): Required<DeepResearchConfig> {
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

export class ResearchOrchestrator {
   private state: ResearchStateEngine;
   private budget: BudgetTracker;
   private progress: ProgressTracker;
   private config: Required<DeepResearchConfig>;
   private llm: DeepResearchLlmClient | undefined;
   private report: ResearchReport | null = null;
   /**
    * Optional progress callback, set by run().
    */
   private onProgress: ProgressCallback = () => { };

   constructor(config?: DeepResearchConfig, llmConfig?: OrchestratorLlmConfig) {
      this.config = normalizeConfig(config);
      const depth = this.config.defaultDepth;
      const profile = resolveBudgetProfile(depth, {
         maxTimeMs: this.config.maxTimeMs,
      });
      this.budget = new BudgetTracker(profile);
      this.state = new ResearchStateEngine(this.budget);
      this.progress = new ProgressTracker();
      this.llm = this.createLlmClient(llmConfig);
   }

   /** Create LLM client when config is fully populated, else return undefined. */
   private createLlmClient(llmConfig?: OrchestratorLlmConfig): DeepResearchLlmClient | undefined {
      if (!llmConfig) return undefined;
      if (!llmConfig.baseUrl || !llmConfig.model) return undefined;

      const tokenBudget: TokenBudget = {
         recordTokens: (count: number) => {
            if (!this.budget) return true;
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
            if (!this.budget) return true;
            this.budget.recordTokens(count);
            return !this.budget.isExhausted();
         },
      };
   }

   /**
    * Run the full research pipeline for a query.
    * @param abortSignal - Optional AbortSignal to cancel research externally (MCP cancellation).
    * @param onProgress - Optional callback invoked at phase boundaries with (percentage, message).
    */
   async run(
      query: string,
      depth?: ResearchDepth,
      maxTimeMs?: number,
      _abortSignal?: AbortSignal,
      onProgress?: ProgressCallback,
   ): Promise<ResearchResult> {
      const effectiveDepth = depth ?? this.config.defaultDepth;
      this.onProgress = onProgress ?? (() => { });
      // abortSignal is not read in this version — reserved for future use
      await this.reportProgress(0, `Starting deep research: ${query.slice(0, 80)}`);
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
         const { classification, subQuestions } = await decomposer.llmDecompose(query, this.llm ?? undefined, this.state);

         for (const sq of subQuestions) {
            this.state.addSubQuestion(sq);
         }

         this.progress.decompositionComplete(classification, subQuestions);
         logger.info({ subQuestions: subQuestions.length, classification }, 'Query decomposed');
         await this.reportProgress(10, `Query decomposed: ${subQuestions.length} sub-questions`);

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

            await this.reportProgress(25, `Discovery complete: ${this.state.sourceCount()} sources`);
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
                  await this.reportProgress(30, 'Taxonomy revised');
               }
            }

            // ── Phase 3: Extraction (LLM or rule-based) ──────────────────────────
            this.state.transitionTo('extraction');
            logger.info('Phase 3: Deep extraction');

            const extractionTargets = this.state.getTopSources(this.budget.profile.maxExtractions);

            let findingIds: string[] = [];
            if (this.llm && extractionTargets.length > 0) {
               // LLM-based extraction
               const llmExtractor = new LlmExtractor(this.llm, this.state, this.makeTokenBudget());
               findingIds = await llmExtractor.extract(extractionTargets, this.state.getSubQuestions());
            } else if (extractionTargets.length > 0) {
               // Rule-based extraction
               const extraction = new ExtractionEngine(this.state, this.budget);
               findingIds = await extraction.extract(extractionTargets);
            }

            const findings: Finding[] = findingIds
               .map((id) => this.state.getFinding(id))
               .filter((f): f is Finding => f !== undefined);

            this.progress.extractionProgress(extractionTargets.length, extractionTargets.length);
            this.progress.findingsExtracted(findings);

            logger.info(
               { findings: findings.length, extracted: extractionTargets.length },
               'Extraction complete',
            );

            await this.reportProgress(50, `Extraction complete: ${findings.length} findings`);
            // Budget check before the EDA loop
            if (this.budget.isExhausted()) {
               logger.warn('Budget exhausted after extraction — going to synthesis');
               return await this.synthesizePartial();
            }
            // ── Post-extraction processing: dedup, merge, cross-source confidence, contradictions ──
            const postResults = this.state.postProcessFindings();
            logger.info(
               { merged: postResults.merged, contradictions: postResults.contradictions },
               'Post-extraction processing complete',
            );
            this.progress.contradictionsFound(this.state.getUnresolvedContradictions());

            // ── EVALUATE-DECIDE-ACT LOOP ─────────────────────────────────────────
            this.state.transitionTo('gap_analysis');
            logger.info('Starting Evaluate-Decide-Act loop');

            let loopCount = 0;
            const maxLoops = this.budget.profile.maxGapLoops;
            let gaps: GapRecord[] = [];
            let currentGapTarget: string | undefined;
            let answerFailed = false;
            let lastEvaluation: OrchestratorEvaluation | undefined;
            const gates: ActionGates = {
               allowAnswer: true,
               allowSearch: true,
               allowExtract: true,
               allowDiscover: true,
            };

            while (loopCount < maxLoops && !this.budget.isExhausted()) {
               // ── EVALUATE ─────────────────────────────────────────────────────
               // Always run rule-based GapAnalyzer
               const analyzer = new GapAnalyzer(this.state);
               gaps = analyzer.analyze();

               // P1: Enqueue gap targets for targeted research in subsequent loops
               for (const gap of gaps) {
                  this.state.addGapTarget(gap.description, gap.subQuestionId);
               }

               // P1: FIFO gap queue — pop next gap target
               currentGapTarget = this.state.popNextGapTarget();

               // Optionally run LLM evaluation
               let evaluation: OrchestratorEvaluation | undefined;
               if (this.llm) {
                  try {
                     evaluation = await this.evaluateState();
                  } catch (evalErr) {
                     logger.warn(
                        { err: evalErr instanceof Error ? evalErr.message : String(evalErr) },
                        'LLM evaluation failed; continuing with rule-based gaps',
                     );
                  }
               }

               // P10: streaming action event
               this.progress.reportAction('evaluate', `Evaluated state at loop ${loopCount + 1}`);

               if (evaluation) {
                  lastEvaluation = evaluation;
               }

               const hasGaps = gaps.length > 0;
               const hasEvalIssues =
                  evaluation !== undefined &&
                  (evaluation.weaknesses.length > 0 || evaluation.missingDimensions.length > 0);

               // If no gaps found and no issues from evaluation → break to audit
               if (!hasGaps && !hasEvalIssues) {
                  logger.info('No gaps or issues found — breaking to audit');
                  break;
               }

               this.progress.gapsIdentified(gaps);

               // ── DECIDE ───────────────────────────────────────────────────────
               let decision: OrchestratorDecision;

               if (this.llm) {
                  try {
                     const llmDecision = await this.decideAction(evaluation, gates);
                     decision = llmDecision ?? { action: 'audit' };
                  } catch (decErr) {
                     logger.warn(
                        { err: decErr instanceof Error ? decErr.message : String(decErr) },
                        'LLM decide failed; falling back to rule-based decision',
                     );
                     decision = this.ruleBasedDecision(gaps, gates);
                  }
               } else {
                  decision = this.ruleBasedDecision(gaps, gates);
               }

               logger.info(
                  {
                     action: decision.action,
                     loop: loopCount + 1,
                     priority: decision.priority,
                  },
                  'EDA loop decision',
               );

               // ── ACT ──────────────────────────────────────────────────────────
               // Terminal actions → break to audit
               if (
                  decision.action === 'complete' ||
                  decision.action === 'synthesize' ||
                  decision.action === 'audit'
               ) {
                  logger.info({ action: decision.action }, 'Terminal action — breaking to audit');
                  break;
               }

               if (decision.action === 'extract') {
                  this.progress.reportAction('extract', `Extracting pending sources at loop ${loopCount + 1}`);
                  await this.extractPendingSources();
               } else if (decision.action === 'fill_gaps') {
                  this.progress.reportAction('search', `Filling gaps at loop ${loopCount + 1}`);
                  const filler = new GapFiller(this.state, this.budget);
                  await filler.fillGaps(gaps);

                  // P6: Failure analysis when answer fails
                  if (answerFailed && lastEvaluation) {
                     const failureAnalyzer = new FailureAnalyzer(this.llm);
                     const analysis = await failureAnalyzer.analyzeFailure(
                        currentGapTarget ?? 'unknown',
                        lastEvaluation.evaluation,
                        JSON.stringify(lastEvaluation),
                     );
                     logger.info({ analysis }, 'Failure analysis completed');
                     answerFailed = false;
                  }

                  // Re-run discovery for gap-related sub-questions
                  const gapSubQuestionIds = this.collectGapSubQuestionIds(gaps);
                  const gapSubQuestions = this.state
                     .getSubQuestions()
                     .filter((sq) => gapSubQuestionIds.has(sq.id));

                  if (gapSubQuestions.length > 0) {
                     const gapDiscovery = new DiscoveryEngine(this.state, this.budget, undefined, this.llm);
                     await gapDiscovery.discover(gapSubQuestions);
                  }

                  // Extract from new pending sources
                  await this.extractPendingSources();

                  // P6: Mark for failure analysis if gaps persist after fill_gaps work
                  if (this.state.getOpenGaps().length > 0) {
                     answerFailed = true;
                  }

                  // P2: Action gating — disable answer after gap fill
                  gates.allowAnswer = false;

                  // Check stop heuristics
                  if (!filler.shouldContinueLoop()) {
                     logger.info('GapFiller stop condition met — ending loop');
                     break;
                  }
               } else if (decision.action === 'contradiction_scan') {
                  this.state.detectContradictions();
                  logger.info('Contradiction scan complete');
               } else if (decision.action === 'discover') {
                  this.progress.reportAction('search', `Discovering new sources at loop ${loopCount + 1}`);
                  const targetIds = decision.subQuestionIds
                     ? new Set(decision.subQuestionIds)
                     : this.collectLowCoverageSubQuestionIds();

                  const targetSubQuestions = this.state
                     .getSubQuestions()
                     .filter((sq) => targetIds.has(sq.id));

                  if (targetSubQuestions.length > 0) {
                     const gapDiscovery = new DiscoveryEngine(this.state, this.budget, undefined, this.llm);
                     await gapDiscovery.discover(targetSubQuestions);

                     // Extract any new pending sources
                     await this.extractPendingSources();
                  }

                  // P2: Action gating — limit repeated discovery
                  if (this.state.sourceCount() >= 50) {
                     gates.allowDiscover = false;
                     gates.allowSearch = false;
                  }
               }

               // ── Update State ────────────────────────────────────────────────
               this.state.incrementLoop();
               loopCount++;
               const edaPct = Math.min(85, 55 + Math.round((loopCount / maxLoops) * 30));
               await this.reportProgress(edaPct, `EDA loop: ${loopCount}/${maxLoops}`);

               // P7: Diary — human-readable step log
               this.state.appendDiary(
                  `Step ${loopCount}: Took **${decision.action}** action. ` +
                  `Gaps: ${gaps.length}. Pending gap targets: ${this.state.hasPendingGapTargets() ? 'yes' : 'no'}`,
               );
            }

            logger.info({ loopsExecuted: loopCount, maxLoops }, 'EDA loop complete');

         } // end if (!isTreeMode)

         // ── Phase 6: Audit (LLM + rule-based combined) ──────────────────────
         this.state.transitionTo('audit');
         logger.info('Phase 6: State audit');

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

         await this.reportProgress(90, 'Audit complete');
         // P10: streaming action
         this.progress.reportAction('audit', 'Audit complete');

         // ── Detect contradictions ───────────────────────────────────────────
         const contradictions = this.state.detectContradictions();
         if (contradictions.length > 0) {
            this.progress.contradictionsFound(contradictions);
            logger.info({ contradictions: contradictions.length }, 'Contradictions detected');
         }

         // ── Phase 7: Synthesis (LLM or rule-based, terminal) ────────────────
         return await this.synthesizeResults(
            startTime,
            mergedAuditReport.issues
               .filter((i) => i.severity === 'warning')
               .slice(0, 3)
               .map((i) => i.description),
         );
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

   // ── Private helpers ─────────────────────────────────────────────────────────

   /** Rule-based decision as fallback when LLM is not configured or fails. */
   private ruleBasedDecision(gaps: GapRecord[], gates?: ActionGates): OrchestratorDecision {
      if (gates && !gates.allowAnswer) {
         if (gaps.length > 0 && gates.allowDiscover) {
            return { action: 'discover' };
         }
         return { action: 'audit' };
      }
      if (gaps.length > 0) {
         return { action: 'fill_gaps' };
      }
      if (this.state.getUnresolvedContradictions().length > 0) {
         return { action: 'contradiction_scan' };
      }
      return { action: 'audit' };
   }

   /** Extract pending sources using configured extractor. */
   private async extractPendingSources(): Promise<void> {
      const pendingSources = this.state.getTopSources(this.budget.profile.maxExtractions);
      if (pendingSources.length === 0) return;

      if (this.llm) {
         const llmExtractor = new LlmExtractor(this.llm, this.state, this.makeTokenBudget());
         const newIds = await llmExtractor.extract(pendingSources, this.state.getSubQuestions());
         const newFindings: Finding[] = newIds
            .map((id) => this.state.getFinding(id))
            .filter((f): f is Finding => f !== undefined);
         if (newFindings.length > 0) {
            this.progress.findingsExtracted(newFindings);
         }
      } else {
         const extraction = new ExtractionEngine(this.state, this.budget);
         const ids = await extraction.extract(pendingSources);
         const newFindings: Finding[] = ids
            .map((id) => this.state.getFinding(id))
            .filter((f): f is Finding => f !== undefined);
         if (newFindings.length > 0) {
            this.progress.findingsExtracted(newFindings);
         }
      }
   }

   /** Collect unique sub-question IDs referenced by an array of gaps. */
   private collectGapSubQuestionIds(gaps: GapRecord[]): Set<string> {
      const ids = new Set<string>();
      for (const gap of gaps) {
         if (gap.subQuestionId) ids.add(gap.subQuestionId);
      }
      return ids;
   }

   /**
    * Collect sub-question IDs that have low coverage (pending or low_confidence
    * status) for targeted discovery.
    */
   private collectLowCoverageSubQuestionIds(): Set<string> {
      const targetStatuses = new Set<string>(['pending', 'low_confidence']);
      const ids = new Set<string>();
      for (const sq of this.state.getSubQuestions()) {
         if (targetStatuses.has(sq.status)) {
            ids.add(sq.id);
         }
      }
      return ids;
   }

   // ── LLM evaluate / decide / audit methods ─────────────────────────────────

   /**
    * Call the orchestrator LLM with ORCHESTRATOR_EVALUATE to assess research
    * state quality and completeness.
    */
   private async evaluateState(): Promise<OrchestratorEvaluation | undefined> {
      if (!this.llm) return undefined;

      const summary = this.buildStateSummary();
      const result = await this.llm.callJSONWithFallback<OrchestratorEvaluation>({
         messages: [
            { role: 'system' as const, content: ORCHESTRATOR_EVALUATE },
            {
               role: 'user' as const,
               content: `Current research state:\n${summary}`,
            },
         ],
         temperature: 0.3,
      });

      if (!result.success) {
         logger.warn({ error: result.response.error }, 'LLM evaluate call failed');
         return undefined;
      }

      return result.data;
   }

   /**
    * Call the orchestrator LLM with ORCHESTRATOR_DECIDE to decide the next
    * action in the EDA loop.
    */
   private async decideAction(
      evaluation?: OrchestratorEvaluation,
      gates?: ActionGates,
   ): Promise<OrchestratorDecision | undefined> {
      if (!this.llm) return undefined;

      const summary = this.buildStateSummary();
      const evaluationText = evaluation
         ? `Evaluator's assessment:\n${JSON.stringify(evaluation, null, 2)}`
         : 'No evaluator assessment available.';

      // Build action restriction string (P2: Action Gating)
      let actionRestriction = '';
      if (gates) {
         const available: string[] = [];
         if (gates.allowAnswer) available.push('fill_gaps');
         if (gates.allowDiscover) available.push('discover');
         if (gates.allowExtract) available.push('extract');
         if (gates.allowSearch) available.push('search');
         available.push('audit', 'synthesize', 'complete');
         actionRestriction = `\n\nRESTRICTED ACTIONS — only choose from: ${available.join(', ')}`;
      }

      const userContent = `Current research state:\n${summary}\n\n${evaluationText}${actionRestriction}`;

      const result = await this.llm.callJSONWithFallback<OrchestratorDecision>({
         messages: [
            { role: 'system' as const, content: ORCHESTRATOR_DECIDE },
            {
               role: 'user' as const,
               content: userContent,
            },
         ],
         temperature: 0.3,
      });

      if (!result.success) {
         logger.warn({ error: result.response.error }, 'LLM decide call failed');
         return undefined;
      }

      return result.data;
   }

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
      if (!data.issues || !Array.isArray(data.issues)) {
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
      const confidenceDist = this.computeConfidenceDistribution(state.findings);

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
            confidence: f.confidence,
            confidenceLabel: f.confidenceLabel,
            evidenceDirectness: f.evidenceDirectness,
            sourceCount: f.sourceIds.length,
            corroborationCount: f.corroboratingSourceIds.length,
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

   // ── Report progress ──────────────────────────────────────────────────────

   /**
    * Surface percentage + message via the onProgress callback.
    * Clamped to 0-100.
    */
   private async reportProgress(progress: number, message?: string): Promise<void> {
      const clamped = Math.max(0, Math.min(100, progress));
      try {
         await this.onProgress(clamped, message);
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
         this.state.transitionTo('complete');
         this.progress.researchComplete();

         const elapsed = Date.now() - startTime;
         logger.info({ elapsedMs: elapsed, findings: report.findingCount }, 'Deep research complete');
         await this.reportProgress(100, 'Deep research complete');

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
