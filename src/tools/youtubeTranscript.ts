import { YoutubeTranscript } from 'youtube-transcript';
import { logger } from '../logger.js';
import { TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import type { YouTubeResult, TranscriptSegment } from '../types.js';
import { finalizeStructuredContent, wrapTextInElement } from '../utils/elementHelpers.js';

const cache = new ToolCache<YouTubeResult>({ maxSize: 50, ttlMs: 7 * 24 * 60 * 60 * 1000 });

export function transcriptSegmentsToStructuredContent(transcript: TranscriptSegment[]) {
  return finalizeStructuredContent(transcript.flatMap((seg) => wrapTextInElement(seg.text)));
}

function extractVideoId(videoIdOrUrl: string): string {
  let id: string | null = null;

  if (videoIdOrUrl.includes('youtube.com')) {
    try {
      const url = new URL(videoIdOrUrl);
      id = url.searchParams.get('v');
    } catch {
      // fall through to bare-ID check
    }
  } else if (videoIdOrUrl.includes('youtu.be')) {
    try {
      const url = new URL(videoIdOrUrl);
      id = url.pathname.replace(/^\//, '').split('/')[0] ?? null;
    } catch {
      // fall through to bare-ID check
    }
  } else {
    id = videoIdOrUrl.trim();
  }

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new Error(`Could not extract a valid YouTube video ID from: "${videoIdOrUrl}"`);
  }

  return id;
}

export async function getYouTubeTranscript(
  videoIdOrUrl: string,
  language = 'en',
): Promise<YouTubeResult> {
  const videoId = extractVideoId(videoIdOrUrl);

  const key = cacheKey('youtube', videoId, language);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true, videoId }, 'YouTube transcript cache hit');
    return cached;
  }

  logger.info({ videoId, language }, 'Fetching YouTube transcript');

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let raw: Awaited<ReturnType<typeof YoutubeTranscript.fetchTranscript>>;
  try {
    raw = await Promise.race([
      YoutubeTranscript.fetchTranscript(videoId, { lang: language }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(`YouTube transcript fetch timed out after 30 seconds for video "${videoId}"`),
          );
        }, 30_000);
      }),
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/disabled|no transcript/i.test(message)) {
      throw new Error(
        `No transcript available for video "${videoId}". The video may have transcripts disabled or the language "${language}" is not available.`,
      );
    }
    throw new Error(`Failed to fetch transcript for "${videoId}": ${message}`, { cause: err });
  } finally {
    clearTimeout(timeoutId);
  }

  const MAX_SEGMENTS = 1500;
  const allSegments: TranscriptSegment[] = raw.map((item) => ({
    text: typeof item.text === 'string' ? item.text : '',
    duration: typeof item.duration === 'number' ? item.duration : 0,
    offset: typeof item.offset === 'number' ? item.offset : 0,
  }));
  const transcript = allSegments.slice(0, MAX_SEGMENTS);

  const MAX_TEXT_LENGTH = 50_000;
  // Build fullText from capped transcript so we never join unbounded segments.
  // Pattern matches bounded-parser caps in sibling code:
  // - src/tools/githubRepoFile.ts: MAX_FILE_LENGTH=50_000 with slice+TRUNCATED_MARKER (line 343, 619-621)
  // - src/utils/htmlElements.ts: early-break at MAX_RAW_ELEMENTS=1000 (line 115)
  // - src/utils/elementTruncation.ts: MAX_ELEMENTS=50 + MAX_TEXT_LENGTH=10000
  let fullText = transcript.map((seg) => seg.text.replace(/\n/g, ' ')).join(' ');

  if (fullText.length > MAX_TEXT_LENGTH) {
    fullText = fullText.slice(0, MAX_TEXT_LENGTH) + TRUNCATED_MARKER;
  }

  logger.debug({
    videoId,
    totalSegments: allSegments.length,
    returnedSegments: transcript.length,
    fullTextLength: fullText.length,
  });

  // Bounded: structured output from capped transcript, not uncapped allSegments.
  const structured = transcriptSegmentsToStructuredContent(transcript);

  const result: YouTubeResult = {
    videoId,
    title: null,
    transcript,
    fullText,
    ...structured,
  };
  cache.set(key, result);
  return result;
}
