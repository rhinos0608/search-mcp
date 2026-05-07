import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryDecomposer } from '../../src/research/decomposer.js';
import type { QueryClassification } from '../../src/research/types.js';

test('QueryDecomposer classification', () => {
   const decomposer = new QueryDecomposer();

   const testCases: { query: string; expected: QueryClassification }[] = [
      { query: 'Compare React and Vue', expected: 'comparative' },
      { query: 'React vs Vue', expected: 'comparative' },
      { query: 'Pros and cons of TypeScript', expected: 'comparative' },
      { query: 'Should I use Angular for my next project?', expected: 'decision-support' },
      { query: 'Which technology is best for a real-time chat app?', expected: 'decision-support' },
      { query: 'How to implement a custom hook in React?', expected: 'technical' },
      { query: 'What is the architecture of Kubernetes?', expected: 'technical' },
      { query: 'Best practices for production Node.js apps', expected: 'applied-practitioner' },
      { query: 'Lessons learned from migrating to microservices', expected: 'applied-practitioner' },
      { query: 'Latest releases in LLM models 2024', expected: 'current-events' },
      { query: 'Recent breakthroughs in fusion energy', expected: 'current-events' },
      { query: 'History of the internet', expected: 'historical-timeline' },
      { query: 'Evolution of web browsers', expected: 'historical-timeline' },
      { query: 'Market share of cloud providers', expected: 'market-ecosystem' },
      { query: 'Industry landscape for electric vehicles', expected: 'market-ecosystem' },
      { query: 'Literature review on quantum computing', expected: 'literature-review' },
      { query: 'State of the art in image recognition', expected: 'literature-review' },
      { query: 'What is a closure in JavaScript?', expected: 'explainer' },
      { query: 'Explain the concept of monads', expected: 'explainer' },
   ];

   for (const { query, expected } of testCases) {
      const result = decomposer.decompose(query);
      assert.strictEqual(result.classification, expected, `Query: "${query}" should be classified as ${expected}`);
   }
});

test('QueryDecomposer topic extraction', () => {
   const decomposer = new QueryDecomposer();

   const testCases: { query: string; expected: string }[] = [
      { query: 'What is React?', expected: 'React' },
      { query: 'Explain the concept of monads', expected: 'the concept of monads' },
      { query: 'How to implement a custom hook in React?', expected: 'implement a custom hook in React' },
      { query: 'Compare React and Vue', expected: 'React and Vue' },
      { query: 'I want to know more about Rust', expected: 'Rust' },
   ];

   for (const { query, expected } of testCases) {
      const result = decomposer.decompose(query);
      assert.strictEqual(result.disambiguatedTopic, expected, `Query: "${query}" should have topic "${expected}"`);
   }
});

test('QueryDecomposer entity extraction', () => {
   const decomposer = new QueryDecomposer();

   const query = 'Tell me about ITER and SpaceX Starship development';
   const result = decomposer.decompose(query);

   const entityNames = result.extractedEntities.map(e => e.name);
   assert.ok(entityNames.includes('ITER'), 'Should extract ITER');
   assert.ok(entityNames.includes('Starship'), 'Should extract Starship');
});

test('QueryDecomposer sub-question generation', () => {
   const decomposer = new QueryDecomposer();

   const query = 'What is fusion energy?';
   const result = decomposer.decompose(query);

   assert.ok(result.subQuestions.length >= 5, 'Should generate at least 5 sub-questions for explainer');
   assert.ok(result.subQuestions.some(sq => sq.text.includes('fusion energy')), 'Sub-questions should contain the topic');
});
