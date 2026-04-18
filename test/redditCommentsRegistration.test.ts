import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { createServer } from '../src/server.js';

interface RegisteredToolEntry {
  description?: string;
  inputSchema?: z.ZodTypeAny;
}

function getRegisteredTool(server: ReturnType<typeof createServer>, name: string): RegisteredToolEntry {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredToolEntry> })
    ._registeredTools;
  const entry = tools[name];
  assert.ok(entry !== undefined, `tool ${name} should be registered`);
  return entry;
}

test('reddit_comments is registered on the MCP server', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');

  assert.ok(entry.description !== undefined && entry.description.length > 0);
  assert.ok(entry.inputSchema !== undefined);
});

test('reddit_comments input schema accepts a valid url-locator payload', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');
  assert.ok(entry.inputSchema !== undefined);

  const parsed = entry.inputSchema.parse({
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
    sort: 'top',
    depth: 3,
    limit: 25,
  }) as { sort: string; depth: number; limit: number; showMore: boolean };

  assert.equal(parsed.sort, 'top');
  assert.equal(parsed.depth, 3);
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.showMore, false);
});

test('reddit_comments input schema rejects context outside the 0..8 range', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');
  assert.ok(entry.inputSchema !== undefined);

  const resultHigh = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'def456',
    context: 9,
  });
  assert.equal(resultHigh.success, false);

  const resultLow = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    comment: 'def456',
    context: -1,
  });
  assert.equal(resultLow.success, false);
});

test('reddit_comments input schema rejects depth outside the 1..10 range', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');
  assert.ok(entry.inputSchema !== undefined);

  const resultHigh = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    depth: 11,
  });
  assert.equal(resultHigh.success, false);

  const resultLow = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    depth: 0,
  });
  assert.equal(resultLow.success, false);
});

test('reddit_comments input schema rejects limit outside the 1..100 range', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');
  assert.ok(entry.inputSchema !== undefined);

  const resultHigh = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    limit: 101,
  });
  assert.equal(resultHigh.success, false);

  const resultLow = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc123',
    limit: 0,
  });
  assert.equal(resultLow.success, false);
});

test('reddit_comments input schema rejects malformed subreddit and article values', () => {
  const server = createServer();
  const entry = getRegisteredTool(server, 'reddit_comments');
  assert.ok(entry.inputSchema !== undefined);

  const badSub = entry.inputSchema.safeParse({
    subreddit: 'bad/name',
    article: 'abc123',
  });
  assert.equal(badSub.success, false);

  const badArticle = entry.inputSchema.safeParse({
    subreddit: 'typescript',
    article: 'abc/123',
  });
  assert.equal(badArticle.success, false);
});
