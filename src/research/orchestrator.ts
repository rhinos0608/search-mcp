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

/** Progress notification callback. */
export type ProgressCallback = (progress: number, message?: string) => void | Promise<void>;

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

function normalizeConfig(cfg?: DeepResearchConfig): Required<DeepResearchConfig> {
   if (!cfg) return DEFAULT_CONFIG;
   return {
      enabled: cfg.enabled,
      defaultDepth: cfg.defaultDepth,
      maxDepth: cfg.maxDepth,
      maxToolCalls: cfg.maxToolCalls,
      maxTokens: cfg.maxTokens,
      maxTimeMs: cfg.maxTimeMs,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      workerModel: cfg.workerModel,
      apiToken: cfg.apiToken,
      treeBreadth: cfg.treeBreadth,
      treeDepth: cfg.treeDepth,
      treeConcurrency: cfg.treeConcurrency,
      treeContextWordLimit: cfg.treeContextWordLimit,
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
   private onProgress: ProgressCallback = () => {
      // Default empty callback
   };

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
    */
   async run(
      query: string,
      depth?: ResearchDepth,
      maxTimeMs?: number,
      _abortSignal?: AbortSignal,
      onProgress?: ProgressCallback,
   ): Promise<ResearchResult> {
      const effectiveDepth = depth ?? this.config.defaultDepth;
      this.onProgress = onProgress ?? (() => {
         // Default empty callback
      });
      this.abortSignal = _abortSignal;
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
         const { classification, subQuestions, disambiguationNote, extractedEntities } = await decomposer.llmDecompose(query, this.llm ?? undefined, this.state);

         for (const sq of subQuestions) {
            this.state.addSubQuestion(sq);
         }

         this.progress.decompositionComplete(classification, subQuestions);
         logger.info({ subQuestions: subQuestions.length, classification }, 'Query decomposed');
         await this.reportProgress(10, `Query decomposed: ${String(subQuestions.length)} sub-questions`);

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
               if (this.budget.isExhausted()) {
                  logger.warn('Budget exhausted after worker agent phase');
                  return await this.synthesizePartial();
               }

               // Compute coverage and run enhanced gap analysis
               const coverage = this.state.computeSubQuestionCoverage();
               const contentQuality = this.state.getAllContentQuality();
               const analyzer = new GapAnalyzer(this.state);
               const gaps = analyzer.analyze(coverage, contentQuality);
               this.progress.gapsIdentified(gaps);
               logger.info({ gaps: gaps.length }, 'Enhanced gap analysis complete');

               // Follow-up for critical gaps
               const criticalGaps = gaps.filter((g) => g.priority <= 2);
               if (criticalGaps.length > 0 && !this.budget.isExhausted()) {
                  await this.reportProgress(55, `Investigating ${String(criticalGaps.length)} critical gap(s)`);
                  const followUpQuestions = criticalGaps.map((g) => g.description);
                  const followUpSubQuestions: SubQuestion[] = criticalGaps
                     .filter((g) => g.subQuestionId)
                     .map((g) => this.state.getSubQuestions().find((sq) => sq.id === g.subQuestionId))
                     .filter((sq): sq is SubQuestion => sq !== undefined);
                  await this.spawnWorkers(followUpQuestions, 'gap_fill', effectiveDepth, followUpSubQuestions);
                  this.state.computeSubQuestionCoverage();
               }

               await this.reportProgress(60, `Investigation complete: ${String(this.state.workerReportCount())} workers, ${String(this.state.findingCount())} findings`);
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

               await this.reportProgress(25, `Discovery complete: ${String(this.state.sourceCount())} sources`);
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

                  await this.reportProgress(50, `Extraction complete: ${String(findings.length)} findings`);

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

   // ── V5.0.0: Worker Agent Methods ───────────────────────────────────────────

   /** Spawn worker agents for each sub-question and collect reports. */
   private async runWorkerAgentPhase(
      subQuestions: SubQuestion[],
      depth: string,
      priorKnowledge?: string,
   ): Promise<void> {
      this.state.transitionTo('discovery');
      logger.info({ subQuestions: subQuestions.length }, 'V5: Worker agent phase starting');
      await this.reportProgress(20, `Launching ${String(subQuestions.length)} worker agent(s)`);

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

         const pct = 20 + Math.round(((i + batch.length) / questions.length) * 20);
         await this.reportProgress(pct, `Workers: ${String(Math.min(i + batch.length, questions.length))}/${String(questions.length)} complete`);
      }

      this.ingestWorkerReports();
   }

   /** Convert worker report findings into the legacy Finding format. */
   private ingestWorkerReports(): void {
      const reports = this.state.getAllWorkerReports();
      for (const report of reports) {
         for (const wf of report.findings) {
            const sourceId = this.ensureSourceExists(wf.sourceUrls[0] ?? '', report);
            this.state.addFinding({
               claim: wf.claim,
               normalizedClaim: wf.claim.toLowerCase().replace(/[^\w\s]/g, '').trim(),
               subQuestionIds: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
               sourceIds: wf.sourceUrls.length > 0 ? [sourceId] : [],
               evidenceSummary: wf.evidence,
               evidenceExcerpt: wf.evidence.slice(0, 500),
               evidenceDirectness: this.deriveEvidenceDirectness(wf, report.contentQuality[wf.sourceUrls[0] ?? '']),

               ...(wf.caveats !== undefined ? { caveats: wf.caveats } : {}),
               freshnessSensitive: false,
               lastUpdated: new Date().toISOString(),
               claimType: 'primary' as const,
            });
         }
      }
   }

   /** Ensure a source entry exists for a URL. Returns the source ID. */
   private ensureSourceExists(url: string, report: WorkerReport): string {
      if (!url) return `src-${report.id}`;
      const existingSources = this.state.getSources();
      const existing = existingSources.find((s) => s.url === url);
      if (existing) return existing.id;

      const sourceType: SourceType = 'web';
      const sourceId = `src-${url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(Date.now())}`;

      this.state.addSource({
         id: sourceId,
         title: report.sources.find((s) => s.url === url)?.title ?? url,
         url,
         sourceType,

         domain: this.extractDomain(url),
         isPrimary: false,
         relevantSubQuestions: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
         extractionStatus: 'extracted',
         accessDate: new Date().toISOString(),
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
