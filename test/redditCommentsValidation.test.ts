import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRedditThreadLocator } from '../src/tools/redditThreadParser.js';

test('parseRedditThreadLocator rejects zero-locator inputs', () => {
  assert.throws(
    () => parseRedditThreadLocator({}),
    /Exactly one Reddit thread locator form is required/,
  );
});

test('parseRedditThreadLocator rejects mixed locator forms (url + permalink)', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
        permalink: '/r/typescript/comments/abc123/example_post/',
      }),
    /Exactly one Reddit thread locator form is required/,
  );
});

test('parseRedditThreadLocator rejects mixed locator forms (url + subreddit)', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
        subreddit: 'typescript',
        article: 'abc123',
      }),
    /Exactly one Reddit thread locator form is required/,
  );
});

test('parseRedditThreadLocator rejects subreddit without article', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
      }),
    /subreddit and article are both required together/,
  );
});

test('parseRedditThreadLocator rejects context when comment is not provided', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        context: 3,
      }),
    /context is only valid when comment is provided/,
  );
});

test('parseRedditThreadLocator accepts context when comment is provided', () => {
  const parsed = parseRedditThreadLocator({
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'def456',
    context: 3,
  });

  assert.equal(parsed.comment, 'def456');
  assert.equal(parsed.context, 3);
});

test('parseRedditThreadLocator rejects context below 0', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        comment: 'def456',
        context: -1,
      }),
    /context must be an integer between 0 and 8/,
  );
});

test('parseRedditThreadLocator rejects context above 8', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        comment: 'def456',
        context: 9,
      }),
    /context must be an integer between 0 and 8/,
  );
});

test('parseRedditThreadLocator rejects non-integer context', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        comment: 'def456',
        context: 2.5,
      }),
    /context must be an integer between 0 and 8/,
  );
});

test('parseRedditThreadLocator accepts context boundary values (0 and 8)', () => {
  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      comment: 'def456',
      context: 0,
    }).context,
    0,
  );

  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      comment: 'def456',
      context: 8,
    }).context,
    8,
  );
});

test('parseRedditThreadLocator rejects depth below 1', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        depth: 0,
      }),
    /depth must be an integer between 1 and 10/,
  );
});

test('parseRedditThreadLocator rejects depth above 10', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        depth: 11,
      }),
    /depth must be an integer between 1 and 10/,
  );
});

test('parseRedditThreadLocator rejects non-integer depth', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        depth: 3.5,
      }),
    /depth must be an integer between 1 and 10/,
  );
});

test('parseRedditThreadLocator accepts depth boundary values (1 and 10)', () => {
  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      depth: 1,
    }).depth,
    1,
  );

  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      depth: 10,
    }).depth,
    10,
  );
});

test('parseRedditThreadLocator rejects limit below 1', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        limit: 0,
      }),
    /limit must be an integer between 1 and 100/,
  );
});

test('parseRedditThreadLocator rejects limit above 100', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        limit: 101,
      }),
    /limit must be an integer between 1 and 100/,
  );
});

test('parseRedditThreadLocator rejects non-integer limit', () => {
  assert.throws(
    () =>
      parseRedditThreadLocator({
        subreddit: 'typescript',
        article: 'abc123',
        limit: 25.5,
      }),
    /limit must be an integer between 1 and 100/,
  );
});

test('parseRedditThreadLocator accepts limit boundary values (1 and 100)', () => {
  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      limit: 1,
    }).limit,
    1,
  );

  assert.equal(
    parseRedditThreadLocator({
      subreddit: 'typescript',
      article: 'abc123',
      limit: 100,
    }).limit,
    100,
  );
});
