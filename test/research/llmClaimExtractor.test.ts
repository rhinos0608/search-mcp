import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmClaimExtractor } from '../../src/research/llmClaimExtractor.js';
import type { DeepResearchLlmClient } from '../../src/research/llm/chat.js';
import type { StructuredClaimResult } from '../../src/research/llm/schemas.js';
import type { ExtractionInput } from '../../src/research/llmClaimExtractor.js';

function makeLlm(claims: StructuredClaimResult[]): DeepResearchLlmClient {
  return {
    async callJSON() {
      return {
        success: true,
        data: { claims },
        response: { success: true, content: '', tokensUsed: 1 },
      };
    },
  } as unknown as DeepResearchLlmClient;
}

function makeInput(): ExtractionInput {
  return {
    query: 'test query',
    sourceId: 'source-1',
    subQuestionIds: ['sq-1'],
    chunks: [
      {
        chunk: { id: 'chunk-0', text: 'alpha beta gamma', sourceId: 'source-1' },
        rrfScore: 0.2,
      },
      {
        chunk: {
          id: 'chunk-1',
          text: 'Model achieved 95% accuracy on the benchmark with strong results.',
          sourceId: 'source-1',
        },
        rrfScore: 0.9,
      },
    ],
  };
}

test('LlmClaimExtractor assigns retrieval score from the matching chunk', async () => {
  const extractor = new LlmClaimExtractor({ useRegexHints: false });
  const llm = makeLlm([
    {
      subject: 'Model',
      predicate: 'achieved',
      object: '95% accuracy',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      sourceSpan: 'Model achieved 95% accuracy on the benchmark with strong results.',
    },
  ]);

  const result = await extractor.extract(llm, makeInput());

  assert.equal(result.rawClaims.length, 1);
  assert.equal(result.findings[0]?.retrievalScore, 0.9);
  assert.equal(result.findings[0]?.retrievalScoreMatched, true);
});

test('LlmClaimExtractor marks retrieval scores as approximate when no chunk matches', async () => {
  const extractor = new LlmClaimExtractor({ useRegexHints: false });
  const llm = makeLlm([
    {
      subject: 'Zephyr',
      predicate: 'quartz',
      object: 'ultraline',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      sourceSpan: 'Zephyr quartz ultraline claim here.',
    },
  ]);

  const result = await extractor.extract(llm, makeInput());

  assert.equal(result.findings[0]?.retrievalScore, 0.2);
  assert.equal(result.findings[0]?.retrievalScoreMatched, false);
});
