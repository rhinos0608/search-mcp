import { describe, it } from 'node:test';
import assert from 'node:assert';

import { strategyRegistry } from '../../src/research/strategies/index.js';
import { TreeStrategy } from '../../src/research/strategies/treeStrategy.js';
import { PipelineStrategy } from '../../src/research/strategies/pipelineStrategy.js';
import { buildAgentTools } from '../../src/research/strategies/agentTools.js';
import { CitationCollector } from '../../src/research/citationCollector.js';
import type { StrategyContext } from '../../src/research/strategies/types.js';
import type { DeepResearchConfig } from '../../src/config.js';
import type { ResearchResult } from '../../src/research/types.js';

function makeCtx(): StrategyContext {
  const config: Required<DeepResearchConfig> = {
    enabled: true,
    defaultDepth: 'standard',
    maxDepth: 'deep',
    maxToolCalls: 200,
    maxTokens: 500_000,
    maxTimeMs: 300_000,
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model',
    workerModel: 'test-worker',
    apiToken: '',
    treeBreadth: 4,
    treeDepth: 2,
    treeConcurrency: 2,
    treeContextWordLimit: 25_000,
    agentMaxIterations: 30,
    agentMaxSubIterations: 8,
    agentDefaultFetchMode: 'summary_focus_query',
  };

  return {
    state: {} as StrategyContext['state'],
    budget: {} as StrategyContext['budget'],
    llm: {} as StrategyContext['llm'],
    config,
    depth: 'standard',
    onProgress: undefined,
    abortSignal: undefined,
    jobId: undefined,
    deterministic: false,
  };
}

describe('strategy integration', () => {
  it('pre-registers pipeline and tree strategies at module load', () => {
    assert.strictEqual(strategyRegistry.has('pipeline'), true);
    assert.strictEqual(strategyRegistry.has('tree'), true);
  });

  it('tree strategy delegates to the pipeline implementation', async () => {
    const expected: ResearchResult = {
      report: {
        query: 'tree question',
        classification: 'explainer',
        depth: 'tree',
        executiveSummary: 'summary',
        narrativeMarkdown: 'report body',
        themes: [],
        contradictions: [],
        uncertainties: [],
        sourceNotes: [],
        openQuestions: [],
        limitations: [],
        sourceCount: 0,
        findingCount: 0,
        sourceTypeCount: 0,
        sourceDiversity: [],
        evidenceSources: [],
      },
      timeline: [],
    };

    const originalAnalyze = PipelineStrategy.prototype.analyze;
    PipelineStrategy.prototype.analyze = async () => expected;

    try {
      const result = await new TreeStrategy().analyze('tree question', makeCtx());
      assert.deepStrictEqual(result, expected);
    } finally {
      PipelineStrategy.prototype.analyze = originalAnalyze;
    }
  });

  it('builds web search and subtopic tools from runtime config', () => {
    const tools = buildAgentTools(makeCtx(), new CitationCollector());
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes('search_web'));
    assert.ok(names.includes('search_pubmed'));
    assert.ok(names.includes('search_wikipedia'));
    assert.ok(names.includes('research_subtopic'));
  });
});
