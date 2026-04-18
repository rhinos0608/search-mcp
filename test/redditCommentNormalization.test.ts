import test from 'node:test';
import assert from 'node:assert/strict';

import { redditCommentsListingFixture } from './fixtures/redditFixtures.js';
import { normalizeRedditThreadResponse } from '../src/tools/redditThreadParser.js';

test('normalizeRedditThreadResponse returns a normalized post, comments, and omitted more metadata', () => {
  const request = {
    source: 'url' as const,
    subreddit: 'typescript',
    article: 'abc123',
    comment: undefined,
    sort: 'top' as const,
    depth: 3,
    limit: 25,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
  };

  const normalized = normalizeRedditThreadResponse(redditCommentsListingFixture, request);

  assert.deepEqual(normalized, {
    post: {
      id: 'abc123',
      fullname: 't3_abc123',
      title: 'Example Post',
      selftext: 'Post body',
      author: 'op',
      subreddit: 'typescript',
      score: 101,
      numComments: 3,
      createdUtc: 1710100000,
      permalink: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
      url: 'https://example.com/post',
      isVideo: false,
    },
    comments: [
      {
        id: 'c1',
        fullname: 't1_c1',
        author: 'alice',
        body: 'Top level comment',
        score: 11,
        createdUtc: 1710100100,
        permalink: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/c1/',
        parentId: 't3_abc123',
        depth: 0,
        replies: [
          {
            id: 'c2',
            fullname: 't1_c2',
            author: 'bob',
            body: 'Nested reply',
            score: 5,
            createdUtc: 1710100200,
            permalink: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/c2/',
            parentId: 't1_c1',
            depth: 1,
            replies: [],
            distinguished: 'moderator',
            stickied: false,
            collapsed: false,
          },
        ],
        distinguished: null,
        stickied: false,
        collapsed: false,
      },
    ],
    more: [
      {
        id: 'more-nested',
        parentId: 't1_c1',
        depth: 1,
        count: 2,
        children: ['c3', 'c4'],
      },
      {
        id: 'more-top',
        parentId: 't3_abc123',
        depth: 0,
        count: 1,
        children: ['c5'],
      },
    ],
    request,
  });
});

test('normalizeRedditThreadResponse does not overflow the stack on deeply nested replies (20000 levels)', () => {
  const request = {
    source: 'url' as const,
    subreddit: 'typescript',
    article: 'abc123',
    comment: undefined,
    sort: 'top' as const,
    depth: 3,
    limit: 25,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
  };

  interface MaliciousCommentData {
    id: string;
    name: string;
    author: string;
    body: string;
    score: number;
    created_utc: number;
    permalink: string;
    parent_id: string;
    depth: number;
    distinguished: null;
    stickied: false;
    collapsed: false;
    replies: '' | { data: { children: { kind: 't1'; data: MaliciousCommentData }[] } };
  }

  function buildNested(depth: number): MaliciousCommentData {
    const node: MaliciousCommentData = {
      id: `c${String(depth)}`,
      name: `t1_c${String(depth)}`,
      author: 'alice',
      body: 'nested',
      score: 1,
      created_utc: 1710100000 + depth,
      permalink: `/r/typescript/comments/abc123/example_post/c${String(depth)}/`,
      parent_id: depth === 0 ? 't3_abc123' : `t1_c${String(depth - 1)}`,
      depth,
      distinguished: null,
      stickied: false,
      collapsed: false,
      replies: '',
    };

    return node;
  }

  function buildDeepChain(targetDepth: number): MaliciousCommentData {
    // Build iteratively to avoid stack overflow in the test builder itself.
    const root = buildNested(0);
    let cursor: MaliciousCommentData = root;
    for (let d = 1; d <= targetDepth; d += 1) {
      const next = buildNested(d);
      cursor.replies = {
        data: {
          children: [{ kind: 't1', data: next }],
        },
      };
      cursor = next;
    }
    return root;
  }

  const response = [
    {
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'abc123',
              name: 't3_abc123',
              title: 'Example Post',
              selftext: 'Post body',
              author: 'op',
              subreddit: 'typescript',
              score: 101,
              num_comments: 1,
              created_utc: 1710100000,
              permalink: '/r/typescript/comments/abc123/example_post/',
              url: 'https://example.com/post',
              is_video: false,
            },
          },
        ],
      },
    },
    {
      data: {
        children: [
          {
            kind: 't1',
            data: buildDeepChain(20000),
          },
        ],
      },
    },
  ];

  // Should not throw RangeError: Maximum call stack size exceeded.
  const normalized = normalizeRedditThreadResponse(response, request);
  assert.equal(normalized.comments.length, 1);
  const firstComment = normalized.comments[0];
  assert.ok(firstComment !== undefined);
  assert.ok('body' in firstComment, 'first comment should be a comment node');
  assert.equal(firstComment.id, 'c0');
});

test('normalizeRedditThreadResponse canonicalizes absolute Reddit permalinks to canonical reddit origin', () => {
  const request = {
    source: 'url' as const,
    subreddit: 'typescript',
    article: 'abc123',
    comment: undefined,
    sort: 'top' as const,
    depth: 3,
    limit: 25,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
  };

  const response = [
    {
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'abc123',
              name: 't3_abc123',
              title: 'Example Post',
              selftext: 'Post body',
              author: 'op',
              subreddit: 'typescript',
              score: 101,
              num_comments: 3,
              created_utc: 1710100000,
              permalink: 'https://old.reddit.com/r/typescript/comments/abc123/example_post/',
              url: 'https://example.com/post',
              is_video: false,
            },
          },
        ],
      },
    },
    {
      data: {
        children: [
          {
            kind: 't1',
            data: {
              id: 'c1',
              name: 't1_c1',
              author: 'alice',
              body: 'Top level comment',
              score: 11,
              created_utc: 1710100100,
              permalink: 'https://old.reddit.com/r/typescript/comments/abc123/example_post/c1/?utm_source=test',
              parent_id: 't3_abc123',
              depth: 0,
              distinguished: null,
              stickied: false,
              collapsed: false,
              replies: '',
            },
          },
        ],
      },
    },
  ];

  const normalized = normalizeRedditThreadResponse(response, request);

  assert.equal(
    normalized.post.permalink,
    'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
  );
  assert.equal(
    normalized.comments[0] && 'permalink' in normalized.comments[0] ? normalized.comments[0].permalink : '',
    'https://www.reddit.com/r/typescript/comments/abc123/example_post/c1/?utm_source=test',
  );
});
