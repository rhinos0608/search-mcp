import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolResult } from '../src/knowledge/extractor/normalise.js';
import type { SearchResult } from '../src/types.js';

test('normalizeToolResult extracts text from raw web_search result arrays', () => {
  const results: SearchResult[] = [
    {
      title: 'Example result',
      url: 'https://example.com/docs',
      description: 'Primary search result description.',
      position: 1,
      domain: 'example.com',
      source: 'duckduckgo',
      age: null,
      extraSnippet: 'Additional snippet text.',
      deepLinks: null,
    },
  ];

  const normalized = normalizeToolResult('web_search', results);

  assert.ok(normalized);
  assert.equal(normalized.url, 'https://example.com/docs');
  assert.equal(normalized.title, 'Example result');
  assert.equal(normalized.sourceKind, 'documentation');
  assert.doesNotMatch(normalized.text, /Example result/);
  assert.match(normalized.text, /Primary search result description\./);
  assert.match(normalized.text, /Additional snippet text\./);
});

test('normalizeToolResult extracts text from reddit.search posts', () => {
  const normalized = normalizeToolResult('reddit.search', [
    {
      title: 'PiSearch MCP passive memory regression',
      url: 'https://www.reddit.com/r/mcp/comments/example/passive_memory_regression/',
      selftext: 'The knowledge graph should remember passive tool observations.',
      score: 42,
      numComments: 7,
      subreddit: 'mcp',
      author: 'tester',
      createdUtc: 1_700_000_000,
      permalink: '/r/mcp/comments/example/passive_memory_regression/',
      isVideo: false,
    },
  ]);

  assert.ok(normalized);
  assert.equal(normalized.url, 'https://www.reddit.com/r/mcp/comments/example/passive_memory_regression/');
  assert.equal(normalized.title, 'PiSearch MCP passive memory regression');
  assert.equal(normalized.sourceKind, 'forum');
  assert.match(normalized.text, /PiSearch MCP passive memory regression/);
  assert.match(normalized.text, /knowledge graph should remember passive tool observations/);
});

test('normalizeToolResult extracts text from broader passive tool result shapes', () => {
  const cases: Array<{
    tool: string;
    result: unknown;
    sourceKind: string;
    expectedText: RegExp;
    expectedTitle?: string;
  }> = [
    {
      tool: 'youtube.transcript',
      result: { videoId: 'abc123abc12', fullText: 'Transcript explains passive graph recall.', transcript: [] },
      sourceKind: 'social',
      expectedText: /Transcript explains passive graph recall/,
      expectedTitle: 'YouTube transcript',
    },
    {
      tool: 'github.repo',
      result: { fullName: 'owner/project', readme: '# Project\nGraph recall implementation notes.' },
      sourceKind: 'code_repo',
      expectedText: /Graph recall implementation notes/,
      expectedTitle: 'owner/project',
    },
    {
      tool: 'research.academic',
      result: [{ title: 'Knowledge Graph Recall', abstract: 'Passive observations are searchable after ingestion.', url: 'https://example.test/paper' }],
      sourceKind: 'research_paper',
      expectedText: /Passive observations are searchable/,
      expectedTitle: 'Knowledge Graph Recall',
    },
    {
      tool: 'research.stackoverflow',
      result: [{ title: 'Why is my graph empty?', body: 'Projection rebuild omitted prior nodes.', link: 'https://stackoverflow.com/q/1' }],
      sourceKind: 'forum',
      expectedText: /Projection rebuild omitted prior nodes/,
      expectedTitle: 'Why is my graph empty?',
    },
    {
      tool: 'packages.npm',
      result: [{ name: 'search-mcp', description: 'MCP package with knowledge graph recall.', url: 'https://www.npmjs.com/package/search-mcp' }],
      sourceKind: 'package_registry',
      expectedText: /knowledge graph recall/,
      expectedTitle: 'search-mcp',
    },
    {
      tool: 'web_crawl',
      result: { pages: [{ title: 'Docs', markdown: '# Docs\nPassive memory pipeline.', url: 'https://example.test/docs' }] },
      sourceKind: 'documentation',
      expectedText: /Passive memory pipeline/,
      expectedTitle: 'Docs',
    },
  ];

  for (const c of cases) {
    const normalized = normalizeToolResult(c.tool, c.result);
    assert.ok(normalized, c.tool);
    assert.equal(normalized.sourceKind, c.sourceKind, c.tool);
    assert.match(normalized.text, c.expectedText, c.tool);
    if (c.expectedTitle !== undefined) assert.equal(normalized.title, c.expectedTitle, c.tool);
  }
});
