import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeGraphHook } from '../src/knowledge/hook.js';
import { initKgDb, closeKgDb } from '../src/knowledge/store/db.js';
import { queryNodes } from '../src/knowledge/store/projections.js';
import { loadConfig, type SearchConfig } from '../src/config.js';
import { DEFAULT_KG_CONFIG } from '../src/knowledge/config.js';
import type { ResearchResult } from '../src/research/types.js';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeKgDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeKgConfig(dbPath: string): SearchConfig {
  return {
    ...loadConfig(),
    scrubContent: false,
    llm: {
      provider: 'test-model',
      baseUrl: 'https://llm.example',
      apiToken: '',
    },
    knowledgeGraph: {
      ...DEFAULT_KG_CONFIG,
      enabled: true,
      dbPath,
    },
  };
}

async function waitForNode(label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (queryNodes({ label, limit: 5 }).nodes.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installKgFetchMock(label: string, evidence: string): () => number {
  let chatCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/chat/completions')) {
      return Response.json({
        embeddings: [Array.from({ length: 768 }, () => 0.1)],
        model: 'test',
        modelRevision: 'r1',
        dimensions: 768,
        mode: 'document',
        truncatedIndices: [],
      });
    }

    chatCalls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                {
                  local_id: 'e1',
                  label,
                  type: 'work',
                  extraction_confidence: 0.92,
                  evidence,
                },
              ],
              relationships: [],
            }),
          },
        },
      ],
    });
  }) as typeof fetch;
  return () => chatCalls;
}

test('passive reddit observations are flushed through extraction and become queryable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-passive-recall-'));
  tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, 'kg.sqlite');
  initKgDb(dbPath);

  const getChatCalls = installKgFetchMock('PiSearch MCP', 'PiSearch MCP');

  const hook = new KnowledgeGraphHook(makeKgConfig(dbPath));
  hook.setSessionId('test-session');

  await hook.onToolCall('reddit.search', [
    {
      title: 'PiSearch MCP passive memory regression',
      url: 'https://www.reddit.com/r/mcp/comments/example/passive_memory_regression/',
      selftext: 'PiSearch MCP should remember passive tool observations.',
      score: 42,
      numComments: 7,
      subreddit: 'mcp',
      author: 'tester',
      createdUtc: 1_700_000_000,
      permalink: '/r/mcp/comments/example/passive_memory_regression/',
      isVideo: false,
    },
  ]);

  await hook.flushSession('test-session');
  await waitForNode('PiSearch MCP');

  assert.equal(getChatCalls(), 1);
  const nodes = queryNodes({ label: 'PiSearch MCP', limit: 5 }).nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.label, 'PiSearch MCP');
});

test('newly consolidated research actions are passively captured and queryable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-research-passive-'));
  tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, 'kg.sqlite');
  initKgDb(dbPath);

  const getChatCalls = installKgFetchMock('PubMed Recall', 'PubMed Recall');
  const hook = new KnowledgeGraphHook(makeKgConfig(dbPath));
  hook.setSessionId('research-session');

  await hook.onToolCall('research.pubmed', [
    {
      title: 'PubMed Recall',
      abstract: 'PubMed Recall should enter the passive knowledge graph.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/example',
    },
  ]);
  await hook.flushSession('research-session');

  assert.equal(getChatCalls(), 1);
  const nodes = queryNodes({ label: 'PubMed Recall', limit: 5 }).nodes;
  assert.equal(nodes.length, 1);
});

test('deep research completion is extracted and immediately queryable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-deep-research-'));
  tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, 'kg.sqlite');
  initKgDb(dbPath);

  const getChatCalls = installKgFetchMock('Deep Research Recall', 'Deep Research Recall');
  const hook = new KnowledgeGraphHook(makeKgConfig(dbPath));
  const result: ResearchResult = {
    report: {
      query: 'Investigate deep research recall',
      classification: 'technical',
      depth: 'quick',
      executiveSummary: 'Deep Research Recall should be queryable.',
      narrativeMarkdown: '# Deep Research Recall\nDeep Research Recall should be queryable after completion.',
      themes: [],
      contradictions: [],
      uncertainties: [],
      sourceNotes: [],
      openQuestions: [],
      limitations: [],
      sourceCount: 1,
      findingCount: 1,
      sourceTypeCount: 1,
      sourceDiversity: [{ type: 'web', count: 1 }],
      evidenceSources: [],
    },
    timeline: [],
  };

  await hook.onDeepResearchComplete('job-1', result);

  assert.ok(getChatCalls() >= 1);
  const nodes = queryNodes({ label: 'Deep Research Recall', limit: 5 }).nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.label, 'Deep Research Recall');
});
