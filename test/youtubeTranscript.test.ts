import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getYouTubeTranscript } from '../src/tools/youtubeTranscript.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('getYouTubeTranscript emits one finalized text element for full transcript text', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/youtubei/v1/player')) {
      return new Response(
        JSON.stringify({
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  languageCode: 'en',
                  baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(
      '<transcript><text start="0" dur="1">Hello</text><text start="1" dur="1">world</text></transcript>',
      { status: 200, headers: { 'content-type': 'text/xml' } },
    );
  };

  const result = await getYouTubeTranscript('abcdefghijk', 'en');

  assert.equal(result.fullText, 'Hello world');
  assert.equal(result.transcript.length, 2);
  assert.equal(result.elements?.length, 1);
  assert.deepEqual(result.elements?.[0], { type: 'text', text: 'Hello world' });
});
