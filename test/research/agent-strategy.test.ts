/**
 * AgentStrategy tests — ReAct loop, response parsing, fallback behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('AgentResponseParser', () => {
   it('parses ACTION with ARGUMENTS', () => {
      const text = 'THOUGHT: Need to search\nACTION: search_web\nARGUMENTS: {"query": "test", "limit": 5}';
      const actionMatch = text.match(/ACTION:\s*(\S+)/i);
      const argsMatch = text.match(/ARGUMENTS:\s*(\{[\s\S]*?\})/i);
      assert.ok(actionMatch, 'ACTION should be found');
      assert.ok(argsMatch, 'ARGUMENTS should be found');
      assert.strictEqual(actionMatch?.[1], 'search_web');
      if (argsMatch?.[1]) {
         const parsed = JSON.parse(argsMatch[1]);
         assert.strictEqual(parsed.query, 'test');
         assert.strictEqual(parsed.limit, 5);
      }
   });

   it('parses ANSWER', () => {
      const text = 'THOUGHT: Found enough\nANSWER: The answer is 42.';
      const answerMatch = text.match(/ANSWER:\s*([\s\S]*)/i);
      assert.ok(answerMatch, 'ANSWER should be found');
      assert.ok(answerMatch?.[1]?.includes('The answer is 42'));
   });

   it('detects missing ARGUMENTS', () => {
      const text = 'ACTION: search_web';
      const actionMatch = text.match(/ACTION:\s*(\S+)/i);
      const argsMatch = text.match(/ARGUMENTS:\s*(\{[\s\S]*?\})/i);
      assert.ok(actionMatch, 'ACTION should be found');
      assert.strictEqual(argsMatch, null, 'ARGUMENTS should be null without JSON');
   });

   it('handles malformed JSON in ARGUMENTS', () => {
      const text = 'ACTION: search_web\nARGUMENTS: {bad json}';
      const argsMatch = text.match(/ARGUMENTS:\s*(\{[\s\S]*?\})/i);
      assert.ok(argsMatch, 'ARGUMENTS block should be found');
      if (argsMatch?.[1]) {
         assert.throws(() => JSON.parse(argsMatch[1]!));
      }
   });

   it('falls back to error for unparseable input', () => {
      const text = 'Just some random text without any format';
      const actionMatch = text.match(/ACTION:\s*(\S+)/i);
      const answerMatch = text.match(/ANSWER:\s*([\s\S]*)/i);
      assert.strictEqual(actionMatch, null);
      assert.strictEqual(answerMatch, null);
   });

   it('handles multi-line THOUGHT', () => {
      const text = 'THOUGHT: This is a\nmulti-line thought\nspanning several lines\nACTION: search_web\nARGUMENTS: {"query": "test"}';
      const thoughtMatch = text.match(/THOUGHT:\s*([\s\S]*?)(?=\n(?:ACTION|ANSWER|$))/i);
      assert.ok(thoughtMatch, 'THOUGHT should be found');
      assert.ok((thoughtMatch?.[1]?.match(/\n/g)?.length ?? 0) >= 2, 'THOUGHT should contain multiple lines');
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
