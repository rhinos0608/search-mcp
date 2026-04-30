import test from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, type QueryVariation } from '../src/tools/queryExpansion.js';

test('expandQuery returns at least the original query', () => {
  const result = expandQuery('machine learning performance optimization');
  assert.ok(result.length >= 1);
  assert.equal(result[0]?.query, 'machine learning performance optimization');
  assert.equal(result[0]?.strategy, 'original');
});

test('expandQuery concept expansion for known terms', () => {
  const result = expandQuery('database performance');
  const concept = result.find((v: QueryVariation) => v.strategy === 'concept');
  assert.ok(concept !== undefined, 'concept expansion should exist for "database"');
  assert.equal(concept?.query, 'sql nosql');
});

test('expandQuery question form generation', () => {
  const result = expandQuery('kubernetes autoscaling');
  const question = result.find((v: QueryVariation) => v.strategy === 'question');
  assert.ok(question !== undefined, 'question form should exist');
  assert.equal(question?.query, 'What is kubernetes autoscaling?');
});

test('expandQuery scope variation for opposition terms', () => {
  const result = expandQuery('advantages of microservices');
  const scope = result.find((v: QueryVariation) => v.strategy === 'scope');
  assert.ok(scope !== undefined, 'scope variation should exist');
  assert.equal(scope?.query, 'disadvantages of microservices');
});

test('expandQuery handles empty query', () => {
  const result = expandQuery('');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.query, '');
});

test('expandQuery handles single word', () => {
  const result = expandQuery('cloud');
  assert.ok(result.length >= 1);
  assert.equal(result[0]?.query, 'cloud');
  // 'cloud' is in CONCEPT_MAP
  const concept = result.find((v: QueryVariation) => v.strategy === 'concept');
  assert.ok(concept !== undefined);
});

test('expandQuery handles already-question form', () => {
  const result = expandQuery('How to deploy a Docker container');
  const question = result.find((v: QueryVariation) => v.strategy === 'question');
  assert.equal(question, undefined);
});

test('expandQuery handles long query with scope narrowing', () => {
  const result = expandQuery('best practices for distributed database replication caching');
  const scope = result.find((v: QueryVariation) => v.strategy === 'scope');
  assert.ok(scope !== undefined, 'scope should narrow long query');
  // The scope strategy first checks opposition pairs (best -> worst), then
  // falls back to keyword narrowing for long queries
  assert.ok(
    scope?.query.includes('worst') || scope?.query.length < 42,
    `unexpected scope result: ${scope?.query}`,
  );
});
