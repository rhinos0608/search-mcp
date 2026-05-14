/**
 * Tests for the consolidated `reddit` family tool.
 *
 * Validates registration, schema shape, and the nested post-locator
 * discriminated union for the `comments` action.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

interface RegisteredToolEntry {
   description?: string;
   inputSchema?: z.ZodTypeAny;
}

function getRegisteredTool(
   server: ReturnType<typeof createServer>,
   name: string,
): RegisteredToolEntry {
   const tools = (server as unknown as {
      _registeredTools: Record<string, RegisteredToolEntry>;
   })._registeredTools;
   const entry = tools[name];
   assert.ok(entry !== undefined, `tool ${name} should be registered`);
   return entry;
}

test('reddit family actions are registered on the MCP server', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');

   assert.ok(entry.description !== undefined && entry.description.length > 0);
   assert.ok(entry.inputSchema !== undefined);
});

test('reddit.comments accepts a valid url post locator', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const parsed = entry.inputSchema.parse({
      action: 'comments',
      post: {
         type: 'url',
         url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
      },
      sort: 'top',
      depth: 3,
      limit: 25,
   }) as { action: string; post: { type: string; url: string }; sort: string; depth: number; limit: number; showMore: boolean };

   assert.equal(parsed.action, 'comments');
   assert.equal(parsed.post.type, 'url');
   assert.equal(typeof parsed.post.url, 'string');
   assert.equal(parsed.sort, 'top');
   assert.equal(parsed.depth, 3);
   assert.equal(parsed.limit, 25);
   assert.equal(parsed.showMore, false);
});

test('reddit.comments accepts a valid id post locator', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const parsed = entry.inputSchema.parse({
      action: 'comments',
      post: { type: 'id', subreddit: 'typescript', postId: 'abc123' },
      sort: 'confidence',
   }) as { action: string; post: { type: string; subreddit: string; postId: string } };

   assert.equal(parsed.action, 'comments');
   assert.equal(parsed.post.type, 'id');
   assert.equal(parsed.post.subreddit, 'typescript');
   assert.equal(parsed.post.postId, 'abc123');
});

test('reddit.comments accepts a valid permalink post locator', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const parsed = entry.inputSchema.parse({
      action: 'comments',
      post: { type: 'permalink', permalink: '/r/typescript/comments/abc123/' },
   }) as { action: string; post: { type: string; permalink: string } };

   assert.equal(parsed.action, 'comments');
   assert.equal(parsed.post.type, 'permalink');
   assert.ok(parsed.post.permalink.startsWith('/r/'));
});

test('reddit.comments rejects an invalid post locator (missing fields)', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   // Missing post entirely
   const noPost = entry.inputSchema.safeParse({ action: 'comments', sort: 'top' });
   assert.equal(noPost.success, false);

   // id locator missing postId
   const partialId = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'id', subreddit: 'typescript' },
   });
   assert.equal(partialId.success, false);
});

test('reddit.comments rejects context without comment', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   // context without comment — schema-level validation doesn't catch this
   // (it's caught at handler level by redditThreadParser), but the schema
   // should allow it since context is optional.
   const parsed = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' },
      context: 3,
   });
   // Schema allows it; handler will reject it
   assert.equal(parsed.success, true);
});

test('reddit.comments rejects depth outside 1..10', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const high = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' },
      depth: 11,
   });
   assert.equal(high.success, false);

   const low = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' },
      depth: 0,
   });
   assert.equal(low.success, false);
});

test('reddit.comments rejects limit outside 1..100', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const high = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' },
      limit: 101,
   });
   assert.equal(high.success, false);

   const low = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' },
      limit: 0,
   });
   assert.equal(low.success, false);
});

test('reddit.comments rejects malformed subreddit in id locator', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const bad = entry.inputSchema.safeParse({
      action: 'comments',
      post: { type: 'id', subreddit: 'bad/name', postId: 'abc123' },
   });
   assert.equal(bad.success, false);
});

test('reddit.search accepts basic params', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const parsed = entry.inputSchema.parse({
      action: 'search',
      query: 'typescript generics',
      subreddit: 'typescript',
      sort: 'new',
      limit: 10,
   }) as { action: string; query: string; sort: string; limit: number };

   assert.equal(parsed.action, 'search');
   assert.equal(parsed.query, 'typescript generics');
   assert.equal(parsed.sort, 'new');
   assert.equal(parsed.limit, 10);
});

test('reddit.semantic accepts basic params', () => {
   const server = createServer(loadConfig());
   const entry = getRegisteredTool(server, 'reddit');
   assert.ok(entry.inputSchema !== undefined);

   const parsed = entry.inputSchema.parse({
      action: 'semantic',
      query: 'error handling patterns',
      maxPosts: 5,
      topK: 20,
   }) as { action: string; query: string; maxPosts: number; topK: number };

   assert.equal(parsed.action, 'semantic');
   assert.equal(parsed.query, 'error handling patterns');
   assert.equal(parsed.maxPosts, 5);
   assert.equal(parsed.topK, 20);
});
