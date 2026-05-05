/**
 * ExtractionEngine — deep sequential extraction for the research orchestrator.
 *
 * Phase 3: Selects top-N sources, fetches content (Crawl4AI → Readability fallback),
 * chunks them, applies rule-based claim extraction, and distills into structured
 * Finding objects on the state engine.
 *
 * Raw crawl/read output is discarded — only structured findings persist.
 */
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { isDocumentUrl } from '../utils/documentUtils.js';

import { chunkMarkdown } from '../chunking.js';
import { webCrawl } from '../tools/webCrawl.js';
import { webRead } from '../tools/webRead.js';
import { extractWithRAGA } from '../utils/ragAnythingClient.js';
import { getYouTubeTranscript } from '../tools/youtubeTranscript.js';
import { chunksFromTranscript } from '../rag/adapters/transcript.js';
import { ResearchStateEngine, BudgetTracker, confidenceToLabel } from './state.js';
import type { Finding, SourceEntry, ClaimType, EvidenceDirectness } from './types.js';


// ── Extraction configuration ────────────────────────────────────────────────

interface ExtractionConfig {
   /** Whether to attempt Crawl4AI first. */
   useCrawl4ai: boolean;
   /** Hard ceiling on extractions per source. */
   maxChunkSize: number;
}

const DEFAULT_CONFIG: ExtractionConfig = {
   useCrawl4ai: true,
   maxChunkSize: 10_000,
};

// ── Claim extraction patterns ───────────────────────────────────────────────

interface ClaimPattern {
   name: string;
   patterns: RegExp[];
   claimType: ClaimType;
   evidenceDirectness: EvidenceDirectness;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
   {
      name: 'mechanism',
      patterns: [
         /\b(uses?|utilizes?|employs?|leverages?|implements?)\s+\w+/i,
         /\barchitecture\s+consists?\s+of\b/i,
         /\bworks?\s+by\b/i,
         /\b(operates?|functions?|runs)\s+(by|through|via)\b/i,
         /\bis\s+(built|constructed|designed|architected)\s+(on|using|around|with)\b/i,
      ],
      claimType: 'primary',
      evidenceDirectness: 'direct',
   },
   {
      name: 'benchmark',
      patterns: [
         /\b(achieved?|reached?|attained?|scored?)\s+\d+%/i,
         /\b(outperforms?|surpasses?|beats?|exceeds?)\b/i,
         /\bstate\s*[-–]?\s*of\s*[-–]?\s*the\s*[-–]?\s*art\b/i,
         /\b(accuracy|precision|recall|f1|performance)\s+(of|:)\s*\d+/i,
         /\bleading[-–\s]?edge\b/i,
         /\bsota\b/i,
      ],
      claimType: 'primary',
      evidenceDirectness: 'direct',
   },
   {
      name: 'comparison',
      patterns: [
         /\bcompared?\s+to\b/i,
         /\b(versus|vs\.?)\b/i,
         /\btrade[-–\s]?off\s+(between|among)\b/i,
         /\bin\s+contrast\s+to\b/i,
         /\b(more|less)\s+\w+\s+than\b/i,
         /\bdifferen(ce|t)\s+(between|from)\b/i,
      ],
      claimType: 'primary',
      evidenceDirectness: 'near-direct',
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
      claimType: 'primary',
      evidenceDirectness: 'direct',
   },
   {
      name: 'recommendation',
      patterns: [
         /\brecommend(s|ed|ation)?\b/i,
         /\bbest\s+practice[s]?\b/i,
         /\bshould\s+(use|consider|adopt|avoid|prefer|implement)\b/i,
         /\b(ideal|optimal|preferred)\s+(for|when|approach|way|practice)\b/i,
         /\bit['']?s\s+(recommended|advisable|better)\s+to\b/i,
         /\bindustry\s+standard\b/i,
      ],
      claimType: 'secondary',
      evidenceDirectness: 'secondary',
   },
];

/** Supplemental patterns run on every chunk (lower priority). */
const SUPPLEMENTAL_PATTERNS: ClaimPattern[] = [
   {
      name: 'factual-statement',
      patterns: [
         /\bis\s+(a|an|the)\s+\w+(\s+\w+){0,5}\s+(that|which)\b/i,
         /\bconsists?\s+of\s+\w+/i,
         /\bdefined?\s+as\b/i,
         /\brefers?\s+to\b/i,
      ],
      claimType: 'secondary',
      evidenceDirectness: 'near-direct',
   },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string {
   return new Date().toISOString();
}

/** Heuristic: estimate how direct the evidence is based on chunk content length and extract pattern. */
function computeEvidenceDirectness(pattern: ClaimPattern, _chunkText: string): EvidenceDirectness {
   return pattern.evidenceDirectness;
}

/** Heuristic: base confidence from evidence directness. */
function directnessBaseConfidence(d: EvidenceDirectness): number {
   switch (d) {
      case 'direct':
         return 0.55;
      case 'near-direct':
         return 0.45;
      case 'secondary':
         return 0.35;
      case 'anecdotal':
         return 0.25;
      case 'speculative':
         return 0.15;
   }
}

// ── ExtractionEngine ─────────────────────────────────────────────────────────

export class ExtractionEngine {
   constructor(
      private readonly state: ResearchStateEngine,
      private readonly budget: BudgetTracker,
      private readonly config: ExtractionConfig = DEFAULT_CONFIG,
   ) { }

   /**
    * Run extraction for the given sources.
    * Returns the Finding IDs created.
    */
   async extract(sources: SourceEntry[]): Promise<string[]> {
      const allFindingIds: string[] = [];

      if (this.budget.isExhausted()) {
         logger.warn('extraction: budget exhausted before extraction started');
         return allFindingIds;
      }

      const profile = this.budget.profile;
      const topSources = this.selectTopSources(sources, profile.maxExtractions);

      if (topSources.length === 0) {
         logger.info('extraction: no sources to extract');
         return allFindingIds;
      }

      logger.info({ count: topSources.length }, 'extraction: starting sequential extraction');

      for (const source of topSources) {
         if (this.budget.isExhausted()) {
            logger.warn({ sourceId: source.id }, 'extraction: budget exhausted, stopping early');
            break;
         }

         // Reserve extraction slot
         if (!this.budget.recordExtraction()) {
            logger.warn({ sourceId: source.id }, 'extraction: extraction budget exceeded');
            break;
         }

         try {
            // 1. Fetch content
            // YouTube extraction path — uses transcript API instead of web crawl
            if (source.sourceType === 'youtube') {
               const transcriptId = await this.extractYoutubeTranscript(source);
               if (transcriptId) allFindingIds.push(transcriptId);
               continue; // skip the normal fetchAndExtract path
            }
            const fetchResult = await this.fetchAndExtract(source.url);

            if (!fetchResult.success) {
               logger.warn({ url: source.url, sourceId: source.id }, 'extraction: fetch failed');
               this.state.markSourceFailed(source.id);
               continue;
            }

            // 2. Chunk content
            const chunks = this.chunkContent(fetchResult.markdown);

            // 3. Extract claims from chunks
            const subQuestionIds = source.relevantSubQuestions;
            const findings = this.extractClaims(
               chunks,
               source.id,
               subQuestionIds,
               source.sourceConfidencePrior,
            );

            // 4. Register findings with state
            for (const finding of findings) {
               const id = this.state.addFinding(finding);
               allFindingIds.push(id);
            }

            this.state.markSourceExtracted(source.id);

            logger.info(
               {
                  sourceId: source.id,
                  url: source.url,
                  chunks: chunks.length,
                  findings: findings.length,
               },
               'extraction: source complete',
            );
         } catch (err) {
            logger.error(
               { err, sourceId: source.id, url: source.url },
               'extraction: unexpected error processing source',
            );
            this.state.markSourceFailed(source.id);
         }
      }

      logger.info({ totalFindings: allFindingIds.length }, 'extraction: complete');
      return allFindingIds;
   }

   // ── Source selection ─────────────────────────────────────────────────────

   /**
    * Select top-N sources sorted by confidence prior.
    */
   private selectTopSources(sources: SourceEntry[], maxExtractions: number): SourceEntry[] {
      const available = sources.filter((s) => s.extractionStatus === 'pending');
      const sorted = [...available].sort((a, b) => b.sourceConfidencePrior - a.sourceConfidencePrior);
      return sorted.slice(0, maxExtractions);
   }

   /**
    * Extract findings from a YouTube video via its transcript.
    * Uses getYouTubeTranscript + chunksFromTranscript + existing claim patterns.
    */
   private async extractYoutubeTranscript(source: SourceEntry): Promise<string | null> {
      try {
         // 1. Fetch transcript
         const result = await getYouTubeTranscript(source.url);
         if (!result.fullText || result.fullText.length < 20) {
            logger.warn({ url: source.url, sourceId: source.id }, 'extraction: youtube transcript too short');
            this.state.markSourceFailed(source.id);
            return null;
         }

         // 2. Build transcript input for chunking
         const transcriptInput = {
            videoId: source.url.split('?v=').pop() ?? source.url,
            segments: result.transcript.map((seg) => ({
               text: seg.text,
               offset: seg.offset,
               duration: seg.duration,
            })),
            title: source.title,
            url: source.url,
         };

         // 3. Chunk transcript
         const chunks = chunksFromTranscript(transcriptInput);
         if (chunks.length === 0) {
            logger.warn({ url: source.url, sourceId: source.id }, 'extraction: youtube transcript chunking produced no chunks');
            this.state.markSourceFailed(source.id);
            return null;
         }

         // 4. Extract claims from chunks using existing claim patterns
         const chunkTexts = chunks.map((c) => ({ text: c.text, heading: c.section }));
         const subQuestionIds = source.relevantSubQuestions;
         const findings = this.extractClaims(
            chunkTexts,
            source.id,
            subQuestionIds,
            source.sourceConfidencePrior,
         );

         // 5. Register findings
         let firstFindingId: string | null = null;
         for (const finding of findings) {
            const id = this.state.addFinding(finding);
            if (firstFindingId === null) firstFindingId = id;
         }

         this.state.markSourceExtracted(source.id);

         logger.info(
            { sourceId: source.id, url: source.url, chunks: chunks.length, findings: findings.length },
            'extraction: youtube source complete',
         );

         return firstFindingId;
      } catch (err) {
         logger.error(
            { err, sourceId: source.id, url: source.url },
            'extraction: youtube transcript extraction failed',
         );
         this.state.markSourceFailed(source.id);
         return null;
      }
   }

   // ── Content fetching ─────────────────────────────────────────────────────

   /**
    * Fetch a page's content. Tries RAG-Anything for document URLs when enabled,
    * then Crawl4AI via webCrawl, falling back to webRead on failure.
    */
   private async fetchAndExtract(
      url: string,
   ): Promise<{ markdown: string; title: string; success: boolean }> {
      // ── RAG-Anything for document URLs ────────────────────────────────────
      if (isDocumentUrl(url)) {
         const config = loadConfig();
         if (config.raga.enabled && config.raga.baseUrl) {
            try {
               const result = await extractWithRAGA(url);
               if (result.markdown && result.markdown.trim().length > 0) {
                  logger.info({ url, parser: result.parserUsed }, 'extraction: RAGA succeeded');
                  return {
                     markdown: result.markdown,
                     title: result.title ?? '',
                     success: true,
                  };
               }
               logger.warn({ url }, 'extraction: RAGA returned empty content, falling back');
            } catch (ragaErr) {
               logger.warn(
                  { url, err: ragaErr instanceof Error ? ragaErr.message : String(ragaErr) },
                  'extraction: RAGA failed, falling back',
               );
            }
         }
      }

      // ── Crawl4AI ──────────────────────────────────────────────────────────
      if (this.config.useCrawl4ai) {
         try {
            const config = loadConfig();
            const baseUrl = config.crawl4ai.baseUrl;
            const apiToken = config.crawl4ai.apiToken ?? '';

            if (baseUrl) {
               const result = await webCrawl(url, baseUrl, apiToken, {
                  strategy: 'bfs',
                  maxDepth: 1,
                  maxPages: 1,
                  includeExternalLinks: false,
               });

               if (result.successfulPages > 0 && result.pages.length > 0) {
                  const page = result.pages[0];
                  if (page?.markdown && page.markdown.length > 0) {
                     logger.debug({ url }, 'extraction: crawl4ai succeeded');
                     return {
                        markdown: page.markdown,
                        title: page.title ?? '',
                        success: true,
                     };
                  }
               }

               logger.warn(
                  { url, successfulPages: result.successfulPages },
                  'extraction: crawl4ai returned no content',
               );
            } else {
               logger.debug({ url }, 'extraction: crawl4ai not configured, skipping');
            }
         } catch (crawlErr) {
            logger.warn(
               { url, err: crawlErr instanceof Error ? crawlErr.message : String(crawlErr) },
               'extraction: crawl4ai failed, falling back to webRead',
            );
         }
      }

      // ── Fallback: webRead (Readability-based) ─────────────────────────────
      try {
         const article = await webRead(url);

         if (article.textContent) {
            const markdown = article.textContent || article.content || '';
            return {
               markdown,
               title: article.title ?? '',
               success: true,
            };
         }

         return { markdown: '', title: '', success: false };
      } catch (readErr) {
         logger.error(
            { url, err: readErr instanceof Error ? readErr.message : String(readErr) },
            'extraction: webRead also failed',
         );
         return { markdown: '', title: '', success: false };
      }
   }

   // ── Content chunking ────────────────────────────────────────────────────

   /**
    * Split markdown into semantically meaningful chunks using the shared
    * chunkMarkdown utility. Returns simplified items with text + optional heading.
    */
   private chunkContent(markdown: string): { text: string; heading?: string }[] {
      if (!markdown || markdown.length === 0) return [];

      try {
         const chunks = chunkMarkdown(markdown, '');
         return chunks
            .filter((c) => c.content.trim().length > 50)
            .map((c): { text: string; heading?: string } => {
               const item: { text: string; heading?: string } = { text: c.content };
               if (c.section && c.section.length > 0) {
                  item.heading = c.section;
               }
               return item;
            });
      } catch (err) {
         logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'extraction: chunking failed, using whole text as single chunk',
         );
         // Fallback: treat whole content as one chunk
         return [{ text: markdown.slice(0, this.config.maxChunkSize) }];
      }
   }

   // ── Claim extraction ────────────────────────────────────────────────────

   /**
    * Rule-based claim extraction from content chunks.
    *
    * For each chunk, applies configured claim patterns and supplemental patterns.
    * Deduplicates by normalized claim text.
    */
   private extractClaims(
      chunks: { text: string; heading?: string }[],
      sourceId: string,
      subQuestionIds: string[],
      sourceConfidencePrior: number,
   ): Omit<Finding, 'id' | 'createdAt'>[] {
      const seen = new Set<string>();
      const results: Omit<Finding, 'id' | 'createdAt'>[] = [];

      const allPatterns = [...CLAIM_PATTERNS, ...SUPPLEMENTAL_PATTERNS];

      for (const chunk of chunks) {
         const text = chunk.text;
         if (text.length < 40) continue; // skip trivial chunks

         for (const pattern of allPatterns) {
            for (const re of pattern.patterns) {
               const match = re.exec(text);
               if (!match) continue;

               // Extract the sentence containing the match
               const sentence = extractSentence(text, match.index);
               if (!sentence) continue;

               // Build a clean claim statement
               const claim = sentence.length > 300 ? sentence.slice(0, 300) + '…' : sentence;
               const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();

               // Dedup by normalized claim
               const dedupKey = normalizedClaim.slice(0, 120);
               if (seen.has(dedupKey)) continue;
               seen.add(dedupKey);

               const evidenceDirectness = computeEvidenceDirectness(pattern, text);
               const baseConfidence = Math.min(
                  1,
                  directnessBaseConfidence(evidenceDirectness) + sourceConfidencePrior * 0.2,
               );

               // Use type assertion for exactOptionalPropertyTypes compliance
               const finding = {
                  claim,
                  normalizedClaim,
                  subQuestionIds,
                  sourceIds: [sourceId],
                  evidenceSummary: chunk.heading
                     ? `From section "${chunk.heading}"`
                     : 'Extracted from page content',
                  evidenceExcerpt: claim.length <= 200 ? claim : claim.slice(0, 200) + '…',
                  evidenceDirectness,
                  confidence: baseConfidence,
                  confidenceLabel: confidenceToLabel(baseConfidence),
                  corroboratingSourceIds: [],
                  contradictingSourceIds: [],
                  scope: chunk.heading ?? undefined,
                  freshnessSensitive: false,
                  lastUpdated: nowISO(),
                  claimType: pattern.claimType,
               } as Omit<Finding, 'id' | 'createdAt'>;

               results.push(finding);

               // Only take the first match per pattern per chunk to avoid redundancy
               break;
            }
         }
      }

      return results;
   }
}

// ── Sentence extraction helper ──────────────────────────────────────────────

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
         const wordEnd = start;
         let wordStartScan = wordStart - 1;
         while (wordStartScan >= 0 && /\w/.test(text[wordStartScan] ?? '')) {
            wordStartScan--;
         }
         const word = text.slice(wordStartScan + 1, wordEnd).toLowerCase();
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
      if (ch === '\n' && text[start] !== '\n') {
         break; // single newline can be mid-sentence, but paragraph break ends it
      }
      if (ch === '\n' && start + 1 < text.length && text[start] === '\n') {
         break; // blank line boundary
      }
      start--;
   }

   // Find sentence end: walk forward to period/newline or end
   let end = offset;
   while (end < text.length) {
      const ch = text[end];
      if (ch === '.' || ch === '!' || ch === '?') {
         end++; // include the punctuation
         // Skip closing quote, paren, bracket
         if (end < text.length && /[)'"}\]»]/.test(text[end] ?? '')) end++;
         break;
      }
      if (ch === '\n' && end + 1 < text.length && text[end + 1] === '\n') {
         break; // blank line boundary
      }
      end++;
   }

   const sentence = text.slice(Math.max(0, start), Math.min(text.length, end)).trim();
   if (sentence.length < 10) return null;

   return sentence;
}
