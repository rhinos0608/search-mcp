import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  registerFamily,
  type FamilyDefinition,
  type ToolAnnotations,
} from '../src/tools/registry.js';

interface RegisteredToolEntry {
  inputSchema: z.ZodTypeAny;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>;
}

function getRegisteredTool(name: string): { inputSchema?: z.ZodTypeAny } {
  const server = createServer(loadConfig()).server as unknown as {
    _registeredTools: Record<string, { inputSchema?: z.ZodTypeAny }>;
  };
  const entry = server._registeredTools[name];
  assert.ok(entry, `${name} should be registered`);
  return entry;
}

test('agentic_browse defaults omitted action to browse at MCP schema boundary', () => {
  const entry = getRegisteredTool('agentic_browse');
  assert.ok(entry.inputSchema, 'agentic_browse should expose input schema');

  const result = entry.inputSchema.safeParse({ url: 'https://example.com' });
  assert.ok(result.success, JSON.stringify(result.error?.issues ?? []));
  assert.equal((result.data as { action: string }).action, 'browse');

  const emptyAction = entry.inputSchema.safeParse({ action: '', url: 'https://example.com' });
  assert.ok(emptyAction.success, JSON.stringify(emptyAction.error?.issues ?? []));
  assert.equal((emptyAction.data as { action: string }).action, 'browse');

  const nullAction = entry.inputSchema.safeParse({ action: null, url: 'https://example.com' });
  assert.ok(nullAction.success, JSON.stringify(nullAction.error?.issues ?? []));
  assert.equal((nullAction.data as { action: string }).action, 'browse');

  const invalidAction = entry.inputSchema.safeParse({ action: 'nope', url: 'https://example.com' });
  assert.equal(invalidAction.success, false);
});

test('family registry applies configured default action before handler dispatch', async () => {
  let registered: RegisteredToolEntry | undefined;
  const fakeServer = {
    registerTool: (
      _name: string,
      options: { inputSchema: z.ZodTypeAny; annotations?: ToolAnnotations },
      handler: RegisteredToolEntry['handler'],
    ) => {
      registered = { inputSchema: options.inputSchema, handler };
    },
  };

  const fixtureFamily: FamilyDefinition = {
    name: 'defaulted_family',
    description: 'Family with a default action',
    defaultAction: 'browse',
    actions: [
      {
        name: 'browse',
        description: 'Browse URL',
        schema: z.object({ action: z.literal('browse'), url: z.string() }),
        handler: async (args) => ({ action: args.action, url: args.url }),
      },
      {
        name: 'present',
        description: 'Present stored URL',
        schema: z.object({ action: z.literal('present'), documentId: z.string() }),
        handler: async (args) => ({ action: args.action, documentId: args.documentId }),
      },
    ],
  };

  registerFamily(
    fakeServer as Parameters<typeof registerFamily>[0],
    fixtureFamily,
    {} as Parameters<typeof registerFamily>[2],
  );
  assert.ok(registered, 'fixture family should register a tool');

  const parsed = registered.inputSchema.safeParse({ url: 'https://example.com' });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? []));
  assert.equal((parsed.data as { action: string }).action, 'browse');

  const response = await registered.handler({ url: 'https://example.com' });
  const text = (response as { content?: { text: string }[] }).content?.[0]?.text ?? '';
  assert.match(text, /"action": "browse"/);
});
