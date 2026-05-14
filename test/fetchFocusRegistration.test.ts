import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { resetConfig, loadConfig } from '../src/config.js';

interface RegisteredToolsShape {
  _registeredTools: Record<string, unknown>;
}

test('createServer registers fetch_focus when Crawl4AI and deep research LLM are configured', () => {
  const previous = {
    crawl4ai: process.env.CRAWL4AI_BASE_URL,
    baseUrl: process.env.DEEP_RESEARCH_BASE_URL,
    model: process.env.DEEP_RESEARCH_MODEL,
    workerModel: process.env.DEEP_RESEARCH_WORKER_MODEL,
  };

  try {
    process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
    process.env.DEEP_RESEARCH_BASE_URL = 'http://localhost:11434/v1';
    process.env.DEEP_RESEARCH_MODEL = 'test-model';
    process.env.DEEP_RESEARCH_WORKER_MODEL = 'test-worker';
    resetConfig();
    const cfg = loadConfig();

    const server = createServer(cfg) as unknown as RegisteredToolsShape;
    assert.ok(server._registeredTools.fetch_focus, 'fetch_focus should be registered');
  } finally {
    if (previous.crawl4ai === undefined) delete process.env.CRAWL4AI_BASE_URL;
    else process.env.CRAWL4AI_BASE_URL = previous.crawl4ai;

    if (previous.baseUrl === undefined) delete process.env.DEEP_RESEARCH_BASE_URL;
    else process.env.DEEP_RESEARCH_BASE_URL = previous.baseUrl;

    if (previous.model === undefined) delete process.env.DEEP_RESEARCH_MODEL;
    else process.env.DEEP_RESEARCH_MODEL = previous.model;

    if (previous.workerModel === undefined) delete process.env.DEEP_RESEARCH_WORKER_MODEL;
    else process.env.DEEP_RESEARCH_WORKER_MODEL = previous.workerModel;

    resetConfig();
  }
});
