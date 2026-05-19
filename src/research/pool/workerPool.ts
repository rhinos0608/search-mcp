/**
 * WorkerPoolManager — shared worker agent spawning with concurrency control and budget tracking.
 *
 * Extracted from PipelineStrategy.spawnWorkers() lines 699-801.
 * Used by both PipelineStrategy and AgentStrategy.
 */

import { logger } from '../../logger.js';
import type { StrategyContext } from '../strategies/types.js';
import type { SubQuestion, WorkerReport, WorkerFinding } from '../types.js';
import { createResearchTools } from '../researchTools.js';
import {
  classifySourceAuthority,
  inferSourceTypeFromUrl,
  isPrimaryAuthority,
} from '../provenance.js';
import type { TokenBudget } from '../llm/chat.js';

export interface WorkerPoolConfig {
  concurrency: number;
  perWorkerToolCalls: number;
  tokenBudget: TokenBudget;
  onProgress?(completed: number, total: number, firstQuestion: string): Promise<void>;
}

export class WorkerPoolManager {
  private readonly config: WorkerPoolConfig;
  private readonly ingestedReportIds = new Set<string>();

  constructor(config: WorkerPoolConfig) {
    this.config = config;
  }

  async spawnWorkers(
    ctx: StrategyContext,
    questions: string[],
    options: {
      contextSubQuestions?: SubQuestion[];
      priorKnowledge?: string;
    },
  ): Promise<void> {
    if (!ctx.llm && !ctx.deterministic) return;

    // ── Per-worker tool call budget ─────────────────────────────────────
    const PER_WORKER_TOOL_CALLS = this.config.perWorkerToolCalls;
    const globalRemaining = Math.max(
      0,
      ctx.budget.profile.maxToolCalls - ctx.budget.snapshot().toolCallsUsed,
    );
    const workerPool = Math.min(questions.length * PER_WORKER_TOOL_CALLS, globalRemaining);
    let workerToolCallsUsed = 0;

    const tools = createResearchTools({
      onToolCall: (tool, query) => {
        workerToolCallsUsed++;
        ctx.budget.recordToolCall();
        logger.debug({ tool, query: query.slice(0, 60) }, `Worker tool: ${tool}`);
      },
    });

    const concurrency = this.config.concurrency;

    for (let i = 0; i < questions.length; i += concurrency) {
      if (ctx.budget.isExhausted()) break;
      if (ctx.abortSignal?.aborted) {
        throw new DOMException('Research cancelled', 'AbortError');
      }

      const batch = questions.slice(i, i + concurrency);
      const batchSubQuestions = options.contextSubQuestions?.slice(i, i + concurrency);
      const llm = ctx.llm;

      const workerPromises = batch.map(async (question, batchIdx) => {
        const { WorkerAgent } = await import('../workerAgent.js');
        // WorkerAgent handles undefined llm when deterministicMode is true
        const worker = new WorkerAgent(llm, tools, this.config.tokenBudget, {
          deterministicMode: ctx.deterministic ?? false,
        });
        try {
          const parentId = batchSubQuestions?.[batchIdx]?.id;
          const report = await worker.investigate(question, {
            ...(parentId !== undefined ? { parentSubQuestionId: parentId } : {}),
            ...(options.contextSubQuestions !== undefined
              ? { subQuestions: options.contextSubQuestions }
              : {}),
            ...(options.priorKnowledge !== undefined
              ? { priorKnowledge: options.priorKnowledge }
              : {}),
            onProgress: (stage, detail) => {
              void ctx.onProgress?.(
                20 + Math.round((i / questions.length) * 30),
                `[${stage}] ${detail}`,
                'worker_investigation',
                {
                  sourceCount: ctx.state.sourceCount(),
                  findingCount: ctx.state.findingCount(),
                  subQuestionCount: ctx.state.getSubQuestions().length,
                },
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
      await ctx.onProgress?.(
        pct,
        `Worker ${String(completed)}/${String(questions.length)}: ${firstQuestion.slice(0, 50)}`,
        'worker_investigation',
        {
          sourceCount: ctx.state.sourceCount(),
          findingCount: ctx.state.findingCount(),
          subQuestionCount: ctx.state.getSubQuestions().length,
        },
      );
    }

    logger.info(
      { allocated: workerPool, consumed: workerToolCallsUsed },
      'Worker tool call budget: immediate reporting',
    );

    await this.ingestWorkerReports(ctx);
  }

  private async ingestWorkerReports(ctx: StrategyContext): Promise<void> {
    const allReports = ctx.state.getAllWorkerReports();
    const reports = allReports.filter((r) => !this.ingestedReportIds.has(r.id));
    if (reports.length === 0) return;

    for (const report of reports) {
      this.ingestedReportIds.add(report.id);
    }

    for (const report of reports) {
      for (const ws of report.sources) {
        await this.ensureSourceExists(ctx, ws.url, report);
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
            const fallbackId = await this.ensureSourceExists(ctx, url, report);
            allSourceIds.push(fallbackId);
          }
        }

        const firstSourceQuality =
          wf.sourceUrls.length > 0 ? report.contentQuality[wf.sourceUrls[0] ?? ''] : undefined;

        // Infer source perspective from the primary source type
        const primarySource = allSources.find((s) => s.url === wf.sourceUrls[0]);
        const perspective = primarySource
          ? this.inferPerspective(primarySource.sourceType)
          : ('unknown' as import('../types.js').Perspective);

        // Epistemic status: derived from worker report confidence + content quality
        const epistemicStatus: import('../types.js').EpistemicStatus =
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
          sourceIds: [...new Set(allSourceIds)].filter(Boolean),
          evidenceSummary: wf.evidence,
          evidenceExcerpt: wf.evidence.slice(0, 500),
          evidenceDirectness: this.deriveEvidenceDirectness(wf, firstSourceQuality),
          ...(wf.caveats !== undefined ? { caveats: wf.caveats } : {}),
          ...this.augmentCaveats(wf),
          freshnessSensitive: false,
          lastUpdated: new Date().toISOString(),
          claimType: 'primary' as const,
          perspective,
          ...(perspective === 'vendor' || perspective === 'official'
            ? { conflictOfInterest: true }
            : {}),
          epistemicStatus,
        });
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
      let extractionsTracked = 0;
      for (const report of reports) {
        for (const ws of report.sources) {
          if (ws.quality.isSubstantive) {
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
  }

  /**
   * Compute caveats based on citation confidence.
   * Preserves existing wf.caveats and appends the appropriate bracketed message
   * for unattributed or inferred citations.
   */
  private augmentCaveats(wf: WorkerFinding): { caveats?: string } {
    if (wf.citationConfidence === 'unattributed') {
      const prefix = wf.caveats ? wf.caveats + ' ' : '';
      return {
        caveats: prefix + '[Citation: unattributed — no source could be verified for this claim]',
      };
    }
    if (wf.citationConfidence === 'inferred') {
      const prefix = wf.caveats ? wf.caveats + ' ' : '';
      return { caveats: prefix + '[Citation: inferred — source mapping may be imprecise]' };
    }
    return wf.caveats !== undefined ? { caveats: wf.caveats } : {};
  }

  private async ensureSourceExists(
    ctx: StrategyContext,
    url: string,
    report: WorkerReport,
  ): Promise<string> {
    if (!url) return `src-${report.id}`;
    const existingSources = ctx.state.getSources();
    const existing = existingSources.find((s) => s.url === url);
    if (existing) return existing.id;

    const wsEntry = report.sources.find((s) => s.url === url);
    const sourceType = inferSourceTypeFromUrl(url, wsEntry?.sourceType ?? 'web');
    const sourceId = `src-${url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(Date.now())}`;
    const focusText = `${ctx.state.getState().query} ${report.question}`;
    const sourceText = [
      wsEntry?.title ?? url,
      wsEntry?.relevanceRationale ?? '',
      report.narrativeSummary,
      report.searchQueries.join(' '),
      url,
    ].join(' ');
    const { scoreTextRelevance } = await import('../relevanceClassifier.js');
    const relevance = scoreTextRelevance(focusText, sourceText);
    const lowRelevance = !relevance.admissible && relevance.score < 0.45;

    const domain = wsEntry?.domain ?? this.extractDomain(url);
    const authorityClass = classifySourceAuthority({ url, domain, sourceType });
    ctx.state.addSource({
      id: sourceId,
      title: wsEntry?.title ?? url,
      url,
      sourceType,
      domain,
      authorityClass,
      isPrimary: isPrimaryAuthority(authorityClass) || sourceType === 'academic',
      relevantSubQuestions: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
      extractionStatus: 'extracted',
      accessDate: new Date().toISOString(),
      ...(wsEntry?.publishedDate !== undefined ? { publishedDate: wsEntry.publishedDate } : {}),
      subQuestionId: report.parentSubQuestionId ?? '',
      usageStatus: lowRelevance ? 'discarded' : 'used',
      ...(lowRelevance
        ? { discardReason: 'low_relevance' as const, limitations: relevance.reason }
        : {}),
      relevanceScore: relevance.score,
      ...(wsEntry?.qualityScore !== undefined ? { qualityScore: wsEntry.qualityScore } : {}),
    });

    return sourceId;
  }

  private deriveEvidenceDirectness(
    _wf: WorkerFinding,
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

  private inferPerspective(
    sourceType: import('../types.js').SourceType,
  ): import('../types.js').Perspective {
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
}
