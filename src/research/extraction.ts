/**
 * ExtractionEngine — deep sequential extraction for the research orchestrator.
 *
 * Phase 3: Selects top-N sources, fetches content (Crawl4AI → webRead →
 * Wayback/Google Cache → semantic_crawl), chunks them, applies rule-based claim
 * extraction, and distills into structured
 * Finding objects on the state engine.
 *
 * Raw crawl/read output is discarded — only structured findings persist.
 */
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { isDocumentUrl } from '../utils/documentUtils.js';
import { attemptExternalRecovery } from '../utils/externalRecovery.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { semanticCrawl } from '../tools/semanticCrawl.js';

import { chunkMarkdown } from '../chunking.js';
import { webCrawl } from '../tools/webCrawl.js';
import { webRead } from '../tools/webRead.js';
import { extractWithRAGA } from '../utils/ragAnythingClient.js';
import { getYouTubeTranscript } from '../tools/youtubeTranscript.js';
import { chunksFromTranscript } from '../rag/adapters/transcript.js';
import { redditComments } from '../tools/redditComments.js';
import { chunksFromConversation } from '../rag/adapters/conversation.js';
import type { ConversationCommentInput } from '../rag/adapters/conversation.js';
import { ResearchStateEngine, BudgetTracker } from './state.js';
import { isBotChallenge } from './contentQuality.js';
import type {
  Finding,
  SourceEntry,
  ClaimType,
  EvidenceDirectness,
  InteractiveExtractionPlan,
} from './types.js';
import { extractSentence } from './extractSentence.js';

// ── Extraction configuration ────────────────────────────────────────────────

interface ExtractionConfig {
  /** Whether to attempt Crawl4AI first. */
  useCrawl4ai: boolean;
  /** Whether to attempt semantic_crawl as a fallback when other methods fail. */
  useSemanticCrawl: boolean;
  /** Hard ceiling on extractions per source. */
  maxChunkSize: number;
}

const DEFAULT_CONFIG: ExtractionConfig = {
  useCrawl4ai: true,
  useSemanticCrawl: true,
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

/**
 * Parse HTML through JSDOM + Readability to extract clean text content.
 * Used by external recovery fallback to convert cached HTML to markdown.
 * Returns null if Readability cannot parse the content.
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
      // Fallback: strip tags from body
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

// ── ExtractionEngine ─────────────────────────────────────────────────────────

export class ExtractionEngine {
  constructor(
    private readonly state: ResearchStateEngine,
    private readonly budget: BudgetTracker,
    private readonly config: ExtractionConfig = DEFAULT_CONFIG,
  ) {}

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
          const transcriptIds = await this.extractYoutubeTranscript(source);
          if (transcriptIds) allFindingIds.push(...transcriptIds);
          continue; // skip the normal fetchAndExtract path
        }

        // Reddit extraction path — uses comment API instead of web crawl
        if (source.sourceType === 'reddit') {
          const commentIds = await this.extractRedditComments(source);
          if (commentIds) allFindingIds.push(...commentIds);
          continue; // skip the normal fetchAndExtract path
        }
        // Look up sub-question text for semantic_crawl fallback
        const subQuestionText = this.getSubQuestionText(source.relevantSubQuestions);
        const fetchResult = await this.fetchAndExtract(source.url, subQuestionText);

        if (!fetchResult.success) {
          logger.warn({ url: source.url, sourceId: source.id }, 'extraction: fetch failed');
          this.state.markSourceFailed(source.id);
          continue;
        }

        // 1.5 Interactive fallback for bot challenges
        if (fetchResult.markdown && isBotChallenge(fetchResult.markdown)) {
          const plan = this.getSubQuestionExtractionPlan(source.relevantSubQuestions);
          if (plan) {
            let fallbackSucceeded = false;
            try {
              const { InteractiveBrowserAgent } = await import('./interactiveAgent.js');
              const browserCfg = loadConfig().browser;
              const agent = new InteractiveBrowserAgent({
                browser: {
                  headless: browserCfg.headless,
                  viewport: browserCfg.viewport,
                  userAgent: browserCfg.userAgent,
                  proxyServer: browserCfg.proxyServer,
                  executablePath: browserCfg.executablePath,
                  profile: browserCfg.profileDir || null,
                  stealthEnabled: browserCfg.stealthEnabled,
                  rebrowser: browserCfg.rebrowser,
                  maxSessionTimeMs: browserCfg.maxSessionTimeMs,
                  bypassCSP: browserCfg.bypassCSP,
                  credentials: browserCfg.credentials,
                  browserEngine: browserCfg.browserEngine,
                  cloakHumanize: browserCfg.cloakHumanize,
                  cloakHumanPreset: browserCfg.cloakHumanPreset,
                  cloakLocale: browserCfg.cloakLocale,
                  cloakTimezone: browserCfg.cloakTimezone,
                  cloakGeoip: browserCfg.cloakGeoip,
                  cloakStealthArgs: browserCfg.cloakStealthArgs,
                },
              });
              const result = await agent.executePlan(source.url, plan);
              if (result.content && !isBotChallenge(result.content)) {
                fetchResult.markdown = result.content;
                fetchResult.title = result.title || fetchResult.title;
                fallbackSucceeded = true;
                logger.info(
                  { url: source.url, sourceId: source.id },
                  'extraction: interactive fallback succeeded',
                );
              }
              await agent.close();
            } catch (err) {
              logger.warn(
                {
                  url: source.url,
                  sourceId: source.id,
                  err: err instanceof Error ? err.message : String(err),
                },
                'extraction: interactive fallback failed',
              );
            }
            // If fallback did not produce clean content, skip this source entirely
            if (!fallbackSucceeded) {
              logger.warn(
                { url: source.url, sourceId: source.id },
                'extraction: skipping source — bot challenge could not be bypassed',
              );
              this.state.markSourceFailed(source.id);
              continue;
            }
          } else {
            // No extraction plan available — cannot bypass bot challenge, skip source
            logger.warn(
              { url: source.url, sourceId: source.id },
              'extraction: skipping source — bot challenge detected and no extraction plan available',
            );
            this.state.markSourceFailed(source.id);
            continue;
          }
        }

        // 2. Chunk content
        const chunks = this.chunkContent(fetchResult.markdown);

        // 3. Extract claims from chunks
        const subQuestionIds = source.relevantSubQuestions;
        const findings = this.extractClaims(chunks, source.id, subQuestionIds);

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
   * Select top-N pending sources for extraction.
   */
  private selectTopSources(sources: SourceEntry[], maxExtractions: number): SourceEntry[] {
    const available = sources.filter((s) => s.extractionStatus === 'pending');
    const sorted = [...available];
    return sorted.slice(0, maxExtractions);
  }

  /**
   * Extract findings from a YouTube video via its transcript.
   * Uses getYouTubeTranscript + chunksFromTranscript + existing claim patterns.
   */
  private async extractYoutubeTranscript(source: SourceEntry): Promise<string[] | null> {
    try {
      // 1. Fetch transcript
      const result = await getYouTubeTranscript(source.url);
      if (!result.fullText || result.fullText.length < 20) {
        logger.warn(
          { url: source.url, sourceId: source.id },
          'extraction: youtube transcript too short',
        );
        this.state.markSourceFailed(source.id);
        return null;
      }

      // 2. Build transcript input for chunking with robust videoId extraction
      let videoId: string | null = null;
      try {
        const parsedUrl = new URL(source.url);
        if (parsedUrl.hostname === 'youtu.be') {
          videoId = parsedUrl.pathname.slice(1);
        } else {
          videoId = parsedUrl.searchParams.get('v');
        }
      } catch {
        // ignore URL parse errors, fallback to regex
      }

      if (!videoId) {
        const regex =
          /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;
        const match = regex.exec(source.url);
        videoId = match?.[1] ?? null;
      }

      const transcriptInput = {
        videoId: videoId ?? source.url,
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
        logger.warn(
          { url: source.url, sourceId: source.id },
          'extraction: youtube transcript chunking produced no chunks',
        );
        this.state.markSourceFailed(source.id);
        return null;
      }

      // 4. Extract claims from chunks using existing claim patterns
      const chunkTexts = chunks.map((c) => ({ text: c.text, heading: c.section }));
      const subQuestionIds = source.relevantSubQuestions;
      const findings = this.extractClaims(chunkTexts, source.id, subQuestionIds);

      // 5. Register findings
      const findingIds: string[] = [];
      for (const finding of findings) {
        const id = this.state.addFinding(finding);
        findingIds.push(id);
      }

      this.state.markSourceExtracted(source.id);

      logger.info(
        { sourceId: source.id, url: source.url, chunks: chunks.length, findings: findings.length },
        'extraction: youtube source complete',
      );

      return findingIds.length > 0 ? findingIds : null;
    } catch (err) {
      logger.error(
        { err, sourceId: source.id, url: source.url },
        'extraction: youtube transcript extraction failed',
      );
      this.state.markSourceFailed(source.id);
      return null;
    }
  }

  /**
   * Extract findings from a Reddit post via its comment thread.
   * Uses redditComments + chunksFromConversation + existing claim patterns.
   */
  private async extractRedditComments(source: SourceEntry): Promise<string[] | null> {
    try {
      // 1. Fetch comments from Reddit
      const REDDIT_BASE_URL = 'https://www.reddit.com';
      // Normalize URL: if it's a permalink path, prepend reddit.com
      const postUrl = source.url.startsWith('/r/') ? `${REDDIT_BASE_URL}${source.url}` : source.url;

      const result = await redditComments({ url: postUrl }, {});

      // 2. Flatten and convert comments to conversation input
      function flattenComments(items: unknown[]): {
        body: string;
        id: string;
        author: string;
        permalink: string;
        parentId: string;
        score: number;
        createdUtc: number;
        depth: number;
        stickied: boolean;
      }[] {
        const flat: {
          body: string;
          id: string;
          author: string;
          permalink: string;
          parentId: string;
          score: number;
          createdUtc: number;
          depth: number;
          stickied: boolean;
        }[] = [];
        for (const item of items) {
          if (item && typeof item === 'object' && 'body' in item) {
            const c = item as {
              body: string;
              id: string;
              author: string;
              permalink: string;
              parentId: string;
              score: number;
              createdUtc: number;
              depth: number;
              stickied: boolean;
              replies: unknown[];
            };
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
        logger.warn(
          { url: source.url, sourceId: source.id },
          'extraction: reddit no comments found',
        );
        this.state.markSourceFailed(source.id);
        return null;
      }

      // Convert to conversation comment input
      const conversationInputs: ConversationCommentInput[] = flatComments.map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author,
        permalink: c.permalink,
        parentId: c.parentId,
        metadata: {
          score: c.score,
          createdUtc: c.createdUtc,
          depth: c.depth,
          stickied: c.stickied,
        },
      }));

      // 3. Chunk conversation
      const chunks = chunksFromConversation(conversationInputs, { baseUrl: REDDIT_BASE_URL });
      if (chunks.length === 0) {
        logger.warn(
          { url: source.url, sourceId: source.id },
          'extraction: reddit comment chunking produced no chunks',
        );
        this.state.markSourceFailed(source.id);
        return null;
      }

      // 4. Extract claims from chunks using existing claim patterns
      const chunkTexts = chunks.map((c) => ({ text: c.text, heading: c.section }));
      const subQuestionIds = source.relevantSubQuestions;
      const findings = this.extractClaims(chunkTexts, source.id, subQuestionIds);

      // 5. Register findings
      const findingIds: string[] = [];
      for (const finding of findings) {
        const id = this.state.addFinding(finding);
        findingIds.push(id);
      }

      this.state.markSourceExtracted(source.id);

      logger.info(
        {
          sourceId: source.id,
          url: source.url,
          comments: flatComments.length,
          chunks: chunks.length,
          findings: findings.length,
        },
        'extraction: reddit source complete',
      );

      return findingIds.length > 0 ? findingIds : null;
    } catch (err) {
      logger.error(
        { err, sourceId: source.id, url: source.url },
        'extraction: reddit comment extraction failed',
      );
      this.state.markSourceFailed(source.id);
      return null;
    }
  }

  // ── Sub-question text lookup ─────────────────────────────────────────────

  /**
   * Get the first sub-question text from a list of sub-question IDs.
   * Used to provide a query for semantic_crawl fallback.
   */
  private getSubQuestionText(subQuestionIds: string[]): string | undefined {
    if (subQuestionIds.length === 0) return undefined;
    const subQuestions = this.state.getSubQuestions();
    const sq = subQuestions.find((s) => subQuestionIds.includes(s.id));
    return sq?.text;
  }

  /**
   * Get the first matching sub-question's extraction plan for interactive browser fallback.
   */
  private getSubQuestionExtractionPlan(
    subQuestionIds: string[],
  ): InteractiveExtractionPlan | undefined {
    if (subQuestionIds.length === 0) return undefined;
    const subQuestions = this.state.getSubQuestions();
    const sq = subQuestions.find((s) => subQuestionIds.includes(s.id));
    return sq?.extractionPlan;
  }

  // ── Content fetching ─────────────────────────────────────────────────────

  /**
   * Fetch a page's content. Tries multiple strategies in order:
   * 1) RAG-Anything for document URLs when enabled
   * 2) Crawl4AI via webCrawl (has built-in ExternalRecoveryMiddleware)
   * 3) webRead (Readability-based)
   * 4) External recovery via Wayback Machine / Google Cache
   * 5) semantic_crawl as a last resort (when configured and subQuestionText is available)
   */
  private async fetchAndExtract(
    url: string,
    subQuestionText?: string,
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
    } catch (readErr) {
      logger.warn(
        { url, err: readErr instanceof Error ? readErr.message : String(readErr) },
        'extraction: webRead failed, trying external recovery',
      );
    }

    // ── External recovery (Wayback Machine / Google Cache) ───────────────
    const recoveryResult = await this.fetchFromExternalRecovery(url);
    if (recoveryResult.success) {
      return recoveryResult;
    }

    // ── Semantic crawl (last resort) ─────────────────────────────────────
    if (subQuestionText && this.config.useSemanticCrawl) {
      const semanticResult = await this.fetchFromSemanticCrawl(url, subQuestionText);
      if (semanticResult.success) {
        return semanticResult;
      }
    }

    // ── All strategies exhausted ─────────────────────────────────────────
    logger.error({ url }, 'extraction: all fetch strategies failed');
    return { markdown: '', title: '', success: false };
  }

  /**
   * Attempt to recover content from Wayback Machine or Google Cache.
   * Used as a fallback when direct fetching fails.
   */
  private async fetchFromExternalRecovery(
    url: string,
  ): Promise<{ markdown: string; title: string; success: boolean }> {
    try {
      const result = await attemptExternalRecovery(url);
      if (result.content !== null && result.source !== null) {
        const markdown = parseHtmlToMarkdown(result.content, url);
        if (markdown) {
          logger.info({ url, source: result.source }, 'extraction: recovered from external source');
          return { markdown, title: '', success: true };
        }
      }
      return { markdown: '', title: '', success: false };
    } catch (err) {
      logger.warn(
        { url, err: err instanceof Error ? err.message : String(err) },
        'extraction: external recovery failed',
      );
      return { markdown: '', title: '', success: false };
    }
  }

  /**
   * Attempt to retrieve content via semantic_crawl as a last resort.
   * Crawls the URL and returns ranked chunks relevant to the sub-question.
   * Requires Crawl4AI and embedding provider to be configured.
   */
  private async fetchFromSemanticCrawl(
    url: string,
    query: string,
  ): Promise<{ markdown: string; title: string; success: boolean }> {
    try {
      const config = loadConfig();
      if (!config.crawl4ai.baseUrl || !config.embeddingSidecar.baseUrl) {
        logger.debug(
          { url },
          'extraction: semantic_crawl skipped — crawl4ai or embedding not configured',
        );
        return { markdown: '', title: '', success: false };
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
        // Concatenate the most relevant chunks into markdown for claim extraction
        const markdown = result.chunks
          .slice(0, 10)
          .map((chunk) => chunk.text)
          .join('\n\n');

        if (markdown.length > 100) {
          logger.info(
            { url, chunks: result.chunks.length, markdownLen: markdown.length },
            'extraction: semantic_crawl succeeded',
          );
          return {
            markdown,
            title: result.seedUrl,
            success: true,
          };
        }
      }

      return { markdown: '', title: '', success: false };
    } catch (err) {
      logger.warn(
        { url, err: err instanceof Error ? err.message : String(err) },
        'extraction: semantic_crawl failed',
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
