import { logger } from '../logger.js';
import { youtubeSearch } from './youtubeSearch.js';
import { getYouTubeTranscript } from './youtubeTranscript.js';
import { chunksFromTranscript } from '../rag/adapters/transcript.js';
import { embedTexts, embedTextsBatched } from '../rag/embedding.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import type { RagChunk, RetrievalProfileName, RetrievalResponse } from '../rag/types.js';
import { DEFAULT_SEMANTIC_MAX_BYTES, applySemanticByteBudget, formatSemanticBytes } from '../semanticLimits.js';

const TRANSCRIPT_CONCURRENCY = 3;

export interface SemanticYoutubeOptions {
  query: string;
  apiKey: string;
  embeddingBaseUrl: string;
  embeddingApiToken?: string | undefined;
  embeddingDimensions: number;
  maxVideos?: number | undefined;
  channel?: string | undefined;
  sort?: 'relevance' | 'date' | 'viewCount' | undefined;
  transcriptLanguage?: string | undefined;
  profile?: RetrievalProfileName | undefined;
  topK?: number | undefined;
  maxBytes?: number | undefined;
}

export interface SemanticYoutubeResult extends RetrievalResponse {
  videoCount: number;
  failedTranscripts: number;
}

export async function semanticYoutube(
  opts: SemanticYoutubeOptions,
): Promise<SemanticYoutubeResult> {
  const maxVideos = Math.min(opts.maxVideos ?? 20, 50);
  const maxBytes = opts.maxBytes ?? DEFAULT_SEMANTIC_MAX_BYTES;
  const language = opts.transcriptLanguage ?? 'en';
  const sort = opts.sort ?? 'relevance';

  const videos = await youtubeSearch(opts.query, opts.apiKey, sort, maxVideos);

  const channelLower = opts.channel?.toLowerCase();
  const filtered = channelLower
    ? videos.filter((v) => v.channelTitle.toLowerCase().includes(channelLower))
    : videos;

  logger.info(
    { tool: 'semantic_youtube', query: opts.query, videoCount: filtered.length },
    'Fetching transcripts',
  );

  const warnings: string[] = [];
  let failedTranscripts = 0;
  const allChunks: RagChunk[] = [];

  for (let i = 0; i < filtered.length; i += TRANSCRIPT_CONCURRENCY) {
    const batch = filtered.slice(i, i + TRANSCRIPT_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (video) => {
        const result = await getYouTubeTranscript(video.videoId, language);
        return chunksFromTranscript({
          videoId: video.videoId,
          segments: result.transcript,
          title: video.title,
          metadata: {
            channelTitle: video.channelTitle,
            publishedAt: video.publishedAt,
          },
        });
      }),
    );

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      const video = batch[j];
      if (outcome === undefined || video === undefined) continue;
      if (outcome.status === 'rejected') {
        failedTranscripts++;
        const msg =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        warnings.push(`Transcript fetch failed for "${video.videoId}": ${msg}`);
        logger.warn({ videoId: video.videoId, err: outcome.reason }, 'Transcript fetch failed');
      } else {
        allChunks.push(...outcome.value);
      }
    }
  }

  const budgeted = applySemanticByteBudget(allChunks, maxBytes);
  if (budgeted.truncated) {
    warnings.push(
      `Transcript corpus budget capped at ${formatSemanticBytes(maxBytes)}; ${String(budgeted.droppedCount)} chunks omitted`,
    );
  }

  const chunks = budgeted.items;

  if (chunks.length === 0) {
    const corpus = prepareCorpus({ adapter: 'transcript', chunks: [] });
    const response = retrieveCorpus(corpus, {
      query: opts.query,
      topK: opts.topK,
      profile: opts.profile,
    });
    return {
      ...response,
      warnings: [...(response.warnings ?? []), ...warnings],
      videoCount: filtered.length,
      failedTranscripts,
    };
  }

  const chunkTexts = chunks.map((c) => c.text);
  const chunkTitles = chunks.map((c) => c.section);

  const [docEmbed, queryEmbed] = await Promise.all([
    embedTextsBatched({
      baseUrl: opts.embeddingBaseUrl,
      apiToken: opts.embeddingApiToken,
      texts: chunkTexts,
      mode: 'document',
      dimensions: opts.embeddingDimensions,
      titles: chunkTitles,
    }),
    embedTexts({
      baseUrl: opts.embeddingBaseUrl,
      apiToken: opts.embeddingApiToken,
      texts: [opts.query],
      mode: 'query',
      dimensions: opts.embeddingDimensions,
    }),
  ]);

  const queryEmbedding = queryEmbed.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  const corpus = prepareCorpus({
    adapter: 'transcript',
    chunks,
    embeddings: docEmbed.embeddings,
    model: docEmbed.model,
    dimensions: docEmbed.dimensions,
  });

  const response = retrieveCorpus(corpus, {
    query: opts.query,
    queryEmbedding,
    topK: opts.topK,
    profile: opts.profile,
  });

  return {
    ...response,
    warnings: [...(response.warnings ?? []), ...warnings],
    videoCount: filtered.length,
    failedTranscripts,
  };
}
