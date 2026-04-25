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

const MAX_TRANSCRIPT_CHUNK_CHARS = 1_200;
const MAX_TRANSCRIPT_CHUNK_DURATION = 60;
const MAX_TRANSCRIPT_CHUNK_SEGMENTS = 12;

function buildTranscriptChunk(
  input: TranscriptInput,
  url: string,
  segments: TranscriptSegmentInput[],
): RagChunk {
  const first = segments[0];
  const last = segments.at(-1);
  const text = segments.map((segment) => segment.text).join(' ');
  const duration = segments.reduce((sum, segment) => sum + Math.max(segment.duration, 0), 0);

  return {
    text,
    url,
    section: input.title ?? input.videoId,
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 0,
    metadata: {
      ...input.metadata,
      adapter: 'transcript',
      videoId: input.videoId,
      offset: first?.offset ?? 0,
      duration,
      segmentCount: segments.length,
      endOffset: last ? last.offset + last.duration : (first?.offset ?? 0),
    },
  };
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
  const filtered = input.segments
    .map((segment) => ({
      ...segment,
      text: segment.text.trim().replace(/\s+/g, ' '),
    }))
    .filter((segment) => segment.text.length > 0);

  if (filtered.length === 0) return [];

  const groups: TranscriptSegmentInput[][] = [];
  let current: TranscriptSegmentInput[] = [];
  let currentChars = 0;
  let currentDuration = 0;

  for (const segment of filtered) {
    const segmentChars = segment.text.length;
    const segmentDuration = Math.max(segment.duration, 0);
    const separatorChars = current.length > 0 ? 1 : 0;
    const nextChars = currentChars + separatorChars + segmentChars;
    const nextDuration = currentDuration + segmentDuration;

    const shouldFlush =
      current.length > 0 &&
      (current.length >= MAX_TRANSCRIPT_CHUNK_SEGMENTS ||
        nextChars > MAX_TRANSCRIPT_CHUNK_CHARS ||
        nextDuration > MAX_TRANSCRIPT_CHUNK_DURATION);

    if (shouldFlush) {
      groups.push(current);
      current = [];
      currentChars = 0;
      currentDuration = 0;
    }

    current.push(segment);
    currentChars += (current.length > 1 ? 1 : 0) + segmentChars;
    currentDuration += segmentDuration;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups.map((segments, index, allSegments) => ({
    ...buildTranscriptChunk(input, url, segments),
    chunkIndex: index,
    totalChunks: allSegments.length,
  }));
}
