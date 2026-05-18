import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKnowledgeGraphLlmResponse } from '../src/knowledge/extractor/index.js';
import { validateExtraction } from '../src/knowledge/extractor/schemas.js';

test('knowledge graph parser accepts deep-research structured claims output', () => {
  const sourceText = [
    'In our tests, the new scheduler reduced p99 latency from 45ms to 30ms, a 33% improvement.',
    'Transformer attention mechanisms scale quadratically with sequence length, making them expensive for long contexts.',
  ].join(' ');

  const parsed = parseKnowledgeGraphLlmResponse(`Here is the extraction:\n\n\`\`\`json
{
  "claims": [
    {
      "subject": "the new scheduler",
      "predicate": "reduced p99 latency",
      "object": "from 45ms to 30ms",
      "polarity": "asserted",
      "hedge": "certain",
      "evidenceType": "benchmark",
      "sourceSpan": "In our tests, the new scheduler reduced p99 latency from 45ms to 30ms, a 33% improvement."
    },
    {
      "subject": "Transformer attention mechanisms",
      "predicate": "scale quadratically with sequence length",
      "polarity": "asserted",
      "hedge": "certain",
      "evidenceType": "claim",
      "sourceSpan": "Transformer attention mechanisms scale quadratically with sequence length, making them expensive for long contexts."
    }
  ]
}
\`\`\``);

  const validation = validateExtraction(parsed, sourceText);

  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.equal(validation.result?.entities.filter((entity) => entity.type === 'claim').length, 2);
  assert.ok(validation.result?.entities.some((entity) => entity.label === 'the new scheduler'));
  assert.ok(
    validation.result?.relationships.some((relationship) => relationship.type === 'supports'),
  );
});

test('knowledge graph parser turns plain text findings into claim entities', () => {
  const sourceText = [
    'Alpha uses vector embeddings to rank documents.',
    'Beta achieved 42% recall improvement in benchmark tests.',
  ].join(' ');

  const parsed = parseKnowledgeGraphLlmResponse(
    `Findings:\n- Alpha uses vector embeddings to rank documents.\n- Beta achieved 42% recall improvement in benchmark tests.`,
  );
  const validation = validateExtraction(parsed, sourceText);

  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.equal(validation.result?.entities.length, 2);
  assert.deepEqual(validation.result?.relationships, []);
  assert.ok(validation.result?.entities.every((entity) => entity.type === 'claim'));
  assert.ok(validation.result?.entities.every((entity) => entity.evidence_verbatim));
});
