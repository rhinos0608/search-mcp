/**
 * AgentStrategy tests — ReAct loop, response parsing, fallback behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('AgentResponseParser', () => {
  it('parses ACTION with ARGUMENTS', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Need to search\nACTION: search_web\nARGUMENTS: {"query": "test", "limit": 5}';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.strictEqual(parsed.tool, 'search_web');
    assert.strictEqual((parsed.args as any).query, 'test');
    assert.strictEqual((parsed.args as any).limit, 5);
    assert.strictEqual(parsed.thought, 'Need to search');
  });

  it('parses ANSWER', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Found enough\nANSWER: The answer is 42.';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'answer');
    assert.ok(parsed.content?.includes('The answer is 42'));
    assert.strictEqual(parsed.thought, 'Found enough');
  });

  it('detects missing ARGUMENTS', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Need to search\nACTION: search_web';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'error');
    assert.ok(parsed.message?.includes('no ARGUMENTS found'));
  });

  it('falls back to raw text when JSON in ARGUMENTS is malformed', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Need to search\nACTION: search_web\nARGUMENTS: {bad json}';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.strictEqual(parsed.tool, 'search_web');
    assert.strictEqual((parsed.args as any)._rawArgs, '{bad json}');
  });

  it('falls back to error for unparseable input', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'Just some random text without any format';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'error');
    assert.ok(parsed.message?.includes('Could not parse response'));
  });

  it('handles multi-line THOUGHT', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: This is a\nmulti-line thought\nspanning several lines\nACTION: search_web\nARGUMENTS: {"query": "test"}';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.ok((parsed.thought?.match(/\n/g)?.length ?? 0) >= 2, 'THOUGHT should contain multiple lines');
  });

  it('tolerates markdown fences around ARGUMENTS', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = `THOUGHT: Need to search
ACTION: search_web
ARGUMENTS: \`\`\`json
{"query": "test", "limit": 5}
\`\`\``;
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.strictEqual((parsed.args as any).query, 'test');
  });

  it('tolerates same-line ACTION after THOUGHT', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Let me search ACTION: search_web ARGUMENTS: {"query": "test"}';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.strictEqual(parsed.tool, 'search_web');
    assert.strictEqual(parsed.thought, 'Let me search');
  });

  it('handles escaped quotes inside JSON string', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    const text = 'THOUGHT: Need to search\nACTION: search_web\nARGUMENTS: {"query": "What does \\"foo\\" mean"}';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'action');
    assert.strictEqual((parsed.args as any).query, 'What does "foo" mean');
  });

  it('ignores array-shaped ARGUMENTS and prefers object', async () => {
    const { parseAgentResponse } = await import('../../src/research/strategies/agentStrategy.js');
    // Arrays should be ignored; if no object is present, it should error
    const text = 'THOUGHT: Need to search\nACTION: search_web\nARGUMENTS: [1, 2, 3]';
    const parsed = parseAgentResponse(text);
    assert.strictEqual(parsed.type, 'error');
  });
});

describe('AgentStrategy instantiation', () => {
   it('can be imported and has correct interface', async () => {
      const { AgentStrategy } = await import('../../src/research/strategies/agentStrategy.js');

      assert.strictEqual(typeof AgentStrategy, 'function');

      // Construct with minimal mock context
      const strategy = new (AgentStrategy as any)({
         config: {
            enabled: true,
            defaultDepth: 'standard',
            maxDepth: 'deep',
            maxToolCalls: 200,
            maxTokens: 500_000,
            maxTimeMs: 300_000,
            baseUrl: 'http://localhost',
            model: 'test-model',
            workerModel: 'test-model',
            treeBreadth: 4,
            treeDepth: 2,
            treeConcurrency: 2,
            treeContextWordLimit: 25000,
            searchBackend: 'brave',
         },
         state: {
            initialize() { /* noop */ },
            setLanguage() { /* noop */ },
            addSource() { return 'source-1'; },
            getFullState() { return {}; },
         },
         budget: {
            recordTokens() { return true; },
            isExhausted() { return false; },
            profile: { maxGapLoops: 0 },
         },
         llm: {} as any,
         abortSignal: undefined,
         onProgress: undefined,
      });

      assert.strictEqual(strategy.name, 'agent');
      assert.strictEqual(strategy.requiresLlm, true);
      assert.ok(strategy.description.length > 0);
   });
});

describe('CitationCollector integration', () => {
   it('collector addResults returns sequential indices', async () => {
      const { CitationCollector } = await import('../../src/research/citationCollector.js');
      const collector = new CitationCollector();

      collector.addResults(
         [{ title: 'Test', link: 'https://example.com', snippet: 'hello' }],
         'web',
      );
      assert.strictEqual(collector.count, 1);

      const all = collector.getAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]?.title, 'Test');
      assert.strictEqual(all[0]?.index, 1);
   });

   it('collector formatForLlm includes source info', async () => {
      const { CitationCollector } = await import('../../src/research/citationCollector.js');
      const collector = new CitationCollector();

      collector.addResults(
         [
            { title: 'Article', link: 'https://example.com/article', snippet: 'Content here' },
         ],
         'web',
      );
      const text = collector.formatForLlm();
      assert.ok(text.includes('[1]'), 'includes citation index');
      assert.ok(text.includes('Article'), 'includes title');
      assert.ok(text.includes('example.com'), 'includes URL');
   });
});

describe('StrategyRegistry', () => {
   it('can be imported and has correct methods', async () => {
      const { strategyRegistry } = await import('../../src/research/strategies/registry.js');
      assert.strictEqual(typeof strategyRegistry.register, 'function');
      assert.strictEqual(typeof strategyRegistry.create, 'function');
      assert.strictEqual(typeof strategyRegistry.selectDefault, 'function');
      assert.strictEqual(typeof strategyRegistry.listAvailable, 'function');
      assert.strictEqual(typeof strategyRegistry.has, 'function');
   });

   it('throws on unknown strategy', async () => {
      const { strategyRegistry } = await import('../../src/research/strategies/registry.js');
      assert.throws(
         () => strategyRegistry.create('nonexistent', {} as any),
         /Unknown strategy/,
      );
   });

   it('prevents duplicate registration', async () => {
      const { strategyRegistry } = await import('../../src/research/strategies/registry.js');
      assert.throws(
         () => {
            const name = 'test-strategy-' + Math.random().toString(36).slice(2);
            strategyRegistry.register(name, () => ({ name, description: '', requiresLlm: false, analyze: async () => ({ report: {} as any, timeline: [] }) }));
            strategyRegistry.register(name, () => ({ name, description: '', requiresLlm: false, analyze: async () => ({ report: {} as any, timeline: [] }) }));
         },
         /already registered/,
      );
   });
});

describe('AgentStrategy entity integration', () => {
  const mockCtx = {
    config: {
      enabled: true,
      defaultDepth: 'standard',
      maxDepth: 'deep',
      maxToolCalls: 200,
      maxTokens: 500_000,
      maxTimeMs: 300_000,
      baseUrl: 'http://localhost',
      model: 'test-model',
      workerModel: 'test-model',
      treeBreadth: 4,
      treeDepth: 2,
      treeConcurrency: 2,
      treeContextWordLimit: 25000,
      searchBackend: 'brave',
      agentMaxIterations: 5,
    },
    state: {
      initialize() { /* noop */ },
      setLanguage() { /* noop */ },
      addSource() { return 'source-1'; },
      getFullState() { return {}; },
    },
    budget: {
      recordTokens() { return true; },
      isExhausted() { return false; },
      profile: { maxGapLoops: 0 },
    },
    llm: {} as any,
    abortSignal: undefined,
    onProgress: undefined,
  };

  it('includes domain classification in system prompt when route provided', async () => {
    const { AgentStrategy } = await import('../../src/research/strategies/agentStrategy.js');
    const strategy = new AgentStrategy(mockCtx as any);
    const prompt = (strategy as any).buildSystemPrompt(
      { category: 'technical', confidence: 0.8, primaryBackends: ['github', 'documentation'], secondaryBackends: ['web'], reasoning: 'test' },
      { temporal: [], numerical: [], names: ['Rust'], locations: [], descriptors: ['benchmark'] },
    );
    assert.ok(prompt.includes('Query domain: technical'));
    assert.ok(prompt.includes('github'));
    assert.ok(prompt.includes('Rust'));
  });

  it('falls back to basic system prompt when no route/entities', async () => {
    const { AgentStrategy } = await import('../../src/research/strategies/agentStrategy.js');
    const strategy = new AgentStrategy(mockCtx as any);
    const prompt = (strategy as any).buildSystemPrompt();
    assert.ok(!prompt.includes('Query domain:'));
  });
});
