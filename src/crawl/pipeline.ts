/**
 * ChunkPipeline — Scrapy-inspired pipeline for corpus chunk processing.
 *
 * Manages an ordered sequence of stages that process corpus chunks.
 * Each stage can filter, transform, or enrich chunks. Stages that want
 * to discard a chunk throw DropChunk.
 *
 * Inspired by Scrapy's ItemPipelineManager pattern.
 */

import { logger } from '../logger.js';
import { statsCollector } from './stats.js';
import type { CorpusChunk } from '../types.js';
import { DropChunk, type ChunkStage, type PipelineContext } from './types.js';

export interface PipelineOptions {
  /** Enable content scrubbing. */
  scrubEnabled?: boolean;
  /** Default page metadata when not provided per-chunk. */
  defaultUrl?: string;
  defaultTitle?: string | null;
  defaultStatusCode?: number | null;
}

export class ChunkPipeline {
  private readonly stages: ChunkStage[];

  constructor(stages: ChunkStage[] = []) {
    this.stages = [...stages];
  }

  /** Add a stage to the end of the pipeline. */
  add(stage: ChunkStage): void {
    this.stages.push(stage);
  }

  /** Get stage by name (for inspection/testing). */
  get(name: string): ChunkStage | undefined {
    return this.stages.find((s) => s.name === name);
  }

  /** Get all registered stage names in order. */
  get names(): string[] {
    return this.stages.map((s) => s.name);
  }

  /**
   * Execute the full pipeline on a batch of pages.
   * Each page's markdown is chunked, then each chunk passes through all stages.
   *
   * @param pages - Raw crawl pages to process
   * @param opts - Pipeline options
   * @returns Processed corpus chunks with accumulated stats
   */
  async execute(
    pages: import('../types.js').CrawlPageResult[],
    opts?: PipelineOptions,
  ): Promise<PipelineBatchResult> {
    const allChunks: CorpusChunk[] = [];
    const droppedReasons = new Map<string, number>();
    let totalPagesWithContent = 0;

    for (const page of pages) {
      if (!page.success || !page.markdown) continue;

      const ctx: PipelineContext = {
        pageUrl: page.url,
        pageTitle: page.title,
        pageStatusCode: page.statusCode,
        scrubEnabled: opts?.scrubEnabled ?? false,
        droppedReasons,
      };

      // Start with a placeholder — the chunking stage will split this into
      // proper chunks. Stages before chunking operate on the full-page markdown.
      let workingChunks: CorpusChunk[] = [
        {
          text: page.markdown,
          url: page.url,
          section: '',
          charOffset: 0,
          chunkIndex: 0,
          totalChunks: 1,
        },
      ];

      for (const stage of this.stages) {
        try {
          const result = await stage.process(workingChunks, ctx);
          workingChunks = result.chunks;
          if (result.warnings && result.warnings.length > 0) {
            ctx.droppedReasons.set(
              `${stage.name}:warnings`,
              (ctx.droppedReasons.get(`${stage.name}:warnings`) ?? 0) + result.warnings.length,
            );
          }
        } catch (err) {
          if (err instanceof DropChunk) {
            const count = droppedReasons.get(err.reason) ?? 0;
            droppedReasons.set(err.reason, count + 1);
            // Re-throw DropChunk at page level if no chunks remain
            if (workingChunks.length === 1) {
              // The whole page was dropped
              workingChunks = [];
              break;
            }
            // Otherwise, just skip the current placeholder — shouldn't happen
            // since DropChunk is meant for individual chunks post-chunking
            workingChunks = [];
            break;
          }
          throw err;
        }
      }

      if (workingChunks.length > 0) {
        totalPagesWithContent++;
        allChunks.push(...workingChunks);
      }
    }

    return {
      chunks: allChunks,
      totalPagesWithContent,
      droppedReasons,
      warnings: this.collectWarnings(droppedReasons),
    };
  }

  private collectWarnings(droppedReasons: Map<string, number>): string[] {
    const warnings: string[] = [];
    for (const [reason, count] of droppedReasons) {
      if (count > 0) {
        warnings.push(`Pipeline dropped ${String(count)} chunk(s): ${reason}`);
      }
    }
    return warnings;
  }
}

export interface PipelineBatchResult {
  chunks: CorpusChunk[];
  totalPagesWithContent: number;
  droppedReasons: Map<string, number>;
  warnings: string[];
}

/**
 * Run the pipeline with event logging.
 * Wraps ChunkPipeline.execute with structured logging.
 */
export async function runPipeline(
  pipeline: ChunkPipeline,
  pages: import('../types.js').CrawlPageResult[],
  opts?: PipelineOptions,
): Promise<PipelineBatchResult> {
  const start = Date.now();
  const result = await pipeline.execute(pages, opts);
  const duration = Date.now() - start;

  logger.info(
    {
      chunks: result.chunks.length,
      pages: pages.filter((p) => p.success && p.markdown).length,
      dropped: result.droppedReasons.size,
      warnings: result.warnings.length,
      durationMs: duration,
    },
    'Chunk pipeline completed',
  );

  // Record stats
  statsCollector.incCounter('pipeline.chunks.total', result.chunks.length);
  statsCollector.incCounter('pipeline.pages.processed', result.totalPagesWithContent);
  statsCollector.recordHistogram('pipeline.duration_ms', duration);
  for (const [reason, count] of result.droppedReasons) {
    // Sanitize reason to ensure stable, valid metric names
    const safeReason =
      reason
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 64) || 'other';
    statsCollector.incCounter(`pipeline.dropped.${safeReason}`, count);
  }

  return result;
}
