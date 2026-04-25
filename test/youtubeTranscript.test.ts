import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — no types for direct dist path; mirrors the production import workaround.
import * as ytModule from 'youtube-transcript/dist/youtube-transcript.esm.js';
import {
  getYouTubeTranscript,
  transcriptSegmentsToStructuredContent,
} from '../src/tools/youtubeTranscript.js';
import { MAX_ELEMENTS, MAX_TEXT_LENGTH, TRUNCATED_MARKER } from '../src/utils/htmlElements.js';
import type { TranscriptSegment } from '../src/types.js';

const YoutubeTranscript = (
  ytModule as {
    YoutubeTranscript: {
      fetchTranscript: (videoId: string, options: { lang: string }) => Promise<TranscriptSegment[]>;
    };
  }
).YoutubeTranscript;

test('transcriptSegmentsToStructuredContent preserves segment elements through finalization', () => {
  const transcript: TranscriptSegment[] = Array.from({ length: MAX_ELEMENTS + 5 }, (_, idx) => ({
    text: `Segment ${idx}`,
    duration: 1,
    offset: idx,
  }));

  const structured = transcriptSegmentsToStructuredContent(transcript);

  assert.equal(structured.elements?.length, MAX_ELEMENTS);
  assert.equal(structured.truncatedElements, true);
  assert.equal(structured.originalElementCount, MAX_ELEMENTS + 5);
  assert.equal(structured.omittedElementCount, 5);
  assert.deepEqual(structured.elements?.[0], { type: 'text', text: 'Segment 0' });
});

test('transcriptSegmentsToStructuredContent adds metadata to long segment text', () => {
  const longText = 'a'.repeat(MAX_TEXT_LENGTH + 100);
  const structured = transcriptSegmentsToStructuredContent([
    { text: longText, duration: 1, offset: 0 },
  ]);
  const element = structured.elements?.[0];

  assert.equal(element?.type, 'text');
  if (element?.type === 'text') {
    assert.equal(element.truncated, true);
    assert.equal(element.originalLength, longText.length);
    assert.ok(element.text.endsWith(TRUNCATED_MARKER));
  }
});

test('getYouTubeTranscript computes structured truncation metadata from all fetched segments', async (t) => {
  const raw = Array.from({ length: 1505 }, (_, idx) => ({
    text: `Segment ${idx}`,
    duration: 1,
    offset: idx,
  }));
  t.mock.method(YoutubeTranscript, 'fetchTranscript', async () => raw);

  const result = await getYouTubeTranscript('abc123def45', 'metadata-test');

  assert.equal(result.transcript.length, 1500);
  assert.equal(result.elements?.length, MAX_ELEMENTS);
  assert.equal(result.truncatedElements, true);
  assert.equal(result.originalElementCount, raw.length);
  assert.equal(result.omittedElementCount, raw.length - MAX_ELEMENTS);
});
