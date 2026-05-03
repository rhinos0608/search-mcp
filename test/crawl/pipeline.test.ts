import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkPipeline, runPipeline } from '../../src/crawl/pipeline.js';
import { DropChunk } from '../../src/crawl/types.js';
import { resetStats, getStatsSnapshot } from '../../src/crawl/stats.js';
import type { CorpusChunk } from '../../src/types.js';
import type { CrawlPageResult } from '../../src/types.js';
import type { ChunkStage, ChunkStageResult, PipelineContext } from '../../src/crawl/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makePage(overrides: Partial<CrawlPageResult> = {}): CrawlPageResult {
  return {
    url: 'https://example.com/page',
    success: true,
    markdown: '# Hello\n\nThis is content.\n\nMore content here.',
    title: 'Test Page',
    description: 'A test page',
    links: [],
    statusCode: 200,
    errorMessage: null,
    ...overrides,
  };
}

// ── Test stages ────────────────────────────────────────────────────────────

class PassThroughStage implements ChunkStage {
  readonly name: string;
  constructor(name = 'passthrough') {
    this.name = name;
  }
  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    return { chunks };
  }
}

class DropAllStage implements ChunkStage {
  readonly name = 'drop-all';
  async process(_chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    throw new DropChunk('drop-all-test');
  }
}

class SplitStage implements ChunkStage {
  readonly name = 'splitter';
  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    const result: CorpusChunk[] = [];
    for (const chunk of chunks) {
      result.push(chunk);
      result.push({ ...chunk, text: chunk.text + ' (dup)', chunkIndex: chunk.chunkIndex });
    }
    return { chunks: result };
  }
}

class WarningStage implements ChunkStage {
  readonly name = 'warnings';
  async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
    return { chunks, warnings: ['test warning'] };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('ChunkPipeline: empty pipeline passes pages through', async () => {
  const pipeline = new ChunkPipeline();
  const pages = [makePage()];
  const result = await pipeline.execute(pages);
  assert.equal(result.chunks.length, 1);
  const first = result.chunks[0];
  const firstPage = pages[0];
  if (first === undefined || firstPage === undefined) throw new Error('expected data');
  assert.equal(first.text, firstPage.markdown);
});

test('ChunkPipeline: single stage transforms chunks', async () => {
  const pipeline = new ChunkPipeline([new PassThroughStage()]);
  const result = await pipeline.execute([makePage()]);
  assert.equal(result.chunks.length, 1);
});

test('ChunkPipeline: multiple stages run in order', async () => {
  const order: string[] = [];
  class OrderStage implements ChunkStage {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async process(chunks: CorpusChunk[], _ctx: PipelineContext): Promise<ChunkStageResult> {
      order.push(this.name);
      return { chunks };
    }
  }

  const pipeline = new ChunkPipeline([
    new OrderStage('first'),
    new OrderStage('second'),
    new OrderStage('third'),
  ]);
  await pipeline.execute([makePage()]);

  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('ChunkPipeline: DropChunk skips entire page when thrown from single placeholder', async () => {
  const pipeline = new ChunkPipeline([new DropAllStage()]);
  const result = await pipeline.execute([makePage()]);
  assert.equal(result.chunks.length, 0);
});

test('ChunkPipeline: DropChunk records drop reason', async () => {
  const pipeline = new ChunkPipeline([new DropAllStage()]);
  const result = await pipeline.execute([makePage()]);
  assert.equal(result.droppedReasons.get('drop-all-test'), 1);
});

test('ChunkPipeline: successful pages without content produce zero chunks', async () => {
  const pipeline = new ChunkPipeline([new PassThroughStage()]);
  const pages = [makePage({ success: true, markdown: '' })];
  const result = await pipeline.execute(pages);
  assert.equal(result.chunks.length, 0);
});

test('ChunkPipeline: unsuccessful pages are skipped', async () => {
  const pipeline = new ChunkPipeline([new PassThroughStage()]);
  const pages = [makePage({ success: false })];
  const result = await pipeline.execute(pages);
  assert.equal(result.chunks.length, 0);
});

test('ChunkPipeline: warnings propagate from stages', async () => {
  const pipeline = new ChunkPipeline([new WarningStage()]);
  const result = await pipeline.execute([makePage()]);
  assert.ok(result.warnings.length > 0);
  // Stage warnings are stored in droppedReasons with a key of format `${name}:warnings`
  assert.ok(result.droppedReasons.get('warnings:warnings') !== undefined);
});

test('ChunkPipeline: stage splitting produces more chunks', async () => {
  const pipeline = new ChunkPipeline([new SplitStage()]);
  const result = await pipeline.execute([makePage()]);
  assert.equal(result.chunks.length, 2);
});

test('ChunkPipeline: add stage dynamically', () => {
  const pipeline = new ChunkPipeline();
  assert.equal(pipeline.names.length, 0);
  pipeline.add(new PassThroughStage('added'));
  assert.equal(pipeline.names.length, 1);
  assert.equal(pipeline.names[0], 'added');
});

test('ChunkPipeline: get stage by name', () => {
  const stage = new PassThroughStage('find-me');
  const pipeline = new ChunkPipeline([stage]);
  assert.ok(pipeline.get('find-me') !== undefined);
  assert.equal(pipeline.get('not-here'), undefined);
});

test('ChunkPipeline: preserves page metadata in context', async () => {
  const captured: PipelineContext[] = [];
  class CaptureContextStage implements ChunkStage {
    readonly name = 'capture-ctx';
    async process(chunks: CorpusChunk[], ctx: PipelineContext): Promise<ChunkStageResult> {
      captured.push(ctx);
      return { chunks };
    }
  }

  const pipeline = new ChunkPipeline([new CaptureContextStage()]);
  await pipeline.execute([makePage({ url: 'https://a.com', title: 'Page A', statusCode: 200 })]);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.pageUrl, 'https://a.com');
  assert.equal(captured[0]?.pageTitle, 'Page A');
  assert.equal(captured[0]?.pageStatusCode, 200);
});

test('runPipeline: returns pipeline result with logging', async () => {
  resetStats();
  const pipeline = new ChunkPipeline([new PassThroughStage()]);
  const result = await runPipeline(pipeline, [makePage()]);

  assert.equal(result.chunks.length, 1);

  const snap = getStatsSnapshot();
  assert.equal(snap.counters['pipeline.chunks.total'], 1);
  assert.equal(snap.counters['pipeline.pages.processed'], 1);
});
