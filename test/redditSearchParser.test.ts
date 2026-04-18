import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRedditSearchListing } from '../src/tools/redditSearchParser.js';

test('parseRedditSearchListing canonicalizes absolute Reddit permalinks to the canonical reddit origin', () => {
  const results = parseRedditSearchListing({
    data: {
      children: [
        {
          kind: 't3',
          data: {
            title: 'Absolute permalink case',
            url: 'https://example.com/post',
            selftext: 'body',
            score: 1,
            num_comments: 2,
            subreddit: 'typescript',
            author: 'alice',
            created_utc: 1710000000,
            permalink: 'https://old.reddit.com/r/typescript/comments/abc123/absolute_permalink_case/',
            is_video: false,
          },
        },
      ],
    },
  });

  assert.equal(
    results[0]?.permalink,
    'https://www.reddit.com/r/typescript/comments/abc123/absolute_permalink_case/',
  );
});
