/**
 * DeepTreeResearchEngine — breadth×depth recursive tree research.
 *
 * Mirrors gpt-researcher's DeepResearchSkill pattern:
 * - Generate N search queries with research goals (LLM-based)
 * - Process each query concurrently with semaphore-bound concurrency
 * - Extract learnings via LLM from each query's results
 * - Recurse with reduced breadth at each deeper level
 * - Aggregate all learnings, sources, citations into final result
 *
 * Replaces Phases 1-3 of the linear pipeline (decomposition, discovery, extraction)
 * for the 'tree' depth profile. The orchestrator skips directly to audit and synthesis
 * after tree research completes.
 *
 * @see https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/skills/deep_research.py
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { ResearchStateEngine, BudgetTracker } from './state.js';
import { DiscoveryEngine } from './discovery.js';
import { ExtractionEngine } from './extraction.js';
import { LlmExtractor } from './llm/extractor.js';
import { DeepResearchLlmClient, type TokenBudget } from './llm/chat.js';
import { TREE_GENERATE_QUERIES, TREE_PROCESS_RESULTS } from './llm/prompts.js';
import type { TreeResearchResult, TreeLearning, SubQuestion, SourceEntry } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TreeQuery {
   query: string;
   researchGoal: string;
}

interface TreeQueryResult {
   learnings: string[];
   allLearnings: TreeLearning[];
   visitedUrls: string[];
   sources: SourceEntry[];
   followUpQuestions: string[];
}

/** Progress report callback. */
type ProgressCallback = (progress: number, message?: string) => void | Promise<void>;

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 2;

// ── Semaphore helper ───────────────────────────────────────────────────────────

class Semaphore {
   private permits: number;
   private waiters: (() => void | Promise<void>)[] = [];

   constructor(max: number) {
      this.permits = max;
   }

   async run<T>(fn: () => Promise<T>): Promise<T> {
      if (this.permits > 0) {
         this.permits--;
         try {
            return await fn();
         } finally {
            this.release();
         }
      }
      return new Promise<T>((resolve, reject) => {
         this.waiters.push(async () => {
            try {
               resolve(await fn());
            } catch (error) {
               reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
               this.release();
            }
         });
      });
   }

   private release(): void {
      const next = this.waiters.shift();
      if (next) void next();
      else this.permits++;
   }
}

// ── Tree Engine ────────────────────────────────────────────────────────────────

export class DeepTreeResearchEngine {
   private state: ResearchStateEngine;
   private budget: BudgetTracker;
   private llm: DeepResearchLlmClient | undefined;
   private onProgress: ProgressCallback;
   private contextWordLimit: number;
   private abortSignal: AbortSignal | undefined;

   constructor(options: {
      state: ResearchStateEngine;
      budget: BudgetTracker;
      llm?: DeepResearchLlmClient;
      onProgress?: ProgressCallback;
      contextWordLimit?: number;
      abortSignal?: AbortSignal;
   }) {
      this.state = options.state;
      this.budget = options.budget;
      this.llm = options.llm;
      this.onProgress = options.onProgress ?? ((): void => undefined);
      this.contextWordLimit = options.contextWordLimit ?? 25_000;
      this.abortSignal = options.abortSignal;
   }
   /** Throw if research should abort. */
   private checkAborted(): void {
      if (this.abortSignal?.aborted) {
         throw new DOMException('Tree research aborted', 'AbortError');
      }
   }

   /**
    * Run the tree-based deep research.
    *
    * @param query       - The original research query
    * @param breadth     - Number of parallel queries per level (default 4)
    * @param depth       - Number of recursive levels (default 2)
    * @param concurrency - Max concurrent queries per level (default 2)
    */
   async run(
      query: string,
      breadth = 4,
      depth = 2,
      concurrency = DEFAULT_CONCURRENCY,
   ): Promise<TreeResearchResult> {
      logger.info({ query, breadth, depth, concurrency }, 'Tree research started');
      await this.onProgress(35, `Starting tree research: breadth=${String(breadth)}, depth=${String(depth)}`);

      // Save sub-question count so we can clean up temp sub-questions after research
      const initialSQCount = this.state.getSubQuestions().length;
      let result: TreeResearchResult;
      try {
         result = await this.deepResearch(query, breadth, depth, [], [], concurrency);
      } finally {
         // Remove temporary sub-questions created during tree research
         this.state.removeSubQuestionsFrom(initialSQCount);
      }

      await this.onProgress(
         50,
         `Tree research complete: ${String(result.allLearnings.length)} learnings, ${String(result.visitedUrls.length)} sources`,
      );

      logger.info(
         {
            learnings: result.learnings.length,
            allLearnings: result.allLearnings.length,
            visitedUrls: result.visitedUrls.length,
            sources: result.sources.length,
         },
         'Tree research finished',
      );

      return result;
   }

   // ── Core recursive research ─────────────────────────────────────────────────

   /**
    * Recursive deep research following gpt-researcher's pattern:
    *
    *    level N: generate N search queries → parallel research → extract learnings
    *    level N+1: for each query, recurse with (breadth/2, depth-1)
    *
    * Accumulates parentLearnings and parentVisitedUrls across recursion levels
    * so that deeper dives incorporate shallower findings.
    */
   private async deepResearch(
      query: string,
      breadth: number,
      depth: number,
      parentLearnings: string[],
      parentVisitedUrls: string[],
      concurrency: number,
   ): Promise<TreeResearchResult> {
      // Base case: depth exhausted or budget exhausted
      this.checkAborted();
      if (depth <= 0 || this.budget.isExhausted()) {
         return {
            learnings: parentLearnings,
            allLearnings: parentLearnings.map((l) => ({ learning: l })),
            visitedUrls: parentVisitedUrls,
            citations: {},
            context: parentLearnings,
            sources: [],
            researchQuestions: [],
         };
      }

      // Phase A: Generate search queries with research goals via LLM
      const queries = await this.generateSearchQueries(query, breadth);
      if (queries.length === 0) {
         queries.push({ query, researchGoal: `Research: ${query}` });
      }

      await this.onProgress(
         35 + Math.round((depth / (depth + 1)) * 8),
         `Tree depth ${String(depth)}: ${String(queries.length)} search queries`,
      );

      // Phase B: Process each query concurrently with semaphore
      const semaphore = new Semaphore(concurrency);
      const tasks = queries.map((q) =>
         semaphore.run(() =>
            this.processQueryAtLevel(q, depth, breadth, parentLearnings, parentVisitedUrls, concurrency),
         ),
      );

      const settled = await Promise.allSettled(tasks);
      const successfulResults: TreeQueryResult[] = [];

      for (const r of settled) {
         if (r.status === 'fulfilled') {
            successfulResults.push(r.value);
         } else {
            logger.warn({ err: r.reason instanceof Error ? r.reason.message : String(r.reason) }, 'Tree research: query processing failed');
         }
      }

      // Phase C: Aggregate results
      return this.aggregate(successfulResults, parentLearnings, parentVisitedUrls);
   }

   // ── Single query processing at one tree level ──────────────────────────────

   /**
    * Process a single query at the current tree level.
    *
    * Handles:
    *   1. Discovery — find sources for this sub-query
    *   2. Extraction — extract findings from sources (LLM or rule-based)
    *   3. Learning extraction — distill findings into learnings
    *   4. Recursion — if depth remains, generate follow-up and dive deeper
    */
   private async processQueryAtLevel(
      treeQuery: TreeQuery,
      depth: number,
      breadth: number,
      parentLearnings: string[],
      parentVisitedUrls: string[],
      concurrency: number,
   ): Promise<TreeQueryResult> {
      this.checkAborted();
      const learnings: string[] = [];
      const allLearnings: TreeLearning[] = [];
      const visitedUrls: string[] = [...parentVisitedUrls];
      const sources: SourceEntry[] = [];
      let followUpQuestions: string[] = [];

      // Create a temporary sub-question for discovery/extraction
      const sqId = `tree-${treeQuery.query.slice(0, 20).replace(/[^a-zA-Z0-9-]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const tempSubQuestion: SubQuestion = {
         id: sqId,
         text: treeQuery.query,
         classification: 'technical',
         evidenceType: 'general',
         preferredSources: ['web', 'academic', 'github', 'reddit', 'hackernews', 'stackoverflow'],
         freshnessRequirement: 'within 2 years',
         failureModes: [],
         budgetPriority: 1,
         status: 'pending',
      };
      this.state.addSubQuestion(tempSubQuestion);

      // Step 1: Discovery
      if (!this.budget.isExhausted()) {
         if (this.budget.recordToolCall()) {
            const discovery = new DiscoveryEngine(this.state, this.budget, undefined, this.llm);
            try {
               const candidates = await discovery.discover([tempSubQuestion]);
               for (const c of candidates) {
                  visitedUrls.push(c.url);
               }
               this.budget.recordStepCost('tree.discovery', 1);
            } catch (err) {
               logger.warn({ err, query: treeQuery.query }, 'Tree research: discovery failed');
            }
         }
      }

      // Step 2: Extraction from top-pending sources
      const pendingSources = this.state.getTopSources(this.budget.profile.maxExtractions);
      if (pendingSources.length > 0 && !this.budget.isExhausted()) {
         sources.push(...pendingSources);

         if (this.llm) {
            const tokenBudget: TokenBudget = {
               recordTokens: (count: number) => {
                  this.budget.recordTokens(count);
                  return !this.budget.isExhausted();
               },
            };
            const llmExtractor = new LlmExtractor(this.llm, this.state, tokenBudget);
            try {
               await llmExtractor.extract(pendingSources, [tempSubQuestion]);
               this.budget.recordStepCost('tree.extraction', 1);
            } catch {
               logger.warn({ query: treeQuery.query }, 'Tree research: LLM extraction failed, using rule-based');
               const ruleExtractor = new ExtractionEngine(this.state, this.budget);
               await ruleExtractor.extract(pendingSources);
            }
         } else {
            const ruleExtractor = new ExtractionEngine(this.state, this.budget);
            await ruleExtractor.extract(pendingSources);
         }
      }

      // Step 3: Extract learnings from findings via LLM
      const findings = this.state.getFindings(tempSubQuestion.id);
      const localLearnings: string[] = [];

      if (findings.length > 0 && this.llm) {
         try {
            const content = findings
               .map((f) => `Claim: ${f.claim}\nEvidence: ${f.evidenceExcerpt ?? f.evidenceSummary}`)
               .join('\n\n');

            const llmResult = await this.llm.callJSON<{
               learnings: { text: string; sourceUrl?: string }[];
               followUpQuestions: string[];
            }>({
               model: 'worker',
               messages: [
                  { role: 'system', content: TREE_PROCESS_RESULTS },
                  { role: 'user', content: `Query: ${treeQuery.query}\n\nResearch results:\n${content}` },
               ],
               temperature: 0.3,
            });

            if (llmResult.success) {
               for (const l of llmResult.data.learnings) {
                  localLearnings.push(l.text);
                  allLearnings.push({
                     learning: l.text,
                     ...(l.sourceUrl ? { sourceUrl: l.sourceUrl } : {}),
                  });
               }
               learnings.push(...localLearnings);

               // Step 4: Recurse deeper with follow-up questions
               if (
                  depth > 1 &&
                  llmResult.data.followUpQuestions.length > 0 &&
                  !this.budget.isExhausted()
               ) {
                  const nextBreadth = Math.max(2, Math.floor(breadth / 2));
                  const nextDepth = depth - 1;
                  const accumulatedLearnings = [...parentLearnings, ...learnings];
                  const nextQuery = llmResult.data.followUpQuestions[0] ?? '';

                  if (nextQuery) {
                     const deeper = await this.deepResearch(
                        nextQuery,
                        nextBreadth,
                        nextDepth,
                        accumulatedLearnings,
                        visitedUrls,
                        concurrency,
                     );

                     // Merge deeper results into current level's output
                     learnings.push(...deeper.learnings);
                     allLearnings.push(...deeper.allLearnings);
                     visitedUrls.push(...deeper.visitedUrls);
                     sources.push(...deeper.sources);
                  }
               }
               followUpQuestions = llmResult.data.followUpQuestions;
            }
         } catch (err) {
            logger.warn({ err, query: treeQuery.query }, 'Tree research: learning extraction failed');
            for (const f of findings) {
               localLearnings.push(f.claim);
               allLearnings.push({ learning: f.claim });
            }
            learnings.push(...localLearnings);
         }
      } else if (findings.length > 0) {
         // No LLM — use raw claims as learnings
         for (const f of findings) {
            localLearnings.push(f.claim);
            allLearnings.push({ learning: f.claim });
         }
         learnings.push(...localLearnings);
      } else {
         learnings.push(`No findings for: ${treeQuery.query}`);
         allLearnings.push({ learning: `No findings extracted` });
      }

      const remainingFQs = followUpQuestions.slice(1);
      return { learnings, allLearnings, visitedUrls, sources, followUpQuestions: remainingFQs };
   }

   // ── Query generation ──────────────────────────────────────────────────────

   private async generateSearchQueries(query: string, numQueries: number): Promise<TreeQuery[]> {
      if (!this.llm) {
         return [{ query, researchGoal: `Research: ${query}` }];
      }

      const promptContent = TREE_GENERATE_QUERIES.replace('{num_queries}', String(numQueries));

      try {
         const result = await this.llm.callJSON<{ queries: TreeQuery[] }>({
            model: 'worker',
            messages: [
               { role: 'system', content: promptContent },
               { role: 'user', content: `Generate ${String(numQueries)} search queries to research: ${query}` },
            ],
            temperature: 0.7,
         });

         if (result.success && Array.isArray(result.data.queries) && result.data.queries.length > 0) {
            return result.data.queries.slice(0, numQueries);
         }

         logger.warn({ query }, 'Tree research: LLM returned no queries, using fallback');
      } catch (err) {
         logger.warn({ err, query }, 'Tree research: query generation failed, using fallback');
      }

      return [{ query, researchGoal: `Research: ${query}` }];
   }

   // ── Aggregation ──────────────────────────────────────────────────────────

   /**
    * Aggregate results from all parallel queries at this level.
    * De-duplicates learnings, applies context word budget (25k from gpt-researcher),
    * builds citation map and source list.
    */
   private aggregate(
      results: TreeQueryResult[],
      parentLearnings: string[],
      parentVisitedUrls: string[],
   ): TreeResearchResult {
      const allLearnings: TreeLearning[] = [];
      const learnings: string[] = [];
      const visitedUrls = new Set(parentVisitedUrls);
      const sources: SourceEntry[] = [];
      const citations: Record<string, string> = {};
      const context: string[] = [];

      let wordCount = 0;

      for (const r of results) {
         for (const l of r.learnings) {
            if (!learnings.includes(l)) {
               learnings.push(l);
            }
         }
         for (const l of r.allLearnings) {
            allLearnings.push(l);
         }
         for (const url of r.visitedUrls) {
            visitedUrls.add(url);
         }
         for (const s of r.sources) {
            sources.push(s);
            citations[s.url] ??= s.title;
         }
         // Context with word budget (gpt-researcher's MAX_CONTEXT_WORDS = 25000)
         for (const l of r.learnings) {
            const words = l.split(/\s+/).length;
            if (wordCount + words <= this.contextWordLimit) {
               context.push(l);
               wordCount += words;
            }
         }
      }

      // Prepend parent learnings (shallower levels first)
      for (const l of parentLearnings) {
         if (!learnings.includes(l)) {
            learnings.unshift(l);
         }
      }

      const researchQuestions: { query: string; researchGoal: string }[] = [];
      for (const r of results) {
         for (const fq of r.followUpQuestions) {
            if (fq) researchQuestions.push({ query: fq, researchGoal: `Follow-up: ${fq}` });
         }
      }

      return {
         learnings,
         allLearnings,
         visitedUrls: Array.from(visitedUrls),
         citations,
         context,
         sources,
         researchQuestions,
      };
   }
}
