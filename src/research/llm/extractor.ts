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
import { loadConfig } from '../../config.js';
import { extractWithRAGA } from '../../utils/ragAnythingClient.js';
import { isDocumentUrl } from '../../utils/documentUtils.js';

import type { SourceEntry, EvidenceDirectness, ClaimType, SubQuestion, Finding } from '../types.js';


// ── Config ─────────────────────────────────────────────────────────────────

export interface LlmExtractorConfig {
   /** Max concurrent LLM calls. */
   concurrency: number;
   /** Max tokens per extraction call (source content truncation). */
   maxTokensPerSource: number;
}

const DEFAULT_CONFIG: LlmExtractorConfig = {
   concurrency: 3,
   maxTokensPerSource: 8000,
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
      patterns: [/\bcompared?\s+to\b/i, /\b(versus|vs\.?)\b/i],
      claimType: 'primary' as const,
      evidenceDirectness: 'near-direct' as const,
   },
   {
      name: 'recommendation',
      patterns: [/\brecommend(s|ed|ation)?\b/i, /\bshould\s+(use|consider|adopt|avoid)\b/i],
      claimType: 'secondary' as const,
      evidenceDirectness: 'secondary' as const,
   },
];

// ── Sentence extraction helper (reused from extraction.ts) ────────────────

/**
 * Extract the sentence containing a character offset.
 * Walks backward to find the sentence start and forward to find the end.
 */
function extractSentence(text: string, offset: number): string | null {
   if (offset < 0 || offset >= text.length) return null;

   // Find sentence start: walk backward to previous period/newline or start
   let start = offset;
   while (start > 0) {
      const ch = text[start - 1];
      if (ch === '.' || ch === '!' || ch === '?') {
         // Check for abbreviation (e.g., "Dr.", "etc.") — skip single-word periods
         const wordStart = start - 1;
         let wordStartScan = wordStart - 1;
         while (wordStartScan >= 0 && /\w/.test(text[wordStartScan] ?? '')) {
            wordStartScan--;
         }
         const word = text.slice(wordStartScan + 1, wordStart).toLowerCase();
         const abbreviations = new Set([
            'dr',
            'mr',
            'ms',
            'mrs',
            'vs',
            'etc',
            'inc',
            'ltd',
            'co',
            'dept',
            'est',
            'approx',
            'fig',
            'al',
            'e.g',
            'i.e',
         ]);
         if (abbreviations.has(word)) {
            start = wordStartScan + 1;
            continue;
         }
         break;
      }
      if (ch === '\n' && text[start] !== '\n') break; // single newline mid-sentence
      if (ch === '\n' && start + 1 < text.length && text[start] === '\n') break; // blank line
      start--;
   }

   // Find sentence end: walk forward to period/newline or end
   let end = offset;
   while (end < text.length) {
      const ch = text[end];
      if (ch === '.' || ch === '!' || ch === '?') {
         end++; // include punctuation
         // Skip closing quote, paren, bracket
         if (end < text.length && /[)'"}\]»]/.test(text[end] ?? '')) end++;
         break;
      }
      if (ch === '\n' && end + 1 < text.length && text[end + 1] === '\n') break; // blank line
      end++;
   }

   const sentence = text.slice(Math.max(0, start), Math.min(text.length, end)).trim();
   if (sentence.length < 10) return null;

   return sentence;
}

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

   // ── Single source extraction ─────────────────────────────────────────────

   /**
    * Extract findings from a single source.
    * Fetches content, tries LLM extraction, falls back to regex on failure.
    */
   private async extractSingleSource(
      source: SourceEntry,
      subQuestionMap: Map<string, SubQuestion>,
   ): Promise<string[]> {
      // 1. Fetch source content via webRead
      const { content, fetchSuccess } = await this.fetchSourceContent(source.url);

      if (!fetchSuccess || !content) {
         logger.warn(
            { sourceId: source.id, url: source.url },
            'llm-extractor: failed to fetch content',
         );
         this.state.markSourceFailed(source.id);
         return [];
      }

      // Truncate to configured maximum
      const truncatedContent = content.slice(0, this.config.maxTokensPerSource);

      // Get relevant sub-question texts for the LLM prompt
      const relevantSubQuestionTexts = source.relevantSubQuestions
         .map((sqId) => subQuestionMap.get(sqId)?.text)
         .filter((t): t is string => !!t);

      // 2. Try LLM extraction
      const llmFindings = await this.callWorkerExtraction(
         source,
         truncatedContent,
         relevantSubQuestionTexts,
      );

      if (llmFindings.length > 0) {
         // Register LLM-extracted findings
         const findingIds: string[] = [];
         for (const finding of llmFindings) {
            const id = this.state.addFinding(finding);
            findingIds.push(id);
         }
         this.state.markSourceExtracted(source.id);

         logger.info(
            { sourceId: source.id, url: source.url, findings: findingIds.length },
            'llm-extractor: LLM extraction complete',
         );

         return findingIds;
      }

      // 3. Fallback: regex-based extraction on same content
      logger.warn(
         { sourceId: source.id, url: source.url },
         'llm-extractor: LLM returned no findings, trying regex fallback',
      );

      const fallbackFindings = this.extractFallback(
         source,
         truncatedContent,
         source.relevantSubQuestions,
      );

      if (fallbackFindings.length > 0) {
         const findingIds: string[] = [];
         for (const finding of fallbackFindings) {
            const id = this.state.addFinding(finding);
            findingIds.push(id);
         }
         this.state.markSourceExtracted(source.id);

         logger.info(
            { sourceId: source.id, url: source.url, findings: findingIds.length },
            'llm-extractor: regex fallback complete',
         );

         return findingIds;
      }

      // 4. Both methods produced nothing
      logger.warn(
         { sourceId: source.id, url: source.url },
         'llm-extractor: no findings from LLM or regex fallback',
      );
      this.state.markSourceFailed(source.id);
      return [];
   }

   // ── Content fetching ──────────────────────────────────────────────────────

   /**
    * Fetch source content using webRead.
    * Returns the markdown/plain text content for extraction.
    */
   private async fetchSourceContent(
      url: string,
   ): Promise<{ content: string; title: string; fetchSuccess: boolean }> {
      // ── RAG-Anything for document URLs ────────────────────────────────────
      if (isDocumentUrl(url)) {
         const config = loadConfig();
         if (config.raga.enabled && config.raga.baseUrl) {
            try {
               const result = await extractWithRAGA(url);
               if (result.markdown && result.markdown.trim().length > 0) {
                  logger.info({ url, parser: result.parserUsed }, 'llm-extractor: RAGA succeeded');
                  return { content: result.markdown, title: result.title ?? '', fetchSuccess: true };
               }
               logger.warn({ url }, 'llm-extractor: RAGA returned empty content, falling back');
            } catch (ragaErr) {
               logger.warn(
                  { url, err: ragaErr instanceof Error ? ragaErr.message : String(ragaErr) },
                  'llm-extractor: RAGA failed, falling back to webRead',
               );
            }
         }
      }

      // ── webRead fallback ──────────────────────────────────────────────────
      try {
         const article = await webRead(url);
         const content = article.textContent || article.content || '';

         if (!content || content.trim().length === 0) {
            return { content: '', title: article.title ?? '', fetchSuccess: false };
         }

         return { content, title: article.title ?? '', fetchSuccess: true };
      } catch (err) {
         logger.warn(
            { url, err: err instanceof Error ? err.message : String(err) },
            'llm-extractor: webRead failed for source',
         );
         return { content: '', title: '', fetchSuccess: false };
      }
   }

   // ── LLM extraction call ───────────────────────────────────────────────────

   /**
    * Call the worker LLM to extract findings from source content.
    * Builds messages with the WORKER_EXTRACT prompt, source content,
    * and relevant sub-questions. Returns parsed findings on success,
    * or an empty array on failure.
    */
   private async callWorkerExtraction(
      source: SourceEntry,
      content: string,
      subQuestionTexts: string[],
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
            evidenceSummary: `Extracted via LLM from: ${source.title}`,
            ...evidenceExcerptSpread,
            evidenceDirectness: llmFinding.evidenceDirectness,
            confidence,
            confidenceLabel: confidenceToLabel(confidence),
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
               evidenceSummary: `Extracted via regex from: ${source.title}`,
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
