import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeQuery,
  hasKeywordMatch,
  type DomainCategory,
  type DomainRoute,
} from '../../src/research/domainRouter.js';
import type { ExtractedEntities } from '../../src/research/entityExtractor.js';
import type { SourceType } from '../../src/research/types.js';

function assertRoute(
  route: DomainRoute,
  expected: {
    category: DomainCategory;
    minConfidence: number;
    primaryBackends: SourceType[];
    secondaryBackends: SourceType[];
  },
) {
  assert.strictEqual(
    route.category,
    expected.category,
    `expected category ${expected.category} but got ${route.category}`,
  );
  assert.ok(
    route.confidence >= expected.minConfidence,
    `expected confidence >= ${expected.minConfidence} but got ${route.confidence}`,
  );
  assert.deepStrictEqual(route.primaryBackends, expected.primaryBackends);
  assert.deepStrictEqual(route.secondaryBackends, expected.secondaryBackends);
}

describe('routeQuery', () => {
  describe('keyword-based classification', () => {
    it('routes medical queries', () => {
      const route = routeQuery('Clinical treatment for diabetes symptoms');
      assertRoute(route, {
        category: 'medical',
        minConfidence: 0.5,
        primaryBackends: ['pubmed', 'academic'],
        secondaryBackends: ['web', 'wikipedia'],
      });
    });

    it('routes scientific queries', () => {
      const route = routeQuery('Research paper on quantum computing hypothesis');
      assertRoute(route, {
        category: 'scientific',
        minConfidence: 0.5,
        primaryBackends: ['academic', 'web'],
        secondaryBackends: ['github', 'wikipedia'],
      });
    });

    it('routes technical queries', () => {
      const route = routeQuery('System architecture for microservices');
      assertRoute(route, {
        category: 'technical',
        minConfidence: 0.4,
        primaryBackends: ['github', 'documentation'],
        secondaryBackends: ['academic', 'web'],
      });
    });

    it('routes current-events queries', () => {
      const route = routeQuery('Breaking news today');
      assertRoute(route, {
        category: 'current-events',
        minConfidence: 0.5,
        primaryBackends: ['news', 'web'],
        secondaryBackends: ['reddit', 'hackernews'],
      });
    });

    it('routes background-knowledge queries', () => {
      const route = routeQuery('What is photosynthesis?');
      assertRoute(route, {
        category: 'background-knowledge',
        minConfidence: 0.4,
        primaryBackends: ['wikipedia', 'web'],
        secondaryBackends: ['academic'],
      });
    });

    it('routes code queries', () => {
      const route = routeQuery('npm package for validation');
      assertRoute(route, {
        category: 'code',
        minConfidence: 0.4,
        primaryBackends: ['github', 'stackoverflow'],
        secondaryBackends: ['documentation', 'web'],
      });
    });

    it('routes community-opinion queries', () => {
      const route = routeQuery('Best laptop for programming');
      assertRoute(route, {
        category: 'community-opinion',
        minConfidence: 0.4,
        primaryBackends: ['reddit', 'hackernews'],
        secondaryBackends: ['youtube', 'web'],
      });
    });

    it('routes comparative queries', () => {
      const route = routeQuery('React vs Vue comparison');
      assertRoute(route, {
        category: 'comparative',
        minConfidence: 0.4,
        primaryBackends: ['web', 'reddit'],
        secondaryBackends: ['academic', 'github'],
      });
    });

    it('routes how-to queries', () => {
      const route = routeQuery('How to install Docker');
      assertRoute(route, {
        category: 'how-to',
        minConfidence: 0.4,
        primaryBackends: ['documentation', 'stackoverflow'],
        secondaryBackends: ['github', 'web'],
      });
    });

    it('falls back to general for unmatched queries', () => {
      const route = routeQuery('The quick brown fox');
      assertRoute(route, {
        category: 'general',
        minConfidence: 0,
        primaryBackends: ['web'],
        secondaryBackends: ['academic', 'wikipedia'],
      });
      assert.strictEqual(route.confidence, 0);
    });
  });

  describe('confidence scoring', () => {
    it('gives higher confidence for multiple keyword matches', () => {
      const route = routeQuery('Clinical trial drug treatment for disease');
      assert.strictEqual(route.category, 'medical');
      assert.ok(route.confidence >= 0.8, `expected >= 0.8, got ${route.confidence}`);
    });

    it('caps confidence at 1.0', () => {
      const route = routeQuery(
        'Clinical trial drug treatment symptom diagnosis therapy vaccine pharma disease condition health medical hospital physician',
      );
      assert.strictEqual(route.category, 'medical');
      assert.ok(route.confidence <= 1.0, `expected <= 1.0, got ${route.confidence}`);
    });

    it('gives partial confidence for single keyword match', () => {
      const route = routeQuery('The treatment options');
      assert.strictEqual(route.category, 'general');
      // "treatment" gives 0.4, which is below the 0.5 threshold, so it falls back to general
      assert.strictEqual(route.confidence, 0);
    });

    it('uses whole-word matching only', () => {
      const route = routeQuery('medically speaking this is unrelated');
      // "medically" should not match "medical"
      assert.strictEqual(route.category, 'general');
      assert.strictEqual(route.confidence, 0);
    });

    it('matches multi-word keywords as substrings', () => {
      const route = routeQuery('A step by step walkthrough');
      assert.strictEqual(route.category, 'how-to');
      assert.ok(
        route.confidence >= 0.4,
        `expected >= 0.4 for "step by step", got ${route.confidence}`,
      );
    });
  });

  describe('prefix matching', () => {
    it('boosts background-knowledge for "what is" prefix', () => {
      const route = routeQuery('What is the capital of France?');
      assert.strictEqual(route.category, 'background-knowledge');
      // keyword match (0.4) + prefix match (0.3) = 0.7
      assert.ok(route.confidence >= 0.7, `expected >= 0.7, got ${route.confidence}`);
    });

    it('boosts how-to for "how to" prefix', () => {
      const route = routeQuery('How to bake sourdough bread');
      assert.strictEqual(route.category, 'how-to');
      // keyword match (0.4) + prefix match (0.3) = 0.7
      assert.ok(route.confidence >= 0.7, `expected >= 0.7, got ${route.confidence}`);
    });

    it('does not boost prefix when keyword appears mid-query', () => {
      const withPrefix = routeQuery('What is the definition of gravity');
      const withoutPrefix = routeQuery('Tell me what is the definition of gravity');
      // Both have keyword matches: "what is" (0.4) + "definition" (0.4) = 0.8
      // withPrefix also gets prefix boost for "what is" (+0.3) = 1.1 capped at 1.0
      assert.strictEqual(withPrefix.category, 'background-knowledge');
      assert.strictEqual(withoutPrefix.category, 'background-knowledge');
      assert.ok(
        withPrefix.confidence > withoutPrefix.confidence,
        `expected prefix-boosted confidence (${withPrefix.confidence}) to be higher than non-boosted (${withoutPrefix.confidence})`,
      );
    });
  });

  describe('hasKeywordMatch', () => {
    it('escapes regex metacharacters in single-word keywords', () => {
      // Without escaping, 'test.api' would be interpreted as 'test<any char>api'
      // With escaping, it should match literally
      assert.ok(hasKeywordMatch('use test.api now', 'test.api'));
      assert.ok(!hasKeywordMatch('use testXapi now', 'test.api'));

      // Keywords with quantifier metacharacters should not throw
      assert.doesNotThrow(() => hasKeywordMatch('learn c++', 'c++'));
      assert.doesNotThrow(() => hasKeywordMatch('use .net', '.net'));
    });
  });

  describe('entity-influenced routing', () => {
    it('boosts current-events when temporal entities are present', () => {
      const entities: ExtractedEntities = {
        temporal: ['2024'],
        numerical: [],
        names: [],
        locations: [],
        descriptors: [],
      };
      const routeWithBoost = routeQuery('Tech news today', entities);
      const routeWithoutBoost = routeQuery('Tech news today');
      // keyword matches: "news" (0.4) + "today" (0.4) = 0.8
      // temporal boost (+0.2) = 1.0 capped
      assert.strictEqual(routeWithBoost.category, 'current-events');
      assert.strictEqual(routeWithoutBoost.category, 'current-events');
      assert.ok(
        routeWithBoost.confidence > routeWithoutBoost.confidence,
        `expected boosted confidence (${routeWithBoost.confidence}) to be higher than non-boosted (${routeWithoutBoost.confidence})`,
      );
      assert.strictEqual(routeWithBoost.confidence, 1.0);
      assert.strictEqual(routeWithoutBoost.confidence, 0.8);
    });

    it('does not boost current-events without temporal entities', () => {
      const route = routeQuery('Tech news today');
      // "news" (0.4) + "today" (0.4) = 0.8, no prefix matches
      assert.strictEqual(route.category, 'current-events');
      assert.ok(route.confidence >= 0.5);
      assert.ok(
        route.confidence < 1.0,
        `expected < 1.0 without temporal boost, got ${route.confidence}`,
      );
    });

    it('falls back to general when only temporal entities are present', () => {
      const entities: ExtractedEntities = {
        temporal: ['2024'],
        numerical: [],
        names: [],
        locations: [],
        descriptors: [],
      };
      const route = routeQuery('Something happened', entities);
      assert.strictEqual(route.category, 'general');
      assert.strictEqual(route.confidence, 0);
    });

    it('boosts technical when named entities are present', () => {
      const entities: ExtractedEntities = {
        temporal: [],
        numerical: [],
        names: ['React'],
        locations: [],
        descriptors: [],
      };
      const routeWithBoost = routeQuery('React architecture', entities);
      const routeWithoutBoost = routeQuery('React architecture');
      // "architecture" matches technical (0.4), below threshold without boost
      // named entity boost (+0.2) pushes it to 0.6, routing to technical
      assert.strictEqual(routeWithBoost.category, 'technical');
      assert.strictEqual(routeWithoutBoost.category, 'general');
      assert.ok(
        routeWithBoost.confidence > routeWithoutBoost.confidence,
        `expected boosted confidence (${routeWithBoost.confidence}) to be higher than non-boosted (${routeWithoutBoost.confidence})`,
      );
    });

    it('boosts code when named entities are present', () => {
      const entities: ExtractedEntities = {
        temporal: [],
        numerical: [],
        names: ['Express'],
        locations: [],
        descriptors: [],
      };
      const routeWithBoost = routeQuery('Express sdk', entities);
      const routeWithoutBoost = routeQuery('Express sdk');
      // "sdk" matches code (0.4), below threshold without boost
      // named entity boost (+0.2) pushes it to 0.6, routing to code
      assert.strictEqual(routeWithBoost.category, 'code');
      assert.strictEqual(routeWithoutBoost.category, 'general');
      assert.ok(
        routeWithBoost.confidence > routeWithoutBoost.confidence,
        `expected boosted confidence (${routeWithBoost.confidence}) to be higher than non-boosted (${routeWithoutBoost.confidence})`,
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty query', () => {
      const route = routeQuery('');
      assert.strictEqual(route.category, 'general');
      assert.strictEqual(route.confidence, 0);
    });

    it('handles very short query with no keywords', () => {
      const route = routeQuery('a');
      assert.strictEqual(route.category, 'general');
      assert.strictEqual(route.confidence, 0);
    });

    it('handles ambiguous query with multiple domain keywords', () => {
      // "vs" appears in both community-opinion and comparative
      // "review" is community-opinion, "compare" is comparative
      const route = routeQuery('Compare and review');
      // comparative has "compare" (0.4), community-opinion has "review" (0.4)
      // whichever wins depends on ordering, but confidence should be >= 0.4
      assert.ok(route.confidence >= 0.4);
    });

    it('is case insensitive', () => {
      const route = routeQuery('FDA Approval For New Drug');
      assert.strictEqual(route.category, 'medical');
      assert.ok(route.confidence >= 0.4);
    });

    it('ignores punctuation around keywords', () => {
      const route = routeQuery('treatment, symptom; diagnosis.');
      assert.strictEqual(route.category, 'medical');
      assert.ok(route.confidence >= 0.8);
    });

    it('returns reasoning string', () => {
      const route = routeQuery('How to install Node.js');
      assert.strictEqual(typeof route.reasoning, 'string');
      assert.ok(route.reasoning.length > 0);
    });

    it('falls back to general when confidence is below 0.5', () => {
      // "happening" gives 0.4 to current-events, which is below 0.5 threshold
      const route = routeQuery('Something is happening');
      assert.strictEqual(route.category, 'general');
      assert.strictEqual(route.confidence, 0);
    });
  });
});
