import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { loadConfig } from '../src/config.js';
import { registerFamily, type FamilyDefinition } from '../src/tools/registry.js';

interface RegisteredToolEntry {
  inputSchema: z.ZodTypeAny;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{
    content?: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

function registerFixtureFamily(): RegisteredToolEntry {
  let registered: RegisteredToolEntry | undefined;
  const fakeServer = {
    registerTool: (
      _name: string,
      options: { inputSchema: z.ZodTypeAny },
      handler: RegisteredToolEntry['handler'],
    ) => {
      registered = { inputSchema: options.inputSchema, handler };
    },
  };

  const fixtureFamily: FamilyDefinition = {
    name: 'fixture_family',
    description: 'Fixture family for registry validation behavior',
    actions: [
      {
        name: 'search',
        description: 'Fixture search action',
        schema: z.object({
          action: z.literal('search'),
          query: z.string(),
          sort: z.enum(['top', 'new']).optional().default('top'),
          limit: z.number().int().min(1).max(100).optional().default(10),
          subreddit: z.string().optional().default('all'),
        }),
        handler: async (args) => args,
      },
    ],
  };

  registerFamily(fakeServer as Parameters<typeof registerFamily>[0], fixtureFamily, loadConfig());
  assert.ok(registered !== undefined, 'fixture family should register a tool');
  return registered;
}

test('family registry treats top-level null optional defaults as omitted', async () => {
  const entry = registerFixtureFamily();
  const rawArgs = {
    action: 'search',
    query: 'zod defaults',
    sort: null,
    limit: null,
  };

  const discoveryParse = entry.inputSchema.safeParse(rawArgs);
  assert.equal(discoveryParse.success, true);

  const result = await entry.handler(rawArgs, {});
  assert.equal(result.isError, undefined);

  const text = result.content?.[0]?.text ?? '';
  assert.match(text, /"sort": "top"/);
  assert.match(text, /"limit": 10/);
});

test('family registry still rejects null required fields', async () => {
  const entry = registerFixtureFamily();

  const result = await entry.handler(
    {
      action: 'search',
      query: null,
      sort: null,
    },
    {},
  );

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? '', /validation error/i);
});

test('family registry honours fuzzyCorrect false from merged schema fields', async () => {
  const entry = registerFixtureFamily();

  const result = await entry.handler(
    {
      action: 'search',
      query: 'javascrpt',
      fuzzyCorrect: false,
    },
    {},
  );

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
    data?: { query?: string };
    meta?: { correction?: unknown };
  };
  assert.equal(payload.data?.query, 'javascrpt');
  assert.equal(payload.meta?.correction, undefined);
});

test('family registry treats optional empty string as omitted (applies default)', async () => {
  const entry = registerFixtureFamily();
  const rawArgs = {
    action: 'search',
    query: 'empty subreddit',
    subreddit: '',
  };

  const result = await entry.handler(rawArgs, {});
  assert.equal(result.isError, undefined);

  const text = result.content?.[0]?.text ?? '';
  // The default 'all' should be applied since empty string is treated as omitted
  const payload = JSON.parse(text) as { data?: { subreddit?: string } };
  assert.equal(payload.data?.subreddit, 'all');
});

test('family registry still rejects empty string for required fields', async () => {
  const entry = registerFixtureFamily();

  const result = await entry.handler(
    {
      action: 'search',
      query: '',
      subreddit: 'test',
    },
    {},
  );

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? '', /validation error/i);
});
