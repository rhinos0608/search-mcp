import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { semanticYoutube } from '../src/tools/semanticYoutube.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeYouTubeSearchResponse(videos: { videoId: string; title: string; channel: string }[]) {
  return {
    items: videos.map((v) => ({
      id: { videoId: v.videoId },
      snippet: {
        title: v.title,
        description: '',
        channelTitle: v.channel,
        publishedAt: '2024-01-01T00:00:00Z',
        thumbnails: {},
      },
    })),
  };
}

function makeTranscriptXml(lines: string[]) {
  const entries = lines
    .map((text, i) => `<text start="${String(i)}" dur="1">${text}</text>`)
    .join('');
  return `<transcript>${entries}</transcript>`;
}

function makeEmbedResponse(texts: string[], dim: number) {
  const embeddings = texts.map((_, i) => Array.from({ length: dim }, (__, j) => (i + j) % 2 === 0 ? 1 : 0));
  return { embeddings, model: 'test', modelRevision: 'r1', dimensions: dim, mode: 'document', truncatedIndices: [] };
}

interface StubOptions {
  videos: { videoId: string; title: string; channel: string }[];
  transcriptFailIds?: string[];
  embedDim?: number;
}

function installStub(opts: StubOptions): () => void {
  const { videos, transcriptFailIds = [], embedDim = 4 } = opts;

  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);

    if (url.includes('googleapis.com/youtube/v3/search')) {
      return Response.json(makeYouTubeSearchResponse(videos));
    }

    if (url.includes('/youtubei/v1/player')) {
      // videoId is in the POST body as JSON: { ..., videoId: "..." }
      const rawBody =
        init?.body !== null && init?.body !== undefined ? String(init.body) : '';
      let videoId = '';
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        videoId = typeof parsed.videoId === 'string' ? parsed.videoId : '';
      } catch {
        // ignore parse errors
      }
      if (transcriptFailIds.includes(videoId)) {
        // Return empty captions — library will fall through to web-page path which returns 404
        return Response.json({ captions: {} });
      }
      return Response.json({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: 'en', baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}` },
            ],
          },
        },
      });
    }

    if (url.includes('timedtext')) {
      const videoId = new URL(url).searchParams.get('v') ?? '';
      return new Response(makeTranscriptXml([`word from ${videoId}`, 'more content here']), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      });
    }

    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      const texts = body.texts ?? [];
      return Response.json(makeEmbedResponse(texts, embedDim));
    }

    // Fallback — includes watch?v= web-page requests when InnerTube returns empty captions
    return new Response('no transcript data', { status: 404 });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('semanticYoutube returns ranked results for a happy-path query', async () => {
  const restore = installStub({
    videos: [
      { videoId: 'aaaaaaaaaaa', title: 'Alpha Video', channel: 'ChannelA' },
      { videoId: 'bbbbbbbbbbb', title: 'Beta Video', channel: 'ChannelB' },
    ],
  });

  try {
    const result = await semanticYoutube({
      query: 'happy path unique query q1',
      apiKey: 'fake-key',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
      topK: 3,
    });

    assert.ok(result.results.length > 0, 'Expected at least one result');
    assert.equal(result.failedTranscripts, 0);
    assert.equal(result.videoCount, 2);
    assert.ok(result.corpus.chunks.length > 0, 'Corpus should have chunks');
    for (const r of result.results) {
      assert.ok(typeof r.score.fused === 'number', 'Each result must have fused score');
    }
  } finally {
    restore();
  }
});

test('semanticYoutube records failed transcripts in failedTranscripts and warnings', async () => {
  const restore = installStub({
    videos: [
      { videoId: 'ccccccccccc', title: 'Fail Video', channel: 'ChannelC' },
      { videoId: 'ddddddddddd', title: 'Good Video', channel: 'ChannelD' },
    ],
    transcriptFailIds: ['ccccccccccc'],
  });

  try {
    const result = await semanticYoutube({
      query: 'failed transcript unique query q2',
      apiKey: 'fake-key',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
      topK: 5,
    });

    assert.equal(result.failedTranscripts, 1, 'One transcript should have failed');
    assert.ok(result.videoCount === 2);
    assert.ok(
      result.warnings?.some((w) => w.includes('ccccccccccc')),
      'Warning should mention the failed videoId',
    );
    assert.ok(result.corpus.chunks.length > 0, 'Good transcript should still produce chunks');
  } finally {
    restore();
  }
});

test('semanticYoutube returns empty results when all transcripts fail', async () => {
  const restore = installStub({
    videos: [{ videoId: 'eeeeeeeeeee', title: 'No Captions', channel: 'ChannelE' }],
    transcriptFailIds: ['eeeeeeeeeee'],
  });

  try {
    const result = await semanticYoutube({
      query: 'all fail unique query q3',
      apiKey: 'fake-key',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
    });

    assert.equal(result.results.length, 0);
    assert.equal(result.corpus.status, 'empty');
    assert.equal(result.failedTranscripts, 1);
  } finally {
    restore();
  }
});

test('semanticYoutube filters results by channel name (case-insensitive)', async () => {
  const restore = installStub({
    videos: [
      { videoId: 'fffffffffff', title: 'Video1', channel: 'TechTalks' },
      { videoId: 'ggggggggggg', title: 'Video2', channel: 'CookingChannel' },
    ],
  });

  try {
    const result = await semanticYoutube({
      query: 'channel filter unique query q4',
      apiKey: 'fake-key',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
      channel: 'techtalks',
    });

    assert.equal(result.videoCount, 1, 'Should filter to only TechTalks channel');
    assert.ok(
      result.corpus.chunks.every((c) =>
        (c.metadata?.['channelTitle'] as string | undefined)
          ?.toLowerCase()
          .includes('techtalks'),
      ),
      'All chunks should be from TechTalks',
    );
  } finally {
    restore();
  }
});

test('semanticYoutube does not write to stdout', async () => {
  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };

  const restore = installStub({
    videos: [{ videoId: 'hhhhhhhhhhh', title: 'StdoutTest', channel: 'Channel' }],
  });

  try {
    await semanticYoutube({
      query: 'stdout test unique query q5',
      apiKey: 'fake-key',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
    });
  } finally {
    restore();
    process.stdout.write = origWrite;
  }

  assert.equal(written.length, 0, `Unexpected stdout output: ${written.join('')}`);
});
