import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { registerFamily, type FamilyDefinition, type ToolAnnotations } from '../src/tools/registry.js';

interface RegisteredToolEntry {
  inputSchema: z.ZodTypeAny;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{
    content?: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

test('family registry accepts annotations on FamilyDefinition', () => {
  let registered: RegisteredToolEntry | undefined;
  const fakeServer = {
    registerTool: (
      _name: string,
      options: { inputSchema: z.ZodTypeAny; annotations?: ToolAnnotations },
      handler: RegisteredToolEntry['handler'],
    ) => {
      registered = {
        inputSchema: options.inputSchema,
        handler,
      };
    },
  };

  const fixtureFamily: FamilyDefinition = {
    name: 'annotated_family',
    description: 'Family with annotations',
    actions: [
      {
        name: 'fetch',
        description: 'Fetch something',
        schema: z.object({
          action: z.literal('fetch'),
          id: z.string(),
        }),
        handler: async (args) => args,
        annotations: { readOnlyHint: true },
      },
    ],
    annotations: { readOnlyHint: true },
  };

  // This call should type-check without errors — that's the primary assertion
  registerFamily(fakeServer as Parameters<typeof registerFamily>[0], fixtureFamily, {} as Parameters<typeof registerFamily>[2]);
  assert.ok(registered !== undefined, 'fixture family should register a tool');
});

test('family registry accepts annotations on individual FamilyAction', () => {
  let callCount = 0;
  const fakeServer = {
    registerTool: (
      _name: string,
      _options: { inputSchema: z.ZodTypeAny },
      _handler: RegisteredToolEntry['handler'],
    ) => {
      callCount++;
    },
  };

  const fixtureFamily: FamilyDefinition = {
    name: 'action_annotated',
    description: 'Family with per-action annotations',
    actions: [
      {
        name: 'search',
        description: 'Search',
        schema: z.object({
          action: z.literal('search'),
          q: z.string(),
        }),
        handler: async () => ({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'write',
        description: 'Write',
        schema: z.object({
          action: z.literal('write'),
          content: z.string(),
        }),
        handler: async () => ({}),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  };

  // Type-check: annotations field must be accepted on FamilyAction
  registerFamily(fakeServer as Parameters<typeof registerFamily>[0], fixtureFamily, {} as Parameters<typeof registerFamily>[2]);
  assert.equal(callCount, 1);
});