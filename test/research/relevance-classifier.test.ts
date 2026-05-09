import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreTextRelevance } from '../../src/research/relevanceClassifier.js';

test('scoreTextRelevance rejects tangential source drift that shares only generic legal terms', () => {
  const query = 'Scientology Snow White convictions stipulation of evidence';
  const drift = scoreTextRelevance(
    query,
    'Ohio Public Defender Commission legal stipulations and criminal defense evidence forms',
  );

  assert.equal(drift.admissible, false);
  assert.ok(drift.score < 0.45, `expected low relevance, got ${drift.score}: ${drift.reason}`);
});

test('scoreTextRelevance keeps directly topical sources even when they are legal or institutional', () => {
  const query = 'Scientology IRS settlement legal controversies current litigation';
  const relevant = scoreTextRelevance(
    query,
    'Scientology IRS closing agreement, tax exemption settlement, litigation history, and Church of Scientology legal controversy',
  );

  assert.equal(relevant.admissible, true);
  assert.ok(relevant.score >= 0.65, `expected topical relevance, got ${relevant.score}: ${relevant.reason}`);
});

test('scoreTextRelevance uses short acronym anchors for drift detection', () => {
  const query = 'RPF conditions and Scientology internal labour program';
  const drift = scoreTextRelevance(query, 'Ohio public works rehabilitation funding grants');

  assert.equal(drift.admissible, false);
  assert.ok(drift.reason.includes('Subject anchors matched 0/'));
});
