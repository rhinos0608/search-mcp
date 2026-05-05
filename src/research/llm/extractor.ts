/**
 * LlmExtractor — LLM-based extraction subagent for deep research.
 *
 * Wraps the worker LLM to extract structured findings from source content,
 * backed by the 3D confidence model and with fallback to regex-based extraction.
 *
 * Phase 4: V4.0.0 Deep Research — LLM extraction agent.
 */

import { DeepResearchLlmClient, type TokenBudget } from './chat.js';
import { WORKER_EXTRACT } from './prompts.js';
import { computeExtractionConfidence } from '../confidence.js';
import { confidenceToLabel, type ResearchStateEngine } from '../state.js';
import { logger } from '../../logger.js';
import { webRead } from '../../tools/webRead.js';
import { extractSentence } from '../extractSentence.js';
import { loadConfig } from '../../config.js';
import { extractWithRAGA } from '../../utils/ragAnythingClient.js';
import { isDocumentUrl } from '../../utils/documentUtils.js';
import { attemptExternalRecovery } from '../../utils/externalRecovery.js';
import { semanticCrawl } from '../../tools/semanticCrawl.js';
import { getYouTubeTranscript } from '../../tools/youtubeTranscript.js';
import { redditComments } from '../../tools/redditComments.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

import type { SourceEntry, EvidenceDirectness, ClaimType, SubQuestion, Finding } from '../types.js';

// ── Content attempt types ───────────────────────────────────────────────────────

/** How content was acquired for a given extraction attempt. */
type ContentMethod = 'raga' | 'webRead' | 'wayback' | 'semantic_crawl' | 'youtube_transcript' | 'reddit_comments';

/** Return type from a fetchContent function. */
interface FetchContentResult {
   content: string;
   title: string;
   success: boolean;
   /** Which recovery source actually provided the content (known after fetch). */
   recoverySource?: 'wayback' | 'google-cache';
}

/** A single content candidate with metadata about its provenance. */
interface ContentAttempt {
   method: ContentMethod;
   /** Async function that fetches this candidate's content. */
   fetchContent: () => Promise<FetchContentResult>;
   /** True if content came directly from the source URL (not a cache/adjacent source). */
   isOriginalSource: boolean;
   /** True if content was recovered from an archive/cache. */
   isRecoveredContent: boolean;
   /** Populated after fetchContent resolves. */
   fetchedContent?: string;
   fetchedTitle?: string;
   /** Which recovery source provided the content (set after fetch resolves). */
   recoverySource?: 'wayback' | 'google-cache';
}

/** Result of a single extraction attempt on one content candidate. */
interface ExtractionAttemptResult {
   findingIds: string[];
   method: ContentMethod;
   usedRegex: boolean;
   contentQualitySkipped: boolean;
}

// ── Content quality heuristics ─────────────────────────────────────────────────

/**
 * Quick heuristic check to skip expensive LLM extraction on obviously
 * low-quality or non-extractable content. Returns true when content
 * is likely unsuitable for extraction.
 */
function isContentLowQuality(content: string, _url: string, title: string): boolean {
   if (!content || content.trim().length < 300) return true;

   // High link density → listing/nav page, not article content
   // Measure actual link character proportion, not estimated
   const linkMatches = content.match(/\[.*?\]\(https?:\/\/[^)]+\)/g);
   if (linkMatches) {
      const totalLinkChars = linkMatches.reduce((sum, m) => sum + m.length, 0);
      if (totalLinkChars / content.length > 0.15) return true;
   }

   // Bad fetch / blocked content signals
   const badSignals = [
      /enable\s+(JavaScript|Javascript)/i,
      /access\s+denied/i,
      /please\s+allow\s+(cookies|javascript)/i,
      /subscribe\s+to\s+continue/i,
      /sign\s+in\s+to\s+read/i,
   ];
   if (badSignals.some((p) => p.test(content))) return true;

   // Listing/video/podcast page signals in title — phrase-level matching
   const listingSignals = [
      /\btopic\s+(page|index|list|archive)\b/i,
      /\btag\s+archive\b/i,
      /\bcategory\s+(page|index|list|archive)\b/i,
      /\bvideo\s+(page|index|list|gallery)\b/i,
      /\bpodcast\s+(page|index|list|archive|episode)\b/i,
   ];
   if (listingSignals.some((p) => p.test(title))) return true;

   return false;
}

// ── HTML-to-text helper (mirrors extraction.ts) ─────────────────────────────────

/**
 * Parse raw HTML through JSDOM + Readability to extract readable text.
 * Returns null if Readability cannot produce meaningful output.
 */
function parseHtmlToMarkdown(html: string, url: string): string | null {
   try {
      const dom = new JSDOM(html, { url });
      try {
         const reader = new Readability(dom.window.document);
         const article = reader.parse();
         if (article?.textContent && article.textContent.trim().length > 0) {
            return article.textContent.slice(0, 50_000);
         }
         const bodyText = dom.window.document.body.textContent;
         if (bodyText && bodyText.trim().length > 100) {
            return bodyText.slice(0, 50_000);
         }
         return null;
      } finally {
         dom.window.close();
      }
   } catch {
      return null;
   }
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface LlmExtractorConfig {
   /** Max concurrent LLM calls. */
   concurrency: number;
   /** Max characters per extraction call (source content truncation). */
   maxContentChars: number;
}

const DEFAULT_CONFIG: LlmExtractorConfig = {
   concurrency: 3,
   maxContentChars: 8000,
};

// ── LLM response shape ────────────────────────────────────────────────────

interface LlmFinding {
   claim: string;
   evidenceExcerpt: string;
   confidence: number;
   evidenceDirectness: EvidenceDirectness;
   claimType: ClaimType;
}

interface LlmExtractResponse {
   findings: LlmFinding[];
}

// ── Fallback regex patterns ───────────────────────────────────────────────

interface FallbackPattern {
   name: string;
   patterns: RegExp[];
   claimType: ClaimType;
   evidenceDirectness: EvidenceDirectness;
}

const FALLBACK_PATTERNS: FallbackPattern[] = [
   {
      name: 'mechanism',
      patterns: [
         /\b(uses?|utilizes?|employs?|leverages?|implements?)\s+\w+/i,
         /\b(operates?|functions?|runs)\s+(by|through|via)\b/i,
         /\bis\s+(built|constructed|designed|architected)\s+(on|using|around|with)\b/i,
      ],
      claimType: 'primary' as const,
      evidenceDirectness: 'direct' as const,
   },
   {
      name: 'benchmark',
      patterns: [
         /\b(outperforms?|surpasses?|beats?|exceeds?)\b/i,
         /\b(accuracy|precision|recall|f1|performance)\s+(of|:)\s*\d+/i,
      ],
      claimType: 'primary' as const,
      evidenceDirectness: 'direct' as const,
   },
   {
      name: 'comparison',
      patterns: [
         /\bcompared?\s+to\b/i,
         /\b(versus|vs\.?)\b/i,
         /\btrade[-–\s]?off\s+(between|among)\b/i,
         /\bin\s+contrast\s+to\b/i,
         /\b(more|less)\s+\w+\s+than\b/i,
      ],
      claimType: 'primary' as const,
      evidenceDirectness: 'near-direct' as const,
   },
   {
      name: 'failure-mode',
      patterns: [
         /\blimitation\s+is\b/i,
         /\bstruggles?\s+with\b/i,
         /\b(drawback|downside|shortcoming|weakness|caveat)\b/i,
         /\b(problematic|challenging|difficult)\s+(when|for|in|with)\b/i,
         /\bnot\s+(suitable|designed|intended)\s+for\b/i,
         /\bmajor\s+(issue|problem|concern|limitation)\b/i,
      ],
      claimType: 'primary' as const,
      evidenceDirectness: 'direct' as const,
   },
   {
      name: 'recommendation',
      patterns: [/\brecommend(s|ed|ation)?\b/i, /\bshould\s+(use|consider|adopt|avoid)\b/i],
      claimType: 'secondary' as const,
      evidenceDirectness: 'secondary' as const,
   },
];

// ── Extractor ─────────────────────────────────────────────────────────────

export class LlmExtractor {
   private readonly config: LlmExtractorConfig;

   constructor(
      private llm: DeepResearchLlmClient,
      private state: ResearchStateEngine,
      private budget: TokenBudget | undefined,
      config?: Partial<LlmExtractorConfig>,
   ) {
      this.config = { ...DEFAULT_CONFIG, ...config };
   }

   /**
    * Extract findings from a set of source entries.
    * Uses worker LLM for each source with WORKER_EXTRACT prompt.
    * Falls back to rule-based extraction on failure.
    * Returns Finding IDs created on the state engine.
    */
   async extract(sources: SourceEntry[], subQuestions: SubQuestion[]): Promise<string[]> {
      const pending = sources.filter((s) => s.extractionStatus === 'pending');

      if (pending.length === 0) {
         logger.info('llm-extractor: no pending sources to extract');
         return [];
      }

      if (this.state.getBudget().isExhausted()) {
         logger.warn('llm-extractor: budget exhausted before extraction');
         return [];
      }

      logger.info({ count: pending.length }, 'llm-extractor: starting extraction');

      const allFindingIds: string[] = [];
      const subQuestionMap = new Map(subQuestions.map((sq) => [sq.id, sq]));

      // ── Semaphore ──────────────────────────────────────────────────────
      // Pattern from src/rag/contextualEmbedding.ts — parallel work pool
      // with bounded concurrency.

      let permits = Math.min(this.config.concurrency, pending.length);
      const waiters: (() => void)[] = [];
      let cursor = 0;

      const acquire = (): Promise<void> => {
         if (permits > 0) {
            permits--;
            return Promise.resolve();
         }
         return new Promise<void>((resolve) => {
            waiters.push(resolve);
         });
      };

      const release = (): void => {
         const next = waiters.shift();
         if (next) {
            next();
            return;
         }
         permits++;
      };

      // ── Worker pool ────────────────────────────────────────────────────

      const worker = async (): Promise<void> => {
         for (; ;) {
            if (this.state.getBudget().isExhausted()) break;

            await acquire();

            const idx = cursor++;
            if (idx >= pending.length) {
               release();
               return;
            }

            const source = pending[idx];
            if (!source) {
               release();
               return;
            }

            // Reserve an extraction slot in the budget
            if (!this.state.getBudget().recordExtraction()) {
               logger.warn({ sourceId: source.id }, 'llm-extractor: extraction budget exceeded');
               this.state.markSourceFailed(source.id);
               release();
               break;
            }

            try {
               const findingIds = await this.extractSingleSource(source, subQuestionMap);
               allFindingIds.push(...findingIds);
            } catch (err) {
               logger.error(
                  { err, sourceId: source.id, url: source.url },
                  'llm-extractor: unexpected error processing source',
               );
               this.state.markSourceFailed(source.id);
            } finally {
               release();
            }
         }
      };

      const workerCount = Math.min(this.config.concurrency, pending.length);
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);

      logger.info({ totalFindings: allFindingIds.length }, 'llm-extractor: complete');
      return allFindingIds;
   }

   // ── Single source extraction (attempt pipeline) ───────────────────────────

   /**
    * Extract findings from a single source using a multi-attempt pipeline.
    *
    * For each content attempt (ordered by fidelity to the original source):
    *   1. Fetch candidate content
    *   2. Skip if low quality (heuristic)
    *   3. Try LLM extraction
    *   4. If LLM returns zero findings, try regex fallback
    *   5. If any extraction yields findings, register and return
    *
    * Stops at the first content attempt that yields findings.
    * Falls through to the next candidate only when both LLM and regex
    * produce nothing on the current candidate.
    */
   private async extractSingleSource(
      source: SourceEntry,
      subQuestionMap: Map<string, SubQuestion>,
   ): Promise<string[]> {
      // Build query text from relevant sub-questions
      const relevantSubQuestionTexts = source.relevantSubQuestions
         .map((sqId) => subQuestionMap.get(sqId)?.text)
         .filter((t): t is string => !!t);
      const queryText = this.getRelevantQuestionText(relevantSubQuestionTexts, source.title);

      // Generate ordered content candidates
      const attempts = this.generateContentAttempts(source, queryText);

      for (const attempt of attempts) {
         if (this.state.getBudget().isExhausted()) break;

         logger.info(
            { sourceId: source.id, url: source.url, method: attempt.method },
            'llm-extractor: content attempt started',
         );

         // Fetch content for this candidate
         const fetchResult = await attempt.fetchContent();

         if (!fetchResult.success || !fetchResult.content) {
            logger.warn(
               { sourceId: source.id, url: source.url, method: attempt.method },
               'llm-extractor: content attempt fetch failed',
            );
            continue;
         }

         // Store fetched metadata on the attempt object
         attempt.fetchedContent = fetchResult.content;
         attempt.fetchedTitle = fetchResult.title;
         if (fetchResult.recoverySource) {
            attempt.recoverySource = fetchResult.recoverySource;
         }

         // Run the extraction pipeline on this content candidate
         const result = await this.tryExtractFromContent(source, attempt, relevantSubQuestionTexts);

         if (result.findingIds.length > 0) {
            logger.info(
               {
                  sourceId: source.id,
                  url: source.url,
                  method: attempt.method,
                  findings: result.findingIds.length,
                  usedRegex: result.usedRegex,
               },
               'llm-extractor: extraction succeeded on content attempt',
            );
            this.state.markSourceExtracted(source.id);
            return result.findingIds;
         }

         logger.warn(
            {
               sourceId: source.id,
               url: source.url,
               method: attempt.method,
               contentQualitySkipped: result.contentQualitySkipped,
            },
            'llm-extractor: extraction attempt yielded no findings',
         );
      }

      // All attempts exhausted
      logger.warn(
         { sourceId: source.id, url: source.url, attempts: attempts.length },
         'llm-extractor: all content attempts exhausted without findings',
      );
      this.state.markSourceFailed(source.id);
      return [];
   }

   // ── Content attempt generation ────────────────────────────────────────────

   /**
    * Build a query string from relevant sub-questions for use in
    * content discovery (semantic crawl). Joins up to 3 sub-questions.
    */
   private getRelevantQuestionText(
      relevantSubQuestionTexts: string[],
      fallbackTitle: string,
   ): string {
      if (relevantSubQuestionTexts.length === 0) return fallbackTitle;
      return relevantSubQuestionTexts.slice(0, 3).join(' ');
   }

   /**
    * Generate an ordered list of content candidates for a source.
    *
    * Order (highest fidelity to original source first):
    *   1. Primary: RAG-Anything (for document URLs) / webRead
    *   2. External recovery: Wayback Machine → Google Cache
    *   3. Semantic crawl: query-targeted content from the same URL
    *
    * Each attempt carries a lazy fetch function and provenance metadata
    * so extracted findings can be attributed correctly.
    */
   private generateContentAttempts(source: SourceEntry, queryText: string): ContentAttempt[] {
      const attempts: ContentAttempt[] = [];

      // ── Attempt 0 (source-specific): YouTube transcript ──────────────────
      if (source.sourceType === 'youtube') {
         attempts.push({
            method: 'youtube_transcript',
            fetchContent: async () => this.fetchYoutubeTranscriptContent(source),
            isOriginalSource: true,
            isRecoveredContent: false,
         });
      }

      // ── Attempt 0 (source-specific): Reddit comments ────────────────────
      if (source.sourceType === 'reddit') {
         attempts.push({
            method: 'reddit_comments',
            fetchContent: async () => this.fetchRedditCommentContent(source),
            isOriginalSource: true,
            isRecoveredContent: false,
         });
      }

      // ── Attempt 1: Primary source (RAGA for documents, webRead otherwise) ──
      attempts.push({
         method: isDocumentUrl(source.url) ? 'raga' : 'webRead',
         fetchContent: async () => {
            if (isDocumentUrl(source.url)) return this.fetchRagaContent(source.url);
            return this.fetchPrimaryContent(source.url);
         },
         isOriginalSource: true,
         isRecoveredContent: false,
      });

      // ── Attempt 2: External recovery (Wayback Machine / Google Cache) ──────
      attempts.push({
         method: 'wayback',
         fetchContent: async () => this.fetchRecoveredContent(source.url),
         isOriginalSource: false,
         isRecoveredContent: true,
      });

      // ── Attempt 3: Semantic crawl (query-targeted, source-adjacent) ────────
      if (queryText) {
         attempts.push({
            method: 'semantic_crawl',
            fetchContent: async () => this.fetchFromSemanticCrawl(source.url, queryText),
            isOriginalSource: false,
            isRecoveredContent: false,
         });
      }

      return attempts;
   }

   // ── Content fetching: primary ────────────────────────────────────────────

   /**
    * Primary content fetch via webRead (Readability-based).
    */
   private async fetchPrimaryContent(url: string): Promise<FetchContentResult> {
      try {
         const article = await webRead(url);
         const content = article.textContent || article.content || '';
         if (content && content.trim().length > 0) {
            return { content, title: article.title ?? '', success: true };
         }
         logger.warn({ url }, 'llm-extractor: webRead returned empty content');
         return { content: '', title: article.title ?? '', success: false };
      } catch (err) {
         logger.warn(
            { url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: webRead failed',
         );
         return { content: '', title: '', success: false };
      }
   }

   /**
    * Primary content fetch via RAG-Anything for document URLs.
    */
   private async fetchRagaContent(url: string): Promise<FetchContentResult> {
      const config = loadConfig();
      if (!config.raga.enabled || !config.raga.baseUrl) {
         // RAGA not configured, fall straight through to webRead
         return this.fetchPrimaryContent(url);
      }
      try {
         const result = await extractWithRAGA(url);
         if (result.markdown && result.markdown.trim().length > 0) {
            logger.info({ url, parser: result.parserUsed }, 'llm-extractor: RAGA succeeded');
            return { content: result.markdown, title: result.title ?? '', success: true };
         }
         logger.warn({ url }, 'llm-extractor: RAGA returned empty content');
      } catch (ragaErr) {
         logger.warn(
            { url, err: ragaErr instanceof Error ? ragaErr.message : String(ragaErr) },
            'llm-extractor: RAGA failed',
         );
      }
      // Fall through to webRead
      return this.fetchPrimaryContent(url);
   }

   // ── Content fetching: YouTube transcript ──────────────────────────────────

   /**
    * Fetch YouTube transcript content for a source.
    * Uses the youtube-transcript free API (no key required).
    */
   private async fetchYoutubeTranscriptContent(source: SourceEntry): Promise<FetchContentResult> {
      try {
         const result = await getYouTubeTranscript(source.url);
         if (!result.fullText || result.fullText.length < 20) {
            return { content: '', title: source.title, success: false };
         }
         return { content: result.fullText, title: source.title, success: true };
      } catch (err) {
         logger.warn(
            { url: source.url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: youtube transcript fetch failed',
         );
         return { content: '', title: '', success: false };
      }
   }

   // ── Content fetching: Reddit comments ────────────────────────────────────

   /**
    * Fetch Reddit comment content for a source.
    * Uses the free Reddit JSON API to fetch the full comment thread.
    */
   private async fetchRedditCommentContent(source: SourceEntry): Promise<FetchContentResult> {
      try {
         const REDDIT_BASE_URL = 'https://www.reddit.com';
         const postUrl = source.url.startsWith('/r/')
            ? `${REDDIT_BASE_URL}${source.url}`
            : source.url;

         const result = await redditComments({ url: postUrl }, {});

         // Flatten comment tree
         function flattenComments(items: unknown[]): { body: string; id: string; author: string; permalink: string; parentId: string; score: number; createdUtc: number; depth: number; stickied: boolean }[] {
            const flat: { body: string; id: string; author: string; permalink: string; parentId: string; score: number; createdUtc: number; depth: number; stickied: boolean }[] = [];
            for (const item of items) {
               if (item && typeof item === 'object' && 'body' in item) {
                  const c = item as { body: string; id: string; author: string; permalink: string; parentId: string; score: number; createdUtc: number; depth: number; stickied: boolean; replies: unknown[] };
                  flat.push({
                     body: c.body,
                     id: c.id,
                     author: c.author,
                     permalink: REDDIT_BASE_URL + c.permalink,
                     parentId: c.parentId,
                     score: c.score,
                     createdUtc: c.createdUtc,
                     depth: c.depth,
                     stickied: c.stickied,
                  });
                  if (Array.isArray(c.replies)) {
                     flat.push(...flattenComments(c.replies));
                  }
               }
            }
            return flat;
         }

         const flatComments = flattenComments(result.comments);
         if (flatComments.length === 0) {
            return { content: '', title: source.title, success: false };
         }

         // Build a flat text representation for LLM extraction
         const commentText = flatComments
            .map((c) => `[${c.author}]: ${c.body}`)
            .join('\n\n');

         const content = `Post title: ${result.post.title}\n\n--- Comments ---\n${commentText}`;

         return { content, title: result.post.title, success: true };
      } catch (err) {
         logger.warn(
            { url: source.url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: reddit comments fetch failed',
         );
         return { content: '', title: '', success: false };
      }
   }

   // ── Content fetching: external recovery ─────────────────────────────────

   /**
    * Attempt to recover content from Wayback Machine or Google Cache.
    * Returns the first successful result.
    */
   private async fetchRecoveredContent(url: string): Promise<FetchContentResult> {
      try {
         const result = await attemptExternalRecovery(url);
         if (result.content !== null && result.source !== null) {
            const markdown = parseHtmlToMarkdown(result.content, url);
            if (markdown) {
               logger.info(
                  { url, source: result.source },
                  'llm-extractor: recovered from external source',
               );
               return { content: markdown, title: '', success: true, recoverySource: result.source };
            }
         }
         return { content: '', title: '', success: false };
      } catch (err) {
         logger.warn(
            { url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: external recovery failed',
         );
         return { content: '', title: '', success: false };
      }
   }

   // ── Content fetching: semantic crawl ────────────────────────────────────

   /**
    * Fetch content via semantic_crawl. Uses the query text to rank chunks
    * from the source URL by semantic relevance. Returns concatenated
    * top chunks as markdown for extraction.
    */
   private async fetchFromSemanticCrawl(url: string, query: string): Promise<FetchContentResult> {
      try {
         const config = loadConfig();
         if (!config.crawl4ai.baseUrl || !config.embeddingSidecar.baseUrl) {
            logger.debug(
               { url },
               'llm-extractor: semantic_crawl skipped — crawl4ai or embedding not configured',
            );
            return { content: '', title: '', success: false };
         }

         const result = await semanticCrawl(
            {
               source: { type: 'url', url },
               query,
               topK: 20,
               strategy: 'bfs',
               maxDepth: 0,
               maxPages: 1,
               includeExternalLinks: false,
               maxBytes: 5_000_000,
            },
            config.crawl4ai,
            config.embeddingSidecar.baseUrl,
            config.embeddingSidecar.apiToken ?? '',
            config.embeddingSidecar.dimensions,
            config.raga,
         );

         if (result.chunks.length > 0) {
            const markdown = result.chunks
               .slice(0, 10)
               .map((chunk) => chunk.text)
               .join('\n\n');

            if (markdown.length > 100) {
               logger.info(
                  { url, chunks: result.chunks.length, markdownLen: markdown.length },
                  'llm-extractor: semantic_crawl succeeded',
               );
               return {
                  content: markdown,
                  title: result.seedUrl,
                  success: true,
               };
            }
         }

         return { content: '', title: '', success: false };
      } catch (err) {
         logger.warn(
            { url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: semantic_crawl failed',
         );
         return { content: '', title: '', success: false };
      }
   }

   // ── Extraction from a content candidate ──────────────────────────────────

   /**
    * Run the full extraction pipeline on a single content candidate:
    *   1. Content quality check — skip LLM on obviously bad content
    *   2. LLM extraction with worker model
    *   3. If LLM returns nothing, regex fallback
    *
    * Returns finding IDs and metadata about what happened.
    */
   private async tryExtractFromContent(
      source: SourceEntry,
      attempt: ContentAttempt,
      relevantSubQuestionTexts: string[],
   ): Promise<ExtractionAttemptResult> {
      const content = attempt.fetchedContent ?? '';

      // ── Quality gate ────────────────────────────────────────────────────
      const methodForSummary = attempt.recoverySource ?? attempt.method;

      if (isContentLowQuality(content, source.url, attempt.fetchedTitle ?? source.title)) {
         logger.debug(
            { sourceId: source.id, method: attempt.method, contentLength: content.length },
            'llm-extractor: content low quality, skipping LLM extraction',
         );
         return {
            findingIds: [],
            method: attempt.method,
            usedRegex: false,
            contentQualitySkipped: true,
         };
      }

      const truncatedContent = content.slice(0, this.config.maxContentChars);

      // ── Try LLM extraction ─────────────────────────────────────────────
      const llmFindings = await this.callWorkerExtraction(
         source,
         truncatedContent,
         relevantSubQuestionTexts,
         methodForSummary,
      );

      if (llmFindings.length > 0) {
         const findingIds = this.registerFindings(llmFindings);
         return { findingIds, method: attempt.method, usedRegex: false, contentQualitySkipped: false };
      }

      // ── Regex fallback ─────────────────────────────────────────────────
      const fallbackFindings = this.extractFallback(
         source,
         truncatedContent,
         source.relevantSubQuestions,
         methodForSummary,
      );

      if (fallbackFindings.length > 0) {
         const findingIds = this.registerFindings(fallbackFindings);
         return { findingIds, method: attempt.method, usedRegex: true, contentQualitySkipped: false };
      }

      return {
         findingIds: [],
         method: attempt.method,
         usedRegex: false,
         contentQualitySkipped: false,
      };
   }

   /**
    * Register extracted findings on the state engine and return their IDs.
    */
   private registerFindings(findings: Omit<Finding, 'id' | 'createdAt'>[]): string[] {
      const ids: string[] = [];
      for (const finding of findings) {
         const id = this.state.addFinding(finding);
         ids.push(id);
      }
      return ids;
   }

   // ── LLM extraction call ───────────────────────────────────────────────────

   /**
    * Call the worker LLM to extract findings from source content.
    * Builds messages with the WORKER_EXTRACT prompt, source content,
    * and relevant sub-questions. Returns parsed findings on success,
    * or an empty array on failure.
    *
    * @param contentMethod - How the content was acquired (for evidence provenance).
    */
   private async callWorkerExtraction(
      source: SourceEntry,
      content: string,
      subQuestionTexts: string[],
      contentMethod = 'webRead',
   ): Promise<Omit<Finding, 'id' | 'createdAt'>[]> {
      const userContent = [
         `Source title: ${source.title}`,
         `Source URL: ${source.url}`,
         `Source type: ${source.sourceType}`,
         '',
         '--- CONTENT START ---',
         content,
         '--- CONTENT END ---',
         '',
         subQuestionTexts.length > 0
            ? `Research sub-questions:\n${subQuestionTexts.map((sq, i) => `${String(i + 1)}. ${sq}`).join('\n')}`
            : 'No specific sub-questions — extract all substantive claims.',
      ].join('\n');

      const messages = [
         { role: 'system' as const, content: WORKER_EXTRACT },
         { role: 'user' as const, content: userContent },
      ];

      const startTime = Date.now();

      const result = await this.llm.callJSON<LlmExtractResponse>({
         messages,
         model: 'worker',
         temperature: 0.3,
         timeoutMs: 180_000, // 3 min — extraction processes up to 8K chars of content
      });

      const durationMs = Date.now() - startTime;

      if (!result.success) {
         logger.warn(
            {
               sourceId: source.id,
               durationMs,
               error: result.response.error,
            },
            'llm-extractor: LLM call failed',
         );
         return [];
      }

      if (result.data.findings.length === 0) {
         logger.warn(
            { sourceId: source.id, durationMs },
            'llm-extractor: LLM returned empty findings',
         );
         return [];
      }

      // Compute extraction quality once per source for blending with per-claim confidence
      const extractionQuality = computeExtractionConfidence({
         method: 'llm',
         sourceContentLength: content.length,
      }).score;

      // Map LLM response to Finding objects
      const findings: Omit<Finding, 'id' | 'createdAt'>[] = [];

      // Record token usage against budget
      this.budget?.recordTokens(result.response.tokensUsed);

      for (const llmFinding of result.data.findings) {
         if (!llmFinding.claim || llmFinding.claim.trim().length === 0) continue;

         const claim = llmFinding.claim.trim();
         const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();
         const lastUpdated = new Date().toISOString();

         // Use per-claim confidence from LLM as primary, blended with extraction quality
         const llmConfidence =
            typeof llmFinding.confidence === 'number' && isFinite(llmFinding.confidence)
               ? Math.max(0, Math.min(1, llmFinding.confidence))
               : 0.5;
         const confidence = llmConfidence * 0.8 + extractionQuality * 0.2;

         const excerpt = llmFinding.evidenceExcerpt.trim();
         const evidenceExcerptSpread = excerpt ? { evidenceExcerpt: excerpt } : {};
         const finding: Omit<Finding, 'id' | 'createdAt'> = {
            claim,
            normalizedClaim,
            subQuestionIds: [...source.relevantSubQuestions],
            sourceIds: [source.id],
            evidenceSummary: `Extracted via LLM (${contentMethod}) from: ${source.title}`,
            ...evidenceExcerptSpread,
            evidenceDirectness: llmFinding.evidenceDirectness,
            confidence,
            // Initial label reflects single-source extraction; post-processing
            // (updateConfidenceFromEvidence) will reassess with cross-source evidence
            confidenceLabel: confidenceToLabel(confidence, /* sourceCount */ 1),
            corroboratingSourceIds: [],
            contradictingSourceIds: [],
            freshnessSensitive: false,
            lastUpdated,
            claimType: llmFinding.claimType,
         };

         findings.push(finding);
      }

      return findings;
   }

   // ── Regex fallback extraction ─────────────────────────────────────────────

   /**
    * Fallback regex-based extraction when LLM extraction fails.
    * Applies the same pattern set from extraction.ts on the source content.
    */
   private extractFallback(
      source: SourceEntry,
      content: string,
      subQuestionIds: string[],
      contentMethod = 'webRead',
   ): Omit<Finding, 'id' | 'createdAt'>[] {
      const seen = new Set<string>();
      const results: Omit<Finding, 'id' | 'createdAt'>[] = [];

      if (content.length < 40) return [];

      const extractionConfidence = computeExtractionConfidence({
         method: 'regex',
         sourceContentLength: content.length,
      });
      const confidence = extractionConfidence.score;

      for (const pattern of FALLBACK_PATTERNS) {
         for (const re of pattern.patterns) {
            const match = re.exec(content);
            if (!match) continue;

            // Extract the sentence containing the match
            const sentence = extractSentence(content, match.index);
            if (!sentence) continue;

            const claim = sentence.length > 300 ? sentence.slice(0, 300) + '…' : sentence;
            const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();

            // Dedup by normalized claim
            const dedupKey = normalizedClaim.slice(0, 120);
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const lastUpdated = new Date().toISOString();

            const finding: Omit<Finding, 'id' | 'createdAt'> = {
               claim,
               normalizedClaim,
               subQuestionIds,
               sourceIds: [source.id],
               evidenceSummary: `Extracted via regex (${contentMethod}) from: ${source.title}`,
               evidenceExcerpt: claim.length <= 200 ? claim : claim.slice(0, 200) + '…',
               evidenceDirectness: pattern.evidenceDirectness,
               confidence,
               confidenceLabel: confidenceToLabel(confidence),
               corroboratingSourceIds: [],
               contradictingSourceIds: [],
               freshnessSensitive: false,
               lastUpdated,
               claimType: pattern.claimType,
            };

            results.push(finding);

            // Only take the first match per pattern to avoid redundancy
            break;
         }
      }

      return results;
   }
}
