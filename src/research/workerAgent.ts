/**
 * V5.1.0 WorkerAgent — gatherer+compactor+synthesizer with tool access.
 *
 * Unlike the old approach (per-page LLM extraction), the WorkerAgent:
 *   1. Plans search via LLM (keep)
 *   2. Executes searches algorithmically (keep)
 *   3. Gathers & compacts content algorithmically (new)
 *   4. Single LLM synthesis call per worker (new)
 *   5. Chases sub-threads with same pattern (restructured)
 *
 * The LLM is only used for:
 *   - Search planning / query generation
 *   - Final synthesis from pre-compacted content
 * No per-page LLM extraction calls.
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
   /** Max chars of compacted context sent to the LLM synthesis call. */
   maxContextChars: number;
   /** Max chars per fetched page (before compaction). */
   maxContentCharsPerPage: number;
   /** Timeout per LLM call in ms. */
   llmTimeoutMs: number;
}

const DEFAULT_CONFIG: WorkerAgentConfig = {
   maxSearchRounds: 3,
   maxPagesPerRound: 10,
   maxSubThreadDepth: 1,
   readConcurrency: 3,
   maxContextChars: 24_000,
   maxContentCharsPerPage: 12_000,
   llmTimeoutMs: 120_000,
};

// ── Internal types ─────────────────────────────────────────────────────────

interface SearchPlan {
   queries: string[];
   sourceTypes: string[];
   reasoning: string;
}

/** Raw fetched page with content and quality assessment. */
interface FetchedPage {
   url: string;
   title: string;
   sourceType: string;
   content: string;
   quality: ContentQualityAssessment;
}

/** Compacted source block ready for LLM consumption. */
interface CompactBlock {
   url: string;
   title: string;
   section: string;
   text: string;
   score: number;
   sourceType: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toSourceType(t: string): WorkerSource['sourceType'] {
   return t as WorkerSource['sourceType'];
}

function makeId(): string {
   return randomUUID().slice(0, 12);
}

function truncate(s: string, max: number): string {
   if (s.length <= max) return s;
   return s.slice(0, max - 3) + '...';
}

import { assessContentQuality } from './sourceQuality.js';

function quickQuality(markdown: string, url: string, title: string): ContentQualityAssessment {
   return assessContentQuality(markdown, url, title);
}

// ── WorkerAgent ─────────────────────────────────────────────────────────────

export class WorkerAgent {
   private config: WorkerAgentConfig;
   /** Cache of pre-fetched content from semantic tools (URL -> text). */
   private semanticContentCache = new Map<string, string>();

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
    * New flow (no per-page LLM extraction):
    *   1. Plan search strategy (LLM)
    *   2. Execute searches via tools
    *   3. Gather content — fetch all pages (algorithmic)
    *   4. Compact content — algorithmically select relevant sections
    *   5. Synthesize — single LLM call on compacted context
    *   6. Chase high-priority sub-threads (depth-limited, same pattern)
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
      const allQueries: string[] = [];
      const allSources: WorkerSource[] = [];
      const qualityMap: Record<string, ContentQualityAssessment> = {};

      logger.info({ question: truncate(question, 80), reportId }, 'WorkerAgent investigating');

      // ── Round 1: Plan & Search (LLM-based planning stays) ──────────────
      const plan = await this.planSearch(question, context);
      totalTokens += plan.tokensUsed;
      allQueries.push(...plan.queries);

      // Execute searches across all planned source types
      const searchResults = await this.executeSearches(plan);
      totalTokens += searchResults.tokensUsed;

      // ── Round 2: Gather & Compact (algorithmic, no LLM per page) ──────
      const pagesToRead = this.selectTopPages(searchResults.urls);
      const fetchedPages = await this.gatherContent(pagesToRead);

      // Track sources and quality
      for (const page of fetchedPages) {
         allSources.push({
            url: page.url,
            title: page.title,
            sourceType: toSourceType(page.sourceType),
            domain: this.extractDomain(page.url),
            quality: page.quality,
            relevanceRationale: `Found via search query: ${truncate(plan.queries[0] ?? question, 60)}`,
         });
         qualityMap[page.url] = page.quality;
      }

      // Compact all page content into a single context block
      const compactedContext = this.compactContent(fetchedPages, question);

      // ── Round 3: Synthesize from compacted context (single LLM call) ───
      const synthesisResult = await this.synthesizeFromCompacted(
         question,
         compactedContext,
         allSources,
      );
      totalTokens += synthesisResult.tokensUsed;

      const allFindings = synthesisResult.findings;
      const allSubThreads = synthesisResult.subThreads;

      // ── Round 4: Chase sub-threads (uses same new pattern) ────────────
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
         narrativeSummary: this.buildNarrativeSummary(question, allFindings, allSources),
         searchQueries: allQueries,
         tokensUsed: totalTokens,
         elapsedMs: elapsed,
      };

      logger.info(
         {
            reportId,
            findings: String(allFindings.length),
            sources: String(allSources.length),
            subThreads: String(allSubThreads.length),
            elapsedMs: String(elapsed),
         },
         'WorkerAgent investigation complete',
      );

      return report;
   }

   // ── Phase 1: Plan Search (LLM-based, kept) ─────────────────────────────

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

         if (result.success) {
            return {
               queries: result.data.queries.slice(0, 3),
               sourceTypes: result.data.sourceTypes,
               tokensUsed: result.response.tokensUsed,
            };
         }
      } catch (err) {
         logger.warn({ err }, 'WorkerAgent search plan LLM call failed');
      }

      // Fallback: use question directly as query, diverse source types
      return {
         queries: [question],
         sourceTypes: ['web', 'academic', 'reddit', 'youtube', 'hackernews'],
         tokensUsed: 0,
      };
   }

   // ── Phase 2: Execute Searches (algorithmic, kept) ──────────────────────

   private async executeSearches(
      plan: { queries: string[]; sourceTypes: string[] },
   ): Promise<{ urls: { title: string; url: string; snippet: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[]; tokensUsed: number }> {
      const allUrls: { title: string; url: string; snippet: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[] = [];
      const seen = new Set<string>();

      const addResults = (
         results: { title: string; url: string; description?: string; abstract?: string; selftext?: string; text?: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[],
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
               ...(r.extraSnippet ? { extraSnippet: r.extraSnippet } : {}),
               ...(r.deepLinks ? { deepLinks: r.deepLinks } : {}),
            });
         }
      };

      const searchPromises: Promise<void>[] = [];

      // Per-query searches (web, academic, github)
      for (const query of plan.queries) {
         // Web search (always runs when sourceTypes includes web or is empty)
         if (plan.sourceTypes.includes('web') || plan.sourceTypes.length === 0) {
            searchPromises.push(
               this.tools.webSearch(query, 10).then((r) => { addResults(r.map((x) => ({ title: x.title, url: x.url, description: x.description, ...(x.extraSnippet ? { extraSnippet: x.extraSnippet } : {}), ...(x.deepLinks ? { deepLinks: x.deepLinks } : {}) })), 'web'); })
                  .catch(() => { /* skip */ }),
            );
         }
         // Academic search (LLM-requested or fallback)
         if (plan.sourceTypes.includes('academic')) {
            searchPromises.push(
               this.tools.academicSearch(query, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.abstract ?? '' })), 'academic'); })
                  .catch(() => { /* skip */ }),
            );
         }
         // GitHub (LLM-requested)
         if (plan.sourceTypes.includes('github')) {
            searchPromises.push(
               this.tools.githubSearch(query, 5).then((r) => { addResults(r.map((x) => ({ title: x.fullName, url: x.htmlUrl, description: x.description })), 'github'); })
                  .catch(() => { /* skip */ }),
            );
         }
      }

      // Always-run searches — fire ONCE using the primary query
      const primaryQuery = plan.queries[0];
      if (primaryQuery) {
         // Reddit — practitioner perspectives
         searchPromises.push(
            this.tools.redditSearch(primaryQuery, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.selftext ?? '' })), 'reddit'); })
               .catch(() => { /* skip */ }),
         );
         // Hacker News
         searchPromises.push(
            this.tools.hackernewsSearch(primaryQuery, 5).then((r) => { addResults(r.map((x) => ({ ...x, description: x.text ?? '' })), 'hackernews'); })
               .catch(() => { /* skip */ }),
         );
         // YouTube — gracefully skips when no API key configured
         searchPromises.push(
            this.tools.semanticYoutube(primaryQuery, { maxVideos: 5, topK: 5 }).then((r) => {
               for (const chunk of r.chunks) {
                  this.semanticContentCache.set(chunk.url, chunk.text);
               }
               addResults(
                  r.chunks.map((c) => ({ title: c.title, url: c.url, description: c.text.slice(0, 500) })),
                  'youtube',
               );
            }).catch(() => { /* skip */ }),
         );
         // Reddit semantic — deeper community context
         searchPromises.push(
            this.tools.semanticReddit(primaryQuery, { maxPosts: 5, topK: 5 }).then((r) => {
               for (const chunk of r.chunks) {
                  this.semanticContentCache.set(chunk.url, chunk.text);
               }
               addResults(
                  r.chunks.map((c) => ({ title: c.postTitle, url: c.url, description: c.text.slice(0, 500) })),
                  'reddit',
               );
            }).catch(() => { /* skip */ }),
         );
      }

      await Promise.allSettled(searchPromises);

      // Sort: prefer academic, then web, then social
      const typeOrder: Record<string, number> = {
         academic: 0, web: 1, documentation: 2, github: 3,
         hackernews: 4, reddit: 5, youtube: 5, stackoverflow: 6, news: 7,
      };
      allUrls.sort((a, b) => (typeOrder[a.sourceType] ?? 5) - (typeOrder[b.sourceType] ?? 5));

      return { urls: allUrls, tokensUsed: 0 };
   }

   // ── Phase 3: Gather Content (algorithmic) ───────────────────────────────

   private selectTopPages(
      urls: { title: string; url: string; snippet: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[],
   ): { title: string; url: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[] {
      const maxPages = this.config.maxPagesPerRound;

      // Group by source type
      const byType = new Map<string, { title: string; url: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[]>();
      for (const u of urls) {
         const existing = byType.get(u.sourceType) ?? [];
         existing.push({ title: u.title, url: u.url, sourceType: u.sourceType, ...(u.extraSnippet ? { extraSnippet: u.extraSnippet } : {}), ...(u.deepLinks ? { deepLinks: u.deepLinks } : {}) });
         byType.set(u.sourceType, existing);
      }

      // Phase 1: take at least 1 from each source type that has results (diversity guarantee)
      const selected: { title: string; url: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[] = [];
      const types = [...byType.keys()];
      for (const type of types) {
         const group = byType.get(type);
         const pick = group?.shift();
         if (pick) selected.push(pick);
      }

      // Phase 2: fill remaining slots round-robin from what's left
      const typeOrder: Record<string, number> = {
         academic: 0, documentation: 1, github: 2, web: 3,
         news: 4, hackernews: 5, reddit: 6, youtube: 7, stackoverflow: 8,
      };
      const remaining = [...byType.entries()]
         .filter(([, group]) => group.length > 0)
         .sort(([a], [b]) => (typeOrder[a] ?? 5) - (typeOrder[b] ?? 5));

      let idx = 0;
      while (selected.length < maxPages && remaining.length > 0) {
         const typeIdx = idx % remaining.length;
         const entry = remaining[typeIdx];
         if (entry) {
            const [, group] = entry;
            const pick = group.shift();
            if (pick) selected.push(pick);
            if (group.length === 0) {
               remaining.splice(typeIdx, 1);
               idx = 0;
               continue;
            }
         }
         idx++;
      }

      return selected.slice(0, maxPages);
   }

   /**
    * Fetch pages algorithmically — no LLM calls.
    * Returns content with quality assessment for each page.
    */
   private async gatherContent(
      pages: { title: string; url: string; sourceType: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[],
   ): Promise<FetchedPage[]> {
      const results: FetchedPage[] = [];
      const chunks = this.chunkArray(pages, this.config.readConcurrency);

      for (const chunk of chunks) {
         const chunkResults = await Promise.allSettled(
            chunk.map(async (page) => {
               try {
                  const content = await this.readPage(page.url, page.extraSnippet);
                  if (!content || content.trim().length < 200) {
                     logger.info({ url: page.url }, 'WorkerAgent: page too short, skipping');
                     return null;
                  }

                  const quality = quickQuality(content, page.url, page.title);

                  // Skip promotional or very low quality pages
                  if (quality.isPromotional && quality.contentDepth < 0.4) {
                     logger.info(
                        { url: page.url, depth: String(quality.contentDepth) },
                        'WorkerAgent: skipping promotional/low-quality page',
                     );
                     return null;
                  }

                  return {
                     url: page.url,
                     title: page.title,
                     sourceType: page.sourceType,
                     content,
                     quality,
                  };
               } catch (err) {
                  logger.warn({ url: page.url, err }, 'WorkerAgent: page fetch failed');
                  return null;
               }
            }),
         );

         for (const result of chunkResults) {
            if (result.status === 'fulfilled' && result.value !== null) {
               results.push(result.value);
            }
         }
      }

      return results;
   }

   private async readPage(url: string, extraSnippet?: string): Promise<string | null> {
      // Check semantic content cache first (pre-fetched by youtube/reddit/etc.)
      const cached = this.semanticContentCache.get(url);
      if (cached && cached.trim().length > 100) {
         return truncate(cached, this.config.maxContentCharsPerPage);
      }

      // Use rich search result content when available (Tavily raw_content, Exa text/highlights)
      // — avoids a redundant webRead round-trip
      if (extraSnippet && extraSnippet.trim().length > 200) {
         return truncate(extraSnippet, this.config.maxContentCharsPerPage);
      }

      try {
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

   // ── Phase 4: Compact Content (algorithmic) ──────────────────────────────

   /**
    * Algorithmically compact all fetched pages into a single context block.
    *
    * For each page:
    *   1. Split into sections by markdown headings
    *   2. Score each section by keyword relevance to the research question
    *   3. Select top sections across all pages until char budget reached
    *   4. Format with [Source: title](url) > section heading attribution
    *
    * No LLM calls.
    */
   private compactContent(pages: FetchedPage[], question: string): CompactBlock[] {
      // Tokenize question into a set of significant terms for relevance scoring
      const questionTerms = this.extractSignificantTerms(question);
      const maxChars = this.config.maxContextChars;
      const blocks: CompactBlock[] = [];

      for (const page of pages) {
         const sections = this.splitIntoSections(page.content);
         for (const [heading, text] of sections) {
            if (text.length < 80) continue; // skip trivial sections
            const score = this.computeRelevance(text, heading, questionTerms);
            blocks.push({
               url: page.url,
               title: page.title,
               section: heading,
               text,
               score,
               sourceType: page.sourceType,
            });
         }
      }

      // Sort by relevance score descending
      blocks.sort((a, b) => b.score - a.score);

      // Select top blocks until char budget reached
      const selected: CompactBlock[] = [];
      let totalChars = 0;
      for (const block of blocks) {
         const blockLen = block.text.length + block.url.length + block.section.length + 50; // overhead
         if (totalChars + blockLen > maxChars) {
            // Take a truncated version if this is a high-value block
            if (block.score > 0.3 && selected.length < 3) {
               const truncated = truncate(block.text, Math.min(block.text.length, maxChars - totalChars));
               selected.push({ ...block, text: truncated });
               totalChars += truncated.length;
            }
            continue;
         }
         selected.push(block);
         totalChars += blockLen;
      }

      // If we have very few blocks, expand the budget by including snippets
      if (selected.length < 3 && blocks.length > selected.length) {
         for (const block of blocks) {
            if (selected.includes(block)) continue;
            if (totalChars >= maxChars * 1.5) break;
            const snippet = block.text.length > 500 ? block.text.slice(0, 500) + '...' : block.text;
            selected.push({ ...block, text: snippet });
            totalChars += snippet.length;
         }
      }

      return selected;
   }

   /**
    * Split markdown content into sections by heading boundaries.
    * Returns [(heading, body_text)] pairs.
    */
   private splitIntoSections(content: string): [string, string][] {
      const sections: [string, string][] = [];
      // Split on markdown headings (##, ###, etc.), keeping heading text
      const headingRegex = /^(#{1,6})\s+(.+)$/gm;
      let lastIndex = 0;
      let lastHeading = 'Introduction';
      let match: RegExpExecArray | null;

      while ((match = headingRegex.exec(content)) !== null) {
         const sectionStart = lastIndex;
         // If we have content before the next heading, record it
         if (sectionStart < match.index) {
            const body = content.slice(sectionStart, match.index).trim();
            if (body.length > 0) {
               sections.push([lastHeading, body]);
            }
         }
         lastHeading = (match[2] ?? 'Content').trim();
         lastIndex = match.index + match[0].length;
      }

      // Last section (after final heading)
      const remaining = content.slice(lastIndex).trim();
      if (remaining.length > 0) {
         sections.push([lastHeading, remaining]);
      }

      // If no headings found, treat entire content as one section
      if (sections.length === 0 && content.trim().length > 0) {
         sections.push(['Content', content.trim()]);
      }

      return sections;
   }

   /**
    * Extract significant terms from a question for relevance matching.
    * Filters out common stopwords and short words.
    */
   private extractSignificantTerms(question: string): Set<string> {
      const stopwords = new Set([
         'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
         'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
         'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
         'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
         'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
         'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
         'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
         'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
         'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
         'just', 'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
         'these', 'those', 'it', 'its', 'what', 'which', 'who', 'whom',
         'about', 'up', 'down',
      ]);

      const terms = new Set<string>();
      const words = question.toLowerCase().split(/[^a-z0-9]+/);
      for (const word of words) {
         if (word.length > 2 && !stopwords.has(word)) {
            terms.add(word);
            // Add bigrams for multi-word terms
         }
      }

      // Also add 2-word and 3-word phrases
      for (let i = 0; i < words.length - 1; i++) {
         const word1 = words[i];
         const word2 = words[i + 1];
         if (word1 !== undefined && word2 !== undefined) {
            const bigram = `${word1} ${word2}`;
            if (bigram.replace(/\s/g, '').length > 4) {
               terms.add(bigram);
            }
         }
      }
      for (let i = 0; i < words.length - 2; i++) {
         const word1 = words[i];
         const word2 = words[i + 1];
         const word3 = words[i + 2];
         if (word1 !== undefined && word2 !== undefined && word3 !== undefined) {
            const trigram = `${word1} ${word2} ${word3}`;
            if (trigram.replace(/\s/g, '').length > 6) {
               terms.add(trigram);
            }
         }
      }

      return terms;
   }

   /**
    * Compute relevance score for a section of text against question terms.
    * Uses TF-like scoring with heading boost.
    */
   private computeRelevance(text: string, heading: string, questionTerms: Set<string>): number {
      if (questionTerms.size === 0) return 0.5; // neutral score if no terms

      const lowerText = text.toLowerCase();
      const lowerHeading = heading.toLowerCase();
      let score = 0;
      let matches = 0;

      for (const term of questionTerms) {
         // Check heading (weighted higher)
         if (lowerHeading.includes(term)) {
            score += 3.0;
            matches++;
         }
         // Check text body
         const count = (lowerText.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
         if (count > 0) {
            score += Math.min(count, 5) * 1.0;
            matches++;
         }
      }

      // Normalize by text length to avoid bias toward long sections
      const lengthNorm = Math.min(1, text.length / 2000);
      const matchRatio = matches / Math.max(1, questionTerms.size);

      // Combine: term frequency + match coverage + heading bonus
      const normalizedScore = (score / Math.max(1, questionTerms.size * 3)) * 0.6
         + matchRatio * 0.3
         + lengthNorm * 0.1;

      return Math.min(1, normalizedScore);
   }

   // ── Phase 5: Synthesize from Compacted Content (single LLM call) ───────

   /**
    * Single LLM synthesis call from pre-compacted content.
    *
    * The LLM receives all compacted source blocks and the research question,
    * then produces a structured output with findings and sub-threads.
    * This is synthesis, not extraction — content is already relevant and condensed.
    */
   private async synthesizeFromCompacted(
      question: string,
      compacted: CompactBlock[],
      _sources: WorkerSource[],
   ): Promise<{ findings: WorkerFinding[]; subThreads: SubThread[]; tokensUsed: number }> {
      if (compacted.length === 0) {
         logger.info({ question: truncate(question, 60) }, 'WorkerAgent: no compacted content to synthesize');
         return { findings: [], subThreads: [], tokensUsed: 0 };
      }

      // Build compacted context block with source attribution
      const contextParts: string[] = [];
      contextParts.push(`Research question: ${question}`);
      contextParts.push('');
      const uniqueSources = new Map<string, string>();
      for (const block of compacted) {
         if (!uniqueSources.has(block.url)) {
            uniqueSources.set(block.url, block.sourceType);
         }
      }
      contextParts.push(`--- Compacted source content (${String(compacted.length)} sections from ${String(uniqueSources.size)} sources: ${[...new Set(uniqueSources.values())].join(', ')}) ---`);
      contextParts.push('');

      for (let i = 0; i < compacted.length; i++) {
         const block = compacted[i];
         if (block) {
            contextParts.push(`[Source ${String(i + 1)}] ${block.title} (${block.sourceType})`);
            contextParts.push(`URL: ${block.url}`);
            contextParts.push(`Section: ${block.section}`);
            contextParts.push('');
            contextParts.push(block.text);
            contextParts.push('---');
            contextParts.push('');
         }
      }

      const compactedText = contextParts.join('\n');

      const prompt = `You are a research analyst synthesizing findings from pre-compiled source material.

Research question: ${question}

Below is compacted source content from multiple pages. Each section is attributed to its source URL.

Your task:
1. Identify the key findings relevant to the research question
2. For each finding, note which source(s) support it (by source number)
3. Suggest follow-up sub-threads worth investigating

Output ONLY valid JSON:
{
  "findings": [
    {
      "claim": "Concise factual claim relevant to the question",
      "evidence": "Brief supporting evidence from the sources",

      "caveats": "Any limitations or uncertainties"
    }
  ],
  "subThreads": [
    {
      "question": "Follow-up question for further investigation",
      "rationale": "Why this is worth investigating",
      "priority": 2,
      "suggestedSourceTypes": ["web", "academic"]
    }
  ]
}`;

      try {
         const result = await this.llm.callJSON<{
            findings: { claim: string; evidence: string; caveats?: string }[];
            subThreads: SubThread[];
         }>({
            model: 'worker',
            messages: [
               {
                  role: 'system',
                  content: 'You are a research synthesis analyst. Read compacted source material and produce structured findings. Output ONLY valid JSON.',
               },
               { role: 'user', content: `${prompt}\n\n${compactedText}` },
            ],
            temperature: 0.3,
            timeoutMs: this.config.llmTimeoutMs,
            maxTokens: 4000,
            responseFormat: 'json_object',
         });

         if (result.success) {
            // Map source numbers in evidence to actual URLs
            const findings = result.data.findings.map((f) => ({
               id: makeId(),
               claim: f.claim,
               evidence: f.evidence,
               sourceUrls: this.resolveSourceUrls(f.evidence, compacted),
               ...(f.caveats !== undefined ? { caveats: f.caveats } : {}),
            }));

            const subThreads = result.data.subThreads;
            return { findings, subThreads, tokensUsed: result.response.tokensUsed };
            }
         logger.warn('WorkerAgent LLM synthesis call failed');
         return { findings: [], subThreads: [], tokensUsed: 0 };
      } catch (err) {
         logger.warn({ err }, 'WorkerAgent LLM synthesis error');
         return { findings: [], subThreads: [], tokensUsed: 0 };
      }
   }

   /**
    * Resolve source URLs from an evidence string by matching [Source N] references.
    */
   private resolveSourceUrls(evidence: string, compacted: CompactBlock[]): string[] {
      const urls: string[] = [];
      const refRegex = /\[Source (\d+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(evidence)) !== null) {
         const sourceNum = match[1];
         if (sourceNum !== undefined) {
            const idx = parseInt(sourceNum, 10) - 1;
            const block = compacted[idx];
            if (block && !urls.includes(block.url)) {
               urls.push(block.url);
            }
         }
      }
      // Fallback: include all source URLs if no specific references found
      if (urls.length === 0 && compacted.length > 0) {
         const firstBlock = compacted[0];
         if (firstBlock) {
            urls.push(firstBlock.url);
         }
      }
      return urls;
   }

   // ── Phase 6: Chase Sub-Threads (restructured, same pattern) ────────────

   /**
    * Chase a single sub-thread using the same gather→compact→synthesize pattern.
    * No per-page LLM extraction.
    */
   private async chaseSubThread(
      thread: SubThread,
      _parentQuestion: string,
   ): Promise<{ findings: WorkerFinding[]; sources: WorkerSource[]; tokensUsed: number }> {
      let totalTokens = 0;
      const allFindings: WorkerFinding[] = [];
      const allSources: WorkerSource[] = [];

      // Search for the sub-thread question
      const searchPromises: Promise<{ title: string; url: string; snippet: string; sourceType: string; extraSnippet?: string }[]>[] = [];

      if (thread.suggestedSourceTypes.includes('web') || thread.suggestedSourceTypes.length === 0) {
         searchPromises.push(
            this.tools.webSearch(thread.question, 5).then((r) =>
               r.map((x) => ({
                  title: x.title,
                  url: x.url,
                  snippet: x.description,
                  sourceType: 'web',
                  ...(x.extraSnippet !== undefined ? { extraSnippet: x.extraSnippet } : {}),
               })),
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
      // Always include reddit, hackernews, youtube for sub-thread diversity
      searchPromises.push(
         this.tools.redditSearch(thread.question, 3).then((r) =>
            r.map((x) => ({ title: x.title, url: x.url, snippet: x.selftext ?? '', sourceType: 'reddit' })),
         ).catch(() => []),
      );
      searchPromises.push(
         this.tools.hackernewsSearch(thread.question, 3).then((r) =>
            r.map((x) => ({ title: x.title, url: x.url, snippet: x.text ?? '', sourceType: 'hackernews' })),
         ).catch(() => []),
      );

      const settled = await Promise.allSettled(searchPromises);
      const urls: { title: string; url: string; sourceType: string; extraSnippet?: string }[] = [];
      for (const result of settled) {
         if (result.status === 'fulfilled') {
            for (const u of result.value) {
               urls.push({
                  title: u.title,
                  url: u.url,
                  sourceType: u.sourceType,
                  ...(u.extraSnippet !== undefined ? { extraSnippet: u.extraSnippet } : {}),
               });
            }
         }
      }

      // Gather top pages (increased for source diversity)
      const topPages = urls.slice(0, 5);
      const fetchedPages: FetchedPage[] = [];

      for (const page of topPages) {
         try {
            const content = await this.readPage(page.url, page.extraSnippet);
            if (!content || content.trim().length < 200) continue;

            const quality = quickQuality(content, page.url, page.title);
            if (quality.isPromotional && quality.contentDepth < 0.4) continue;

            fetchedPages.push({
               url: page.url,
               title: page.title,
               sourceType: page.sourceType,
               content,
               quality,
            });

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

      // Compact and synthesize
      if (fetchedPages.length > 0) {
         const compacted = this.compactContent(fetchedPages, thread.question);
         if (compacted.length > 0) {
            const synthesisResult = await this.synthesizeFromCompacted(
               thread.question,
               compacted,
               allSources,
            );
            totalTokens += synthesisResult.tokensUsed;
            allFindings.push(...synthesisResult.findings);
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

   private buildNarrativeSummary(
      question: string,
      findings: WorkerFinding[],
      sources: WorkerSource[],
   ): string {
      if (findings.length === 0) {
         return `No substantive findings were discovered for "${question}". ${String(sources.length)} source(s) were examined but did not yield extractable claims.`;
      }

      const substantiveSources = sources.filter((s) => s.quality.isSubstantive).length;
      const promotionalSources = sources.filter((s) => s.quality.isPromotional).length;

      // Count by source type
      const typeCounts = new Map<string, number>();
      for (const s of sources) {
         typeCounts.set(s.sourceType, (typeCounts.get(s.sourceType) ?? 0) + 1);
      }
      const typeSummary = [...typeCounts.entries()]
         .sort(([, a], [, b]) => b - a)
         .map(([type, count]) => `${String(count)} ${type}`)
         .join(', ');

      const parts: string[] = [];
      parts.push(
         `Investigation of "${question}" yielded ${String(findings.length)} finding(s) from ${String(sources.length)} source(s) (${typeSummary})`,
      );

      if (substantiveSources > 0) {
         parts.push(`across ${String(substantiveSources)} substantive source(s)`);
      }
      if (promotionalSources > 0) {
         parts.push(`(${String(promotionalSources)} promotional source(s) were examined but down-weighted)`);
      }

      // Add top finding
      const firstFinding = findings[0];
      if (firstFinding) {
         parts.push(` Key finding: "${truncate(firstFinding.claim, 200)}"`);
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
