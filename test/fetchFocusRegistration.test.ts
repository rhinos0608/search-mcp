import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

interface RegisteredToolsShape {
  _registeredTools: Record<string, unknown>;
}

test('createServer exposes agentic_browse.focus and deprecated fetch_focus alias when Crawl4AI and deep research LLM are configured', () => {
  const cfg = loadConfig();
  const configured = {
    ...cfg,
    crawl4ai: { ...cfg.crawl4ai, baseUrl: 'http://localhost:11235' },
    deepResearch: {
      ...cfg.deepResearch,
      baseUrl: 'http://localhost:11434/v1',
      model: 'test-model',
      workerModel: 'test-worker',
    },
  };

  const { server } = createServer(configured);
  const registeredTools = (server as unknown as RegisteredToolsShape)._registeredTools;
  assert.ok(registeredTools.fetch_focus, 'fetch_focus should be registered as deprecated alias');
  assert.ok(registeredTools.agentic_browse, 'agentic_browse should be registered');
});
