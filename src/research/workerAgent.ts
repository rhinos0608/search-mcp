/**
 * V5.0.0 WorkerAgent — autonomous sub-investigator with tool access.
 *
 * Unlike the passive LlmExtractor which only processes pre-fetched content,
 * the WorkerAgent actively searches, reads, analyzes, and chases threads.
 *
 * Each worker receives a research question + context, has access to the full
 * ResearchTools suite, and produces a WorkerReport with findings, sources,
 * content quality assessments, and identified sub-threads.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { DeepResearchLlmClient, TokenBudget } from './llm/chat.js';
import { WORKER_AGENT_INVESTIGATE } from './llm/prompts.js';
import type {
   ResearchTools,
   WorkerReport,
   WorkerFinding,
   WorkerSource,
   SubThread,
   ContentQualityAssessment,
   SubQuestion,
} from './types.js';

// ── Configuration ───────────────────────────────────────────────────────────

export interface WorkerAgentConfig {
   /** Max search rounds the worker can execute. */
   maxSearchRounds: number;
   /** Max pages to read per round. */
   maxPagesPerRound: number;
   /** Max depth for sub-thread chasing. */
   maxSubThreadDepth: number;
   /** Max concurrent page reads. */
   readConcurrency: number;
   /** Max chars of content to send to LLM per page. */
   maxContentCharsPerPage: number;
   /** Timeout per LLM call in ms. */
   llmTimeoutMs: number;
}

const DEFAULT_CONFIG: WorkerAgentConfig = {
   maxSearchRounds: 3,
   maxPagesPerRound: 5,
   maxSubThreadDepth: 1,
   readConcurrency: 3,
   maxContentCharsPerPage: 8000,
   llmTimeoutMs: 120_000,
};

// ── Internal types ─────────────────────────────────────────────────────────

interface SearchPlan {
   queries: string[];
   sourceTypes: string[];
   reasoning: string;
}

interface PageAnalysis {
   url: string;
   title: string;
   sourceType: string;
   findings: WorkerFinding[];
   quality: ContentQualityAssessment;
   subThreads: SubThread[];
}

function toSourceType(t: string): WorkerSource['sourceType'] {
   return t as WorkerSource['sourceType'];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): string {
   return randomUUID().slice(0, 12);
}

function truncate(s: string, max: number): string {
   if (s.length <= max) return s;
   return s.slice(0, max - 3) + '...';
}

// ── Quick content quality (delegates to sourceQuality.ts) ───────────────────

import { assessContentQuality } from './sourceQuality.js';

function quickQuality(markdown: string, url: string, title: string): ContentQualityAssessment {
   return assessContentQuality(markdown, url, title);
}

// ── WorkerAgent ─────────────────────────────────────────────────────────────

export class WorkerAgent {
   private config: WorkerAgentConfig;

   constructor(
      private llm: DeepResearchLlmClient,
      private tools: ResearchTools,
      private budget: TokenBudget | undefined,
      config?: Partial<WorkerAgentConfig>,
   ) {
      this.config = { ...DEFAULT_CONFIG, ...config };
   }

   /**
    * Investigate a research question autonomously.
    *
    * Flow:
    *   1. Plan search strategy (LLM)
    *   2. Execute searches via tools
    *   3. Read top pages
    *   4. Analyze each page (LLM) → findings + sub-threads
    *   5. Chase high-priority sub-threads (depth-limited)
    *   6. Produce WorkerReport
    */
   async investigate(
      question: string,
      context?: {
         parentSubQuestionId?: string;
         subQuestions?: SubQuestion[];
         priorKnowledge?: string;
      },
   ): Promise<WorkerReport> {
      const startTime = Date.now();
      const reportId = makeId();
      let totalTokens = 0;
      const allFindings: WorkerFinding[] = [];
      const allSources: WorkerSource[] = [];
      const allSubThreads: SubThread[] = [];
      const qualityMap: Record<string, ContentQualityAssessment> = {};
      const allQueries: string[] = [];

      logger.info({ question: truncate(question, 80), reportId }, 'WorkerAgent investigating');

      // ── Round 1: Plan & Search ──────────────────────────────────────────
      const plan = await this.planSearch(question, context);
      totalTokens += plan.tokensUsed ?? 0;
      allQueries.push(...plan.queries);

      // Execute searches across all planned source types
      const searchResults = await this.executeSearches(plan);
      totalTokens += searchResults.tokensUsed ?? 0;

      // ── Round 2: Read & Analyze pages ───────────────────────────────────
      const pagesToRead = this.selectTopPages(searchResults.urls);
      const analyses = await this.analyzePages(pagesToRead, question);
      totalTokens += analyses.tokensUsed;

      for (const analysis of analyses.results) {
         allFindings.push(...analysis.findings);
         allSources.push({
            url: analysis.url,
            title: analysis.title,
            sourceType: toSourceType(analysis.sourceType),
            domain: this.extractDomain(analysis.url),
            quality: analysis.quality,
            relevanceRationale: `Found via search query: ${truncate(plan.queries[0] ?? question, 60)}`,
         });
         qualityMap[analysis.url] = analysis.quality;

         for (const thread of analysis.subThreads) {
            allSubThreads.push(thread);
         }
      }

      // ── Round 3: Chase sub-threads (optional, depth-limited) ────────────
      if (this.config.maxSubThreadDepth > 0 && allSubThreads.length > 0) {
         const topThreads = allSubThreads
            .filter((t) => t.priority <= 2)
            .slice(0, 2);

         for (const thread of topThreads) {
            if (this.budget && !this.budget.recordTokens(0)) break;

            logger.info({ thread: truncate(thread.question, 60) }, 'WorkerAgent chasing sub-thread');
            const chaseResult = await this.chaseSubThread(thread, question);
            totalTokens += chaseResult.tokensUsed;
            allFindings.push(...chaseResult.findings);
            for (const src of chaseResult.sources) {
               allSources.push(src);
               qualityMap[src.url] = src.quality;
            }
         }
      }

      // ── Build report ────────────────────────────────────────────────────
      const elapsed = Date.now() - startTime;
      const confidence = this.computeAggregateConfidence(allFindings, allSources);

      const report: WorkerReport = {
         id: reportId,
         question,
         ...(context?.parentSubQuestionId !== undefined
            ? { parentSubQuestionId: context.parentSubQuestionId }
            : {}),
         findings: allFindings,
         sources: allSources,
         subThreads: allSubThreads,
         contentQuality: qualityMap,
         narrativeSummary: this.buildNarrativeSummary(question, allFindings, allSources, confidence),
         confidence,
         searchQueries: allQueries,
         tokensUsed: totalTokens,
         elapsedMs: elapsed,
      };

      logger.info(
         {
            reportId,
            findings: allFindings.length,
            sources: allSources.length,
            subThreads: allSubThreads.length,
            confidence,
            elapsedMs: elapsed,
         },
         'WorkerAgent investigation complete',
      );

      return report;
   }

   // ── Phase 1: Plan Search ─────────────────────────────────────────────────

   private async planSearch(
      question: string,
      context?: { subQuestions?: SubQuestion[]; priorKnowledge?: string },
   ): Promise<{ queries: string[]; sourceTypes: string[]; tokensUsed: number }> {
      try {
         const ctxParts: string[] = [`Research question: ${question}`];
         if (context?.priorKnowledge) {
            ctxParts.push(`Prior knowledge: ${context.priorKnowledge}`);
         }
         if (context?.subQuestions && context.subQuestions.length > 0) {
            ctxParts.push(
               `Related sub-questions: ${context.subQuestions.map((sq) => sq.text).join('; ')}`,
            );
         }

         const result = await this.llm.callJSON<SearchPlan>({
            model: 'worker',
            messages: [
               { role: 'system', content: WORKER_AGENT_INVESTIGATE },
               { role: 'user', content: ctxParts.join('\n\n') },
            ],
            temperature: 0.3,
            timeoutMs: this.config.llmTimeoutMs,
            maxTokens: 1000,
            responseFormat: 'json_object',
         });

         if (result.success && result.data.queries.length > 0) {
            return {
               queries: result.data.queries.slice(0, 3),
               sourceTypes: result.data.sourceTypes ?? ['web', 'academic'],
               tokensUsed: result.response.tokensUsed,
            };
         }
      } catch (err) {
         logger.warn({ err }, 'WorkerAgent search plan LLM call failed');
      }

      // Fallback: use question directly as query
      return {
         queries: [question],
         sourceTypes: ['web', 'academic'],
         tokensUsed: 0,
      };
   }

   // ── Phase 2: Execute Searches ────────────────────────────────────────────

   private async executeSearches(
      plan: { queries: string[]; sourceTypes: string[] },
   ): Promise<{ urls: { title: string; url: string; snippet: string; sourceType: string }[]; tokensUsed: number }> {
      const allUrls: { title: string; url: string; snippet: string; sourceType: string }[] = [];
      const seen = new Set<string>();

      const addResults = (
         results: { title: string; url: string; description?: string; abstract?: string; selftext?: string; text?: string }[],
         sourceType: string,
      ): void => {
         for (const r of results) {
            const key = r.url.toLowerCase().trim();
            if (seen.has(key)) continue;
            seen.add(key);
            allUrls.push({
               title: r.title,
               url: r.url,
               snippet: r.description ?? r.abstract ?? r.selftext ?? r.text ?? '',
               sourceType,
            });
         }
      };

      const searchPromises: Promise<void>[] = [];

      for (const query of plan.queries) {
         if (plan.sourceTypes.includes('web') || plan.sourceTypes.length === 0) {
            searchPromises.push(
               this.tools.webSearch(query, 10).then((r) => { addResults(r.map((x) => ({ ...x, description: x.description })), 'web'); })
                  .catch(() => { /* skip */ }),
            );
         }
         if (plan.sourceTypes.includes('academic')) {
            searchPromises.push(
               this.tools.academicSearch(query, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.abstract ?? '' })), 'academic'); })
                  .catch(() => { /* skip */ }),
            );
         }
         if (plan.sourceTypes.includes('github')) {
            searchPromises.push(
               this.tools.githubSearch(query, 5).then((r) => { addResults(r.map((x) => ({ title: x.fullName, url: x.htmlUrl, description: x.description })), 'github'); })
                  .catch(() => { /* skip */ }),
            );
         }
         if (plan.sourceTypes.includes('reddit')) {
            searchPromises.push(
               this.tools.redditSearch(query, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.selftext ?? '' })), 'reddit'); })
                  .catch(() => { /* skip */ }),
            );
         }
         if (plan.sourceTypes.includes('hackernews')) {
            searchPromises.push(
               this.tools.hackernewsSearch(query, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.text ?? '' })), 'hackernews'); })
                  .catch(() => { /* skip */ }),
            );
         }
      }

      await Promise.allSettled(searchPromises);

      // Sort: prefer academic, then web, then social
      const typeOrder: Record<string, number> = {
         academic: 0, web: 1, documentation: 2, github: 3,
         hackernews: 4, reddit: 5, stackoverflow: 6, news: 7,
      };
      allUrls.sort((a, b) => (typeOrder[a.sourceType] ?? 5) - (typeOrder[b.sourceType] ?? 5));

      return { urls: allUrls, tokensUsed: 0 };
   }

   // ── Phase 3: Read & Analyze Pages ─────────────────────────────────────────

   private selectTopPages(
      urls: { title: string; url: string; snippet: string; sourceType: string }[],
   ): { title: string; url: string; sourceType: string }[] {
      // Prioritize academic > documentation > web > social
      const maxPages = this.config.maxPagesPerRound;

      const academic = urls.filter((u) => u.sourceType === 'academic').slice(0, maxPages);
      const docs = urls.filter((u) => u.sourceType === 'documentation').slice(0, maxPages - academic.length);
      const web = urls.filter((u) => u.sourceType === 'web').slice(0, maxPages - academic.length - docs.length);
      const rest = urls.filter(
         (u) => !['academic', 'documentation', 'web'].includes(u.sourceType),
      ).slice(0, maxPages - academic.length - docs.length - web.length);

      return [...academic, ...docs, ...web, ...rest].slice(0, maxPages);
   }

   private async analyzePages(
      pages: { title: string; url: string; sourceType: string }[],
      question: string,
   ): Promise<{ results: PageAnalysis[]; tokensUsed: number }> {
      let totalTokens = 0;

      // Read pages with concurrency limit
      const results: PageAnalysis[] = [];
      const chunks = this.chunkArray(pages, this.config.readConcurrency);

      for (const chunk of chunks) {
         const chunkResults = await Promise.allSettled(
            chunk.map(async (page) => {
               try {
                  // Read the page
                  const content = await this.readPage(page.url);
                  if (!content || content.trim().length < 200) {
                     logger.info({ url: page.url }, 'WorkerAgent: page too short, skipping analysis');
                     return {
                        url: page.url,
                        title: page.title,
                        sourceType: page.sourceType,
                        findings: [],
                        quality: quickQuality(content ?? '', page.url, page.title),
                        subThreads: [],
                     };
                  }

                  // Assess quality
                  const quality = quickQuality(content, page.url, page.title);

                  // Skip promotional or very low quality pages
                  if (quality.isPromotional && quality.contentDepth < 0.4) {
                     logger.info(
                        { url: page.url, depth: quality.contentDepth },
                        'WorkerAgent: skipping promotional/low-quality page',
                     );
                     return {
                        url: page.url,
                        title: page.title,
                        sourceType: page.sourceType,
                        findings: [],
                        quality,
                        subThreads: [],
                     };
                  }

                  // Analyze with LLM
                  const analysis = await this.llmAnalyzePage(content, page, question, quality);
                  totalTokens += analysis.tokensUsed;
                  return {
                     url: page.url,
                     title: page.title,
                     sourceType: page.sourceType,
                     findings: analysis.findings,
                     quality,
                     subThreads: analysis.subThreads,
                  };
               } catch (err) {
                  logger.warn({ url: page.url, err }, 'WorkerAgent: page analysis failed');
                  return {
                     url: page.url,
                     title: page.title,
                     sourceType: page.sourceType,
                     findings: [],
                     quality: quickQuality('', page.url, page.title),
                     subThreads: [],
                  };
               }
            }),
         );

         for (const result of chunkResults) {
            if (result.status === 'fulfilled') {
               results.push(result.value);
            }
         }
      }

      return { results, tokensUsed: totalTokens };
   }

   private async readPage(url: string): Promise<string | null> {
      try {
         // Try webRead first (handles JS-rendered pages)
         const readResult = await this.tools.webRead(url);
         if (readResult.markdown && readResult.markdown.trim().length > 100) {
            return truncate(readResult.markdown, this.config.maxContentCharsPerPage);
         }
      } catch {
         // webRead failed, try webCrawl
      }

      try {
         const crawlResult = await this.tools.webCrawl(url, 1);
         const firstPage = crawlResult[0];
         if (firstPage?.markdown && firstPage.markdown.trim().length > 100) {
            return truncate(firstPage.markdown, this.config.maxContentCharsPerPage);
         }
      } catch {
         // both failed
      }

      return null;
   }

   private async llmAnalyzePage(
      content: string,
      page: { title: string; url: string; sourceType: string },
      question: string,
      quality: ContentQualityAssessment,
   ): Promise<{ findings: WorkerFinding[]; subThreads: SubThread[]; tokensUsed: number }> {
      const truncatedContent = truncate(content, this.config.maxContentCharsPerPage);

      const prompt = `Analyze this page and extract findings relevant to the research question.

Research question: ${question}
Page title: ${page.title}
Page URL: ${page.url}
Source type: ${page.sourceType}
Content quality assessment: depth=${quality.contentDepth.toFixed(1)}, promotional=${String(quality.isPromotional)}

Page content:
${truncatedContent}

Extract:
1. **Findings**: Specific, factual claims relevant to the research question. For each, provide:
   - claim: Verbatim or near-verbatim claim
   - evidence: Direct quote supporting it
   - confidence: 0-1 score
   - corroborated: false (unless you see multiple independent sources within this page)
   - caveats: any hedging or limitations

2. **SubThreads**: Interesting topics or questions raised by this page that deserve further investigation. For each:
   - question: A follow-up research question
   - rationale: Why it's worth pursuing
   - priority: 1 (critical) to 5 (nice-to-have)
   - suggestedSourceTypes: what source types would best answer this

Output ONLY valid JSON, no markdown fences:
{
  "findings": [{ "claim": "...", "evidence": "...", "confidence": 0.8, "corroborated": false, "caveats": "..." }],
  "subThreads": [{ "question": "...", "rationale": "...", "priority": 2, "suggestedSourceTypes": ["academic", "web"] }]
}`;

      try {
         const result = await this.llm.callJSON<{
            findings: WorkerFinding[];
            subThreads: SubThread[];
         }>({
            model: 'worker',
            messages: [
               { role: 'system', content: 'You are a precise claim extractor. Extract verbatim, preserve uncertainty, flag caveats. Output ONLY valid JSON.' },
               { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            timeoutMs: this.config.llmTimeoutMs,
            maxTokens: 4000,
            responseFormat: 'json_object',
         });

         if (result.success) {
            const findings = (result.data.findings ?? []).map((f) => ({
               ...f,
               id: makeId(),
               sourceUrls: [page.url],
            }));
            const subThreads = result.data.subThreads ?? [];
            return { findings, subThreads, tokensUsed: result.response.tokensUsed };
         }

         logger.warn({ url: page.url }, 'WorkerAgent LLM page analysis failed');
         return { findings: [], subThreads: [], tokensUsed: 0 };
      } catch (err) {
         logger.warn({ url: page.url, err }, 'WorkerAgent LLM page analysis error');
         return { findings: [], subThreads: [], tokensUsed: 0 };
      }
   }

   // ── Phase 4: Chase Sub-Threads ────────────────────────────────────────────

   private async chaseSubThread(
      thread: SubThread,
      _parentQuestion: string,
   ): Promise<{ findings: WorkerFinding[]; sources: WorkerSource[]; tokensUsed: number }> {
      let totalTokens = 0;
      const allFindings: WorkerFinding[] = [];
      const allSources: WorkerSource[] = [];

      // Search for the sub-thread question
      const searchPromises: Promise<{ title: string; url: string; snippet: string; sourceType: string }[]>[] = [];

      if (thread.suggestedSourceTypes.includes('web') || thread.suggestedSourceTypes.length === 0) {
         searchPromises.push(
            this.tools.webSearch(thread.question, 5).then((r) =>
               r.map((x) => ({ ...x, snippet: x.description, sourceType: 'web' })),
            ).catch(() => []),
         );
      }
      if (thread.suggestedSourceTypes.includes('academic')) {
         searchPromises.push(
            this.tools.academicSearch(thread.question, 3).then((r) =>
               r.map((x) => ({ title: x.title, url: x.url, snippet: x.abstract ?? '', sourceType: 'academic' })),
            ).catch(() => []),
         );
      }

      const settled = await Promise.allSettled(searchPromises);
      const urls: { title: string; url: string; sourceType: string }[] = [];
      for (const result of settled) {
         if (result.status === 'fulfilled') {
            for (const u of result.value) {
               urls.push({ title: u.title, url: u.url, sourceType: u.sourceType });
            }
         }
      }

      // Read and analyze top 3
      const topUrls = urls.slice(0, 3);
      for (const page of topUrls) {
         try {
            const content = await this.readPage(page.url);
            if (!content || content.trim().length < 200) continue;

            const quality = quickQuality(content, page.url, page.title);
            if (quality.isPromotional && quality.contentDepth < 0.4) continue;

            const analysis = await this.llmAnalyzePage(content, page, thread.question, quality);
            totalTokens += analysis.tokensUsed;

            for (const f of analysis.findings) {
               f.id = makeId();
               f.sourceUrls = [page.url];
            }
            allFindings.push(...analysis.findings);
            allSources.push({
               url: page.url,
               title: page.title,
               sourceType: page.sourceType as WorkerSource['sourceType'],
               domain: this.extractDomain(page.url),
               quality,
               relevanceRationale: `Sub-thread chase: ${thread.question}`,
            });
         } catch {
            // skip individual failures
         }
      }

      return { findings: allFindings, sources: allSources, tokensUsed: totalTokens };
   }

   // ── Helpers ───────────────────────────────────────────────────────────────

   private extractDomain(url: string): string {
      try {
         return new URL(url).hostname.replace(/^www\./, '');
      } catch {
         return url;
      }
   }

   private computeAggregateConfidence(
      findings: WorkerFinding[],
      sources: WorkerSource[],
   ): number {
      if (findings.length === 0) return 0;

      const avgConfidence = findings.reduce((s, f) => s + f.confidence, 0) / findings.length;
      const substantiveSources = sources.filter((s) => s.quality.isSubstantive).length;
      const sourceBonus = Math.min(0.15, substantiveSources * 0.03);
      const corroboratedCount = findings.filter((f) => f.corroborated).length;
      const corroborationBonus = Math.min(0.1, corroboratedCount * 0.05);

      return Math.min(1, avgConfidence * (1 + sourceBonus + corroborationBonus));
   }

   private buildNarrativeSummary(
      question: string,
      findings: WorkerFinding[],
      sources: WorkerSource[],
      confidence: number,
   ): string {
      if (findings.length === 0) {
         return `No substantive findings were discovered for "${question}". ${sources.length} source(s) were examined but did not yield extractable claims.`;
      }

      const highConf = findings.filter((f) => f.confidence >= 0.7);
      const substantiveSources = sources.filter((s) => s.quality.isSubstantive).length;
      const promotionalSources = sources.filter((s) => s.quality.isPromotional).length;

      const parts: string[] = [];
      parts.push(
         `Investigation of "${question}" yielded ${findings.length} finding(s) from ${sources.length} source(s)`,
      );

      if (highConf.length > 0) {
         parts.push(`with ${highConf.length} high-confidence claims`);
      }
      if (substantiveSources > 0) {
         parts.push(`across ${substantiveSources} substantive source(s)`);
      }
      if (promotionalSources > 0) {
         parts.push(`(${promotionalSources} promotional source(s) were examined but down-weighted)`);
      }
      parts.push(`. Overall confidence: ${(confidence * 100).toFixed(0)}%.`);

      // Add top finding
      if (findings[0]) {
         parts.push(` Key finding: "${truncate(findings[0].claim, 200)}"`);
      }

      return parts.join('');
   }

   private chunkArray<T>(arr: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) {
         chunks.push(arr.slice(i, i + size));
      }
      return chunks;
   }
}
