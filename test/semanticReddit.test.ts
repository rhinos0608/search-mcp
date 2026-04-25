import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { semanticReddit } from '../src/tools/semanticReddit.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeSearchListing(posts: { permalink: string; title: string }[]) {
  return {
    data: {
      children: posts.map((p) => ({
        kind: 't3',
        data: {
          title: p.title,
          url: `https://example.com${p.permalink}`,
          selftext: 'some post body',
          score: 10,
          num_comments: 5,
          subreddit: 'test',
          author: 'testuser',
          created_utc: 1_710_000_000,
          permalink: p.permalink,
          is_video: false,
        },
      })),
    },
  };
}

function makeCommentsListing(comments: { id: string; body: string; author: string }[]) {
  return [
    {
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'post1',
              name: 't3_post1',
              title: 'Test Post',
              selftext: '',
              author: 'op',
              subreddit: 'test',
              score: 10,
              num_comments: comments.length,
              created_utc: 1_710_000_000,
              permalink: '/r/test/comments/post1/test_post/',
              url: 'https://example.com/post1',
              is_video: false,
            },
          },
        ],
      },
    },
    {
      data: {
        children: comments.map((c) => ({
          kind: 't1',
          data: {
            id: c.id,
            name: `t1_${c.id}`,
            author: c.author,
            body: c.body,
            score: 5,
            created_utc: 1_710_000_100,
            permalink: `/r/test/comments/post1/test_post/${c.id}/`,
            parent_id: 't3_post1',
            depth: 0,
            distinguished: null,
            stickied: false,
            collapsed: false,
            replies: '',
          },
        })),
      },
    },
  ];
}

function makeEmbedResponse(texts: string[], dim: number) {
  const embeddings = texts.map((_, i) =>
    Array.from({ length: dim }, (__, j) => ((i + j) % 2 === 0 ? 1 : 0)),
  );
  return {
    embeddings,
    model: 'test',
    modelRevision: 'r1',
    dimensions: dim,
    mode: 'document',
    truncatedIndices: [],
  };
}

function makeRedditFetchImpl(options: {
  posts: { permalink: string; title: string }[];
  comments?: { id: string; body: string; author: string }[];
  failPermalinks?: string[];
}): typeof fetch {
  const { posts, comments = [{ id: 'c1', body: 'relevant comment text', author: 'alice' }], failPermalinks = [] } = options;

  return async (input) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);

    if (url.includes('/search.json') || url.includes('reddit.com/search') || url.includes('/r/') && url.includes('/search')) {
      return Response.json(makeSearchListing(posts));
    }

    // Comments request — check if this permalink should fail
    const shouldFail = failPermalinks.some((p) => url.includes(p.replace(/\//g, '')));
    if (shouldFail) {
      return new Response('{"error": "not found"}', { status: 404 });
    }

    return Response.json(makeCommentsListing(comments));
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('semanticReddit returns ranked results for a happy-path query', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  const result = await semanticReddit({
    query: 'semantic reddit happy path q1',
    embeddingBaseUrl: 'http://sidecar.local',
    embeddingDimensions: 4,
    topK: 5,
    clientOptions: {
      fetchImpl: makeRedditFetchImpl({
        posts: [
          { permalink: '/r/test/comments/aaa111/post_one/', title: 'Post One' },
          { permalink: '/r/test/comments/bbb222/post_two/', title: 'Post Two' },
        ],
        comments: [
          { id: 'c1', body: 'relevant comment text about the topic', author: 'alice' },
          { id: 'c2', body: 'another relevant discussion point here', author: 'bob' },
        ],
      }),
    },
  });

  assert.ok(result.results.length > 0, 'Expected at least one result');
  assert.equal(result.failedPosts, 0);
  assert.equal(result.postCount, 2);
  assert.ok(result.corpus.chunks.length > 0, 'Corpus should have chunks');
  for (const r of result.results) {
    assert.ok(typeof r.score.fused === 'number', 'Each result must have fused score');
  }
});

test('semanticReddit records failed posts in failedPosts and warnings', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  const posts = [
    { permalink: '/r/test/comments/ccc333/good_post/', title: 'Good Post' },
    { permalink: '/r/test/comments/ddd444/bad_post/', title: 'Bad Post' },
  ];

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/search.json') || (url.includes('reddit.com') && url.includes('search'))) {
      return Response.json(makeSearchListing(posts));
    }
    // Make the ddd444 post's comments return a non-retryable 404
    if (url.includes('ddd444')) {
      return new Response('not found', { status: 404 });
    }
    return Response.json(makeCommentsListing([{ id: 'c1', body: 'good comment text', author: 'alice' }]));
  };

  const result = await semanticReddit({
    query: 'failed posts unique query q2',
    embeddingBaseUrl: 'http://sidecar.local',
    embeddingDimensions: 4,
    clientOptions: { fetchImpl },
  });

  assert.ok(result.failedPosts >= 1, `Expected at least one failed post, got ${String(result.failedPosts)}`);
  assert.equal(result.postCount, 2);
  assert.ok(result.warnings && result.warnings.length > 0, 'Should have warnings for failed posts');
});

test('semanticReddit filters deleted and removed comments', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  const result = await semanticReddit({
    query: 'deleted removed filter unique query q3',
    embeddingBaseUrl: 'http://sidecar.local',
    embeddingDimensions: 4,
    topK: 5,
    clientOptions: {
      fetchImpl: makeRedditFetchImpl({
        posts: [{ permalink: '/r/test/comments/eee555/mix_post/', title: 'Mixed Post' }],
        comments: [
          { id: 'del1', body: '[deleted]', author: 'deleted' },
          { id: 'rem1', body: '[removed]', author: 'removed' },
          { id: 'ok1', body: 'real comment about the topic', author: 'alice' },
        ],
      }),
    },
  });

  // Only the real comment should appear; deleted/removed should be filtered
  assert.ok(result.corpus.chunks.length === 1, `Expected 1 chunk (real comment), got ${String(result.corpus.chunks.length)}`);
  assert.ok(
    result.corpus.chunks.every((c) => !c.text.includes('[deleted]') && !c.text.includes('[removed]')),
    'Chunks should not contain deleted or removed comments',
  );
});

test('semanticReddit returns empty corpus when all comments are deleted', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  const result = await semanticReddit({
    query: 'all deleted unique query q4',
    embeddingBaseUrl: 'http://sidecar.local',
    embeddingDimensions: 4,
    clientOptions: {
      fetchImpl: makeRedditFetchImpl({
        posts: [{ permalink: '/r/test/comments/fff666/dead_post/', title: 'Dead Post' }],
        comments: [
          { id: 'd1', body: '[deleted]', author: 'deleted' },
          { id: 'd2', body: '[removed]', author: 'removed' },
        ],
      }),
    },
  });

  assert.equal(result.results.length, 0);
  assert.equal(result.corpus.status, 'empty');
});

test('semanticReddit does not write to stdout', async () => {
  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };

  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  try {
    await semanticReddit({
      query: 'stdout test unique query q5',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
      clientOptions: {
        fetchImpl: makeRedditFetchImpl({
          posts: [{ permalink: '/r/test/comments/ggg777/stdout_post/', title: 'Stdout Post' }],
        }),
      },
    });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.equal(written.length, 0, `Unexpected stdout output: ${written.join('')}`);
});

test('semanticReddit respects a small maxBytes corpus budget', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
    if (url.includes('/embed')) {
      const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
      const body = JSON.parse(rawBody) as { texts?: string[] };
      return Response.json(makeEmbedResponse(body.texts ?? [], 4));
    }
    return new Response('not found', { status: 404 });
  };

  const result = await semanticReddit({
    query: 'budget test unique query q6',
    embeddingBaseUrl: 'http://sidecar.local',
    embeddingDimensions: 4,
    maxBytes: 1,
    clientOptions: {
      fetchImpl: makeRedditFetchImpl({
        posts: [{ permalink: '/r/test/comments/hhh888/budget_post/', title: 'Budget Post' }],
      }),
    },
  });

  assert.equal(result.corpus.status, 'empty');
  assert.equal(result.results.length, 0);
  assert.ok(
    result.warnings?.some((w) => w.toLowerCase().includes('budget')),
    'Expected a warning about the byte budget being exceeded',
  );
});
