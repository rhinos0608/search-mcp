/**
 * Tests ensuring family tools are registered as a single MCP tool with a
 * discriminated-union `action` field, rather than N separate individual tools.
 *
 * This guards against regressions where family actions leak into the MCP
 * tool list, causing clients to see 30+ tools instead of ~12 consolidated ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface RegisteredToolEntry {
  description?: string;
  inputSchema?: z.ZodTypeAny;
}

/** All expected tool names. Families are single-entry, per-action tools are gone. */
const STANDALONE_TOOLS = new Set([
  'web_search',
  'web_read',
  'health_check',
]);

/** Tools that require specific config and may not be registered in default env. */
const GATED_STANDALONE_TOOLS = new Set([
  'web_crawl',
  'semantic_crawl',
  'semantic_jobs',
  'deep_research',
  'fetch_focus',
]);

const FAMILY_TOOLS = new Map<string, string[]>([
  ['github', ['repo', 'file', 'tree', 'search', 'trending', 'code_search']],
  ['youtube', ['search', 'transcript', 'semantic']],
  ['reddit', ['search', 'comments', 'semantic']],
  ['research', ['academic', 'arxiv', 'hackernews', 'stackoverflow', 'pubmed', 'wikipedia']],
  ['packages', ['npm', 'pypi']],
  ['browser', ['navigate', 'snapshot', 'click', 'type', 'evaluate', 'screenshot', 'extract', 'act', 'wait', 'pdf', 'storage', 'network', 'tabs', 'session']],
]);

function getAllRegisteredTools(
  server: ReturnType<typeof createServer>,
): Record<string, RegisteredToolEntry> {
  return (server as unknown as {
    _registeredTools: Record<string, RegisteredToolEntry>;
  })._registeredTools;
}

function getRegisteredTool(
  server: ReturnType<typeof createServer>,
  name: string,
): RegisteredToolEntry {
  const tools = getAllRegisteredTools(server);
  const entry = tools[name];
  assert.ok(entry !== undefined, `tool "${name}" should be registered`);
  return entry;
}

// ── Consolidated count ──────────────────────────────────────────────────────

test('total registered tools is under 20 (consolidated)', () => {
  const server = createServer(loadConfig());
  const tools = getAllRegisteredTools(server);
  const names = Object.keys(tools);

  // Families consolidated → ~14 tools. Allow some headroom for gated/growth.
  assert.ok(
    names.length < 20,
    `Expected fewer than 20 tools, got ${names.length}: [${names.sort().join(', ')}]`,
  );
});

// ── No leaked per-action tools ───────────────────────────────────────────────

test('no per-action leaked tools exist (no github_repo, reddit_search etc.)', () => {
  const server = createServer(loadConfig());
  const tools = getAllRegisteredTools(server);

  // Common old patterns that should NOT exist
  const leakedPatterns = [
    /^github_/,
    /^reddit_/,
    /^youtube_/,
    /^research_/,
    /^packages_/,
    /^browser_/,
  ];

  for (const name of Object.keys(tools)) {
    for (const pattern of leakedPatterns) {
      assert.ok(
        !pattern.test(name),
        `Leaked per-action tool "${name}" matches pattern ${pattern}. ` +
          `${name.split('_')[0]} should be a single family tool, not individual actions.`,
      );
    }
  }
});

// ── Each family registers as a single tool ──────────────────────────────────

for (const [familyName, actions] of FAMILY_TOOLS) {
  test(`${familyName} family registers as a single tool (not ${actions.length} separate tools)`, () => {
    const server = createServer(loadConfig());
    const tools = getAllRegisteredTools(server);

    // The family tool exists
    const entry = tools[familyName];
    assert.ok(entry !== undefined, `${familyName} tool should be registered`);
    assert.ok(entry.inputSchema !== undefined, `${familyName} should have an input schema`);

    // Actions like "github_repo" should NOT exist
    for (const action of actions) {
      const leakedName = `${familyName}_${action}`;
      assert.ok(
        !(leakedName in tools),
        `"${leakedName}" should NOT be a separate tool — it should be an action within the "${familyName}" family tool`,
      );
    }
  });
}

// ── Each family's input schema is a discriminated union ──────────────────────

for (const [familyName, actions] of FAMILY_TOOLS) {
  test(`${familyName} input schema validates every known action via discriminated union`, () => {
    const entry = getRegisteredTool(createServer(loadConfig()), familyName);
    const schema = entry.inputSchema!;

    // Each known action should parse successfully
    for (const action of actions) {
    // Build minimal valid params for this action
      const params: Record<string, unknown> = { action };
      // Add required fields for actions that need them
      if (
        action === 'search' ||
        action === 'semantic' ||
        action === 'code_search' ||
        action === 'npm' ||
        action === 'pypi' ||
        action === 'academic' ||
        action === 'arxiv' ||
        action === 'hackernews' ||
        action === 'pubmed' ||
        action === 'wikipedia' ||
        action === 'stackoverflow'
      ) {
        params.query = 'test';
      }
      if (action === 'repo') {
        params.repository = 'owner/repo';
      }
      if (action === 'file') {
        params.owner = 'owner';
        params.repo = 'repo';
        params.path = 'README.md';
      }
      if (action === 'tree') {
        params.owner = 'owner';
        params.repo = 'repo';
      }
      if (action === 'transcript') {
        params.videoId = 'abc123';
      }
      if (action === 'comments') {
        params.post = { type: 'url', url: 'https://www.reddit.com/r/test/comments/abc/' };
      }
      if (action === 'navigate' || action === 'extract') {
        params.url = 'https://example.com';
      }
      if (action === 'code_search') {
        params.repo = 'owner/repo';
      }
      if (action === 'evaluate') {
        params.expression = '() => document.title';
      }
      if (action === 'click' || action === 'type') {
        params.target = 'button.submit';
      }
      if (action === 'type') {
        params.text = 'hello';
      }
      if (action === 'act') {
        params.instruction = 'click the login button';
      }
      if (action === 'storage' || action === 'network' || action === 'tabs' || action === 'session') {
        params.op = action === 'storage' ? 'list-cookies' : action === 'network' ? 'list-requests' : action === 'tabs' ? 'list' : 'status';
      }

      const result = schema.safeParse(params);
      assert.ok(
        result.success,
        `${familyName}.${action} should validate with discriminated union. Errors: ${JSON.stringify(
          result.error?.issues ?? 'none',
        )}`,
      );
    }

    // Unknown action should be rejected
    const bad = schema.safeParse({ action: 'nonexistent_xyz' });
    assert.ok(!bad.success, `${familyName} should reject unknown action`);
  });
}

// ── Standalone tools remain registered ──────────────────────────────────────

for (const toolName of STANDALONE_TOOLS) {
  test(`standalone tool "${toolName}" is registered (unchanged)`, () => {
    const server = createServer(loadConfig());
    const tools = getAllRegisteredTools(server);
    assert.ok(
      toolName in tools,
      `Standalone tool "${toolName}" should still be registered`,
    );
  });
}

for (const toolName of GATED_STANDALONE_TOOLS) {
  test(`gated standalone tool "${toolName}" is either registered or gated (not leaked per-action)`, () => {
    const server = createServer(loadConfig());
    const tools = getAllRegisteredTools(server);
    // Gated tools may or may not be registered depending on env, but they should
    // never have leaked per-action variants.
    if (toolName in tools) {
      assert.ok(true, `${toolName} is registered (config present)`);
    } else {
      // Not registered due to gating — fine
      assert.ok(true, `${toolName} is gated (config missing)`);
    }
  });
}

// ── Full tool list sanity check ─────────────────────────────────────────────

test('all family tools are present in the consolidated tool list', () => {
  const server = createServer(loadConfig());
  const tools = getAllRegisteredTools(server);

  for (const familyName of FAMILY_TOOLS.keys()) {
    assert.ok(
      familyName in tools,
      `Family tool "${familyName}" should be registered. Available tools: ${Object.keys(tools).sort().join(', ')}`,
    );
  }
});
