import type { RagChunk, RawDocument } from '../types.js';

export interface TranscriptSegmentInput {
  text: string;
  offset: number;
  duration: number;
}

export interface TranscriptInput {
  videoId: string;
  segments: TranscriptSegmentInput[];
  title?: string | null | undefined;
  url?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function transcriptUrl(input: TranscriptInput): string {
  return input.url ?? `https://www.youtube.com/watch?v=${input.videoId}`;
}

export function documentsFromTranscript(input: TranscriptInput): RawDocument[] {
  return [
    {
      id: input.videoId,
      adapter: 'transcript',
      text: input.segments.map((segment) => segment.text).join(' '),
      url: transcriptUrl(input),
      title: input.title,
      metadata: input.metadata,
    },
  ];
}

export function chunksFromTranscript(input: TranscriptInput): RagChunk[] {
  const url = transcriptUrl(input);
  return input.segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment, index, segments) => ({
      text: segment.text,
      url,
      section: input.title ?? input.videoId,
      charOffset: 0,
      chunkIndex: index,
      totalChunks: segments.length,
      metadata: {
        ...input.metadata,
        adapter: 'transcript',
        videoId: input.videoId,
        offset: segment.offset,
        duration: segment.duration,
      },
    }));
}
