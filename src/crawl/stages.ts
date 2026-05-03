/**
 * Built-in chunk pipeline stages for the ChunkPipeline.
 *
 * Each stage is a self-contained processing step that maps to existing
 * inline behaviors in pagesToCorpus() from semanticCrawl.ts.
 *
 * Stages can filter (drop chunks/pages), transform (modify content),
 * or split (one page → many chunks) corpus data.
 *
 * Inspired by Scrapy's ItemPipeline pattern.
 */

import { logger } from '../logger.js';
import { isCookieBannerPage } from '../utils/cookieBanner.js';
import { scrubContent } from '../utils/contentScrubber.js';
import { chunkMarkdown } from '../chunking.js';
import { createHash } from 'node:crypto';
import type { CorpusChunk } from '../types.js';
import type { ChunkStage, ChunkStageResult, PipelineContext } from './types.js';
import { DropChunk } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const CONSENT_WALL_DOMAINS = [
  'consent.google.com',
  'consent.youtube.com',
  'consent.google.co.uk',
  'consent.google.de',
  'consent.google.fr',
  'consent.google.ca',
  'consent.google.com.au',
  'privacy.google.com',
  'policies.google.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'www.facebook.com',
];

// ── 1. ConsentWallFilterStage ──────────────────────────────────────────────

/**
 * Detects pages that redirected to a consent/cookie wall.
 * These produce boilerplate chunks that lexically match many queries.
 */
export class ConsentWallFilterStage implements ChunkStage {
  readonly name = 'consent-wall-filter';

  async process(chunks: CorpusChunk[], ctx: PipelineContext): Promise<ChunkStageResult> {
    // Check the URL
    if (isConsentDomain(chunks, ctx)) {
      throw new DropChunk('consent-wall-redirect');
    }

    // Check the content for consent-wall page titles
    for (const chunk of chunks) {
      if (hasConsentWallTitle(chunk.text)) {
        throw new DropChunk('consent-wall-title');
      }
    }

    return { chunks };
  }
}

function isConsentDomain(_chunks: CorpusChunk[], ctx: PipelineContext): boolean {
  try {
    const hostname = new URL(ctx.pageUrl).hostname.toLowerCase();
    return CONSENT_WALL_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function hasConsentWallTitle(markdown: string): boolean {
  const titleMatch = /^#\s+(.+)$/m.exec(markdown);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].toLowerCase();
    return (
      /before you continue/i.test(title) ||
      /cookie.*choice/i.test(title) ||
      /privacy.*check/i.test(title) ||
      /your.*privacy/i.test(title) ||
      /verify.*human/i.test(title)
    );
  }
  return false;
}

// ── 2. HttpErrorFilterStage ────────────────────────────────────────────────

/**
 * Drops pages with 4xx status codes (error pages, not content).
 * The crawler follows redirects, so a 404 that redirects to a consent wall
 * will have the consent wall's content but still report the 4xx status.
 */
export class HttpErrorFilterStage implements ChunkStage {
  readonly name = 'http-error-filter';

  async process(chunks: CorpusChunk[], ctx: PipelineContext): Promise<ChunkStageResult> {
    if (ctx.pageStatusCode !== null && ctx.pageStatusCode >= 400 && ctx.pageStatusCode < 500) {
      throw new DropChunk(`http-${String(ctx.pageStatusCode)}`);
    }
    return { chunks };
  }
}

// ── 3. CookieBannerFilterStage ─────────────────────────────────────────────

/**
 * Drops pages that look like cookie consent banners.
 * Uses the existing isCookieBannerPage() utility.
 */
export class CookieBannerFilterStage implements ChunkStage {
  readonly name = 'cookie-banner-filter';

  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    for (const chunk of chunks) {
      if (isCookieBannerPage(chunk.text)) {
        throw new DropChunk('cookie-banner');
      }
    }
    return { chunks };
  }
}

// ── 4. ContentScrubStage ───────────────────────────────────────────────────

/**
 * Optionally scrubs content for prompt injection, data exfiltration,
 * impersonation, and XSS patterns. Configurable via scrubEnabled in PipelineContext.
 */
export class ContentScrubStage implements ChunkStage {
  readonly name = 'content-scrub';

  async process(chunks: CorpusChunk[], ctx: PipelineContext): Promise<ChunkStageResult> {
    if (!ctx.scrubEnabled) return { chunks };

    const processed: CorpusChunk[] = [];
    let scrubbedCount = 0;
    let threatDetections = 0;

    for (const chunk of chunks) {
      const result = scrubContent(chunk.text);
      if (!result.clean) {
        scrubbedCount++;
        threatDetections += result.threats.length;
      }
      processed.push({ ...chunk, text: result.content });
    }

    if (scrubbedCount > 0) {
      logger.warn(
        { scrubbedCount, threatDetections },
        'Content scrubbing redacted threats in chunks',
      );
    }

    return { chunks: processed };
  }
}

// ── 5. ChunkStage (Markdown splitter) ──────────────────────────────────────

/**
 * Splits full-page markdown into semantic chunks using chunkMarkdown().
 * This stage transforms each single placeholder chunk into multiple chunks.
 */
export class MarkdownChunkStage implements ChunkStage {
  readonly name = 'markdown-chunker';

  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    const result: CorpusChunk[] = [];

    for (const chunk of chunks) {
      const mdChunks = chunkMarkdown(chunk.text, chunk.url);
      for (const c of mdChunks) {
        result.push({
          text: c.content,
          url: c.url,
          section: c.section,
          charOffset: c.charOffset,
          chunkIndex: c.chunkIndex,
          totalChunks: c.totalChunks,
        });
      }
    }

    return { chunks: result };
  }
}

// ── 6. DedupStage ──────────────────────────────────────────────────────────

/**
 * Deduplicates chunks by SHA-256 content hash.
 * Preserves the first occurrence of each unique chunk text.
 */
export class DedupStage implements ChunkStage {
  readonly name = 'dedup';

  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    if (chunks.length === 0) return { chunks: [] };

    const seen = new Set<string>();
    const deduped: CorpusChunk[] = [];
    let dropped = 0;

    for (const chunk of chunks) {
      const normalized = chunk.text.trim().toLowerCase().replace(/\s+/g, ' ');
      const hash = createHash('sha256').update(normalized).digest('hex');
      if (seen.has(hash)) {
        dropped++;
        continue;
      }
      seen.add(hash);
      deduped.push(chunk);
    }

    if (dropped > 0) {
      logger.debug({ dropped, total: chunks.length }, 'Dedup stage removed duplicate chunks');
    }

    return { chunks: deduped };
  }
}

// ── Stage Collection Builder ───────────────────────────────────────────────

export interface DefaultStageOptions {
  scrubEnabled?: boolean;
}

/**
 * Build the default set of pipeline stages used by semantic_crawl.
 * Order matters: filters run first, then chunking, then dedup.
 */
export function buildDefaultStages(opts?: DefaultStageOptions): ChunkStage[] {
  return [
    new ConsentWallFilterStage(),
    new HttpErrorFilterStage(),
    new CookieBannerFilterStage(),
    ...(opts?.scrubEnabled ? [new ContentScrubStage()] : []),
    new MarkdownChunkStage(),
    new DedupStage(),
  ];
}
