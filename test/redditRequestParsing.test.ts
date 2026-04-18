import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRedditThreadLocator } from '../src/tools/redditThreadParser.js';

test('parseRedditThreadLocator resolves reddit URL locators into request metadata', () => {
  const parsed = parseRedditThreadLocator({
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/',
    sort: 'new',
    depth: 4,
    limit: 20,
  });

  assert.equal(parsed.usedOAuth, false);
  assert.deepEqual(parsed, {
    source: 'url',
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'def456',
    sort: 'new',
    depth: 4,
    limit: 20,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/def456/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/',
  });
});

test('parseRedditThreadLocator normalizes accepted Reddit subdomains back to canonical reddit origin', () => {
  const parsed = parseRedditThreadLocator({
    url: 'https://old.reddit.com/r/typescript/comments/abc123/example_post/def456/',
  });

  assert.equal(parsed.url, 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/');
});

test('parseRedditThreadLocator rejects non-Reddit URL hosts', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        url: 'https://example.com/r/typescript/comments/abc123/example_post/def456/',
      }),
    /Invalid Reddit thread URL host/,
  );
});

test('parseRedditThreadLocator aligns subreddit/article locator metadata and target when explicit comment is provided', () => {
  const parsed = parseRedditThreadLocator({
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'zzz999',
  });

  assert.deepEqual(parsed, {
    source: 'subreddit_article',
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'zzz999',
    sort: 'confidence',
    depth: undefined,
    limit: undefined,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/_/zzz999/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/_/zzz999/',
  });
});

test('parseRedditThreadLocator updates permalink and url when explicit comment overrides parsed comment metadata', () => {
  const parsed = parseRedditThreadLocator({
    permalink: '/r/typescript/comments/abc123/example_post/def456/',
    comment: 'zzz999',
  });

  assert.deepEqual(parsed, {
    source: 'permalink',
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'zzz999',
    sort: 'confidence',
    depth: undefined,
    limit: undefined,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/zzz999/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/zzz999/',
  });
});

test('parseRedditThreadLocator rejects non-http schemes for URL locators', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        url: 'javascript://www.reddit.com/r/typescript/comments/abc123/example_post/def456/',
      }),
    /Invalid Reddit thread URL scheme/,
  );
});

test('parseRedditThreadLocator strips query params from URL locators and parses the canonical thread path', () => {
  const parsed = parseRedditThreadLocator({
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/?context=3',
  });

  assert.deepEqual(parsed, {
    source: 'url',
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'def456',
    sort: 'confidence',
    depth: undefined,
    limit: undefined,
    context: undefined,
    showMore: false,
    usedOAuth: false,
    permalink: '/r/typescript/comments/abc123/example_post/def456/',
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/',
  });
});

test('parseRedditThreadLocator rejects URL locators with malformed extra trailing segments', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/def456/extra/',
      }),
    /Unsupported Reddit thread path/,
  );
});

test('parseRedditThreadLocator rejects invalid direct subreddit/article/comment segments before interpolation', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'type/script',
        article: 'abc123',
      }),
    /Invalid Reddit thread subreddit/,
  );

  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc/123',
      }),
    /Invalid Reddit thread article/,
  );

  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        comment: 'zzz/999',
      }),
    /Invalid Reddit thread comment/,
  );

  assert.throws(
    () =>
      parseRedditThreadLocator({
        permalink: '/r/typescript/comments/abc123/example_post/def456/',
        comment: 'zzz/999',
      }),
    /Invalid Reddit thread comment/,
  );
});
