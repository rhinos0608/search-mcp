/**
 * answerFindings tests — atomic findings from a ReAct agent's cited answer.
 *
 * Regression: the old extractor sentence-split the whole narrative and emitted
 * every [N]-bearing fragment as a finding, so reference-list lines
 * ("[1] Title — https://…") leaked in as bracket fragments. These tests pin the
 * fixed behavior: references are dropped, citation markers are stripped, and only
 * substantive, source-grounded claims survive.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCitationMarkers,
  extractFindingsFromAnswerRuleBased,
  stripReferencesSection,
} from '../../src/research/strategies/answerFindings.js';

const sourceMap = new Map<number, string>([
  [1, 'src-a'],
  [2, 'src-b'],
  [3, 'src-c'],
]);

describe('stripReferencesSection', () => {
  it('drops a trailing Sources list', () => {
    const answer = [
      'The model uses a transformer architecture [1].',
      '',
      'Sources:',
      '[1] Attention Is All You Need — https://arxiv.org/abs/1706.03762',
      '[2] Some Blog — https://example.com/post',
    ].join('\n');
    const body = stripReferencesSection(answer);
    assert.ok(body.includes('transformer architecture'));
    assert.ok(!body.includes('arxiv.org'));
    assert.ok(!body.includes('example.com'));
  });

  it('handles a markdown References heading', () => {
    const answer = 'Claim one [1].\n\n## References\n[1] Title — https://example.com';
    const body = stripReferencesSection(answer);
    assert.ok(!body.includes('example.com'));
  });

  it('returns the answer unchanged when there is no references section', () => {
    const answer = 'A single claim with a citation [1].';
    assert.strictEqual(stripReferencesSection(answer), answer);
  });
});

describe('cleanCitationMarkers', () => {
  it('removes inline [N] markers and tidies punctuation', () => {
    assert.strictEqual(
      cleanCitationMarkers('The system scales linearly [1][2] under load [3].'),
      'The system scales linearly under load.',
    );
  });
});

describe('extractFindingsFromAnswerRuleBased', () => {
  it('does not emit reference-list bracket fragments as findings', () => {
    const answer = [
      'Retrieval-augmented generation reduces hallucination by grounding answers in retrieved context [1].',
      'Hybrid search combining BM25 and dense vectors outperforms either alone [2].',
      '',
      'Sources:',
      '[1] RAG Survey — https://arxiv.org/abs/2312.10997',
      '[2] Hybrid Search — https://example.com/hybrid',
    ].join('\n');

    const findings = extractFindingsFromAnswerRuleBased({
      answer,
      sourceMap,
      subQuestionIds: ['sq-1'],
    });

    assert.strictEqual(findings.length, 2);
    for (const f of findings) {
      assert.ok(!/^\[\d+\]/.test(f.claim), `claim should not be a bracket fragment: ${f.claim}`);
      assert.ok(!/https?:\/\//.test(f.claim), `claim should not be a URL: ${f.claim}`);
      assert.ok(!/\[\d+\]/.test(f.claim), `claim should have no citation markers: ${f.claim}`);
    }
    assert.deepStrictEqual(findings[0]?.sourceIds, ['src-a']);
    assert.deepStrictEqual(findings[1]?.sourceIds, ['src-b']);
  });

  it('skips sentences without resolvable citations', () => {
    const answer =
      'This sentence has a citation that maps to nothing [9]. This one is grounded properly [1].';
    const findings = extractFindingsFromAnswerRuleBased({
      answer,
      sourceMap,
      subQuestionIds: [],
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0]?.sourceIds, ['src-a']);
  });

  it('dedupes repeated claims and merges multiple citations on one sentence', () => {
    const answer =
      'Vector databases enable semantic retrieval at scale [1][2]. Vector databases enable semantic retrieval at scale [1].';
    const findings = extractFindingsFromAnswerRuleBased({
      answer,
      sourceMap,
      subQuestionIds: [],
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0]?.sourceIds, ['src-a', 'src-b']);
  });

  it('drops fragments that are too short to be real claims', () => {
    const answer = 'Yes [1]. The retrieval pipeline reranks candidates with a cross-encoder [2].';
    const findings = extractFindingsFromAnswerRuleBased({
      answer,
      sourceMap,
      subQuestionIds: [],
    });
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0]?.claim.includes('cross-encoder'));
  });
});
