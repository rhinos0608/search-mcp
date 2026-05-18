import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEntities,
  expandTemporalRanges,
  generateEntityBasedQueries,
  type ExtractedEntities,
} from '../../src/research/entityExtractor.js';

describe('extractEntities', () => {
  describe('temporal', () => {
    it('extracts single years', () => {
      const result = extractEntities('What happened in 2024?');
      assert.deepStrictEqual(result.temporal, ['2024']);
    });

    it('extracts year ranges with hyphen', () => {
      const result = extractEntities('Trends from 2018-2023');
      assert.deepStrictEqual(result.temporal, ['2018-2023']);
    });

    it('extracts year ranges with en-dash', () => {
      const result = extractEntities('Trends from 2018–2023');
      assert.deepStrictEqual(result.temporal, ['2018–2023']);
    });

    it('extracts year ranges with "to"', () => {
      const result = extractEntities('Trends from 2018 to 2023');
      assert.deepStrictEqual(result.temporal, ['2018 to 2023']);
    });

    it('extracts multiple years', () => {
      const result = extractEntities('Compare 2019, 2020, and 2021');
      assert.deepStrictEqual(result.temporal, ['2019', '2020', '2021']);
    });

    it('does not extract invalid years', () => {
      const result = extractEntities('The number 1899 or 2100');
      assert.deepStrictEqual(result.temporal, []);
    });
  });

  describe('numerical', () => {
    it('extracts percentages', () => {
      const result = extractEntities('Success rate is 84.5%');
      assert.deepStrictEqual(result.numerical, ['84.5%']);
    });

    it('extracts time units', () => {
      const result = extractEntities('Latency of 300ms');
      assert.deepStrictEqual(result.numerical, ['300ms']);
    });

    it('extracts data size units', () => {
      const result = extractEntities('File size is 512MB');
      assert.deepStrictEqual(result.numerical, ['512MB']);
    });

    it('extracts speed units', () => {
      const result = extractEntities('Speed limit 65mph or 100 km/h');
      assert.deepStrictEqual(result.numerical, ['65mph', '100 km/h']);
    });

    it('extracts scale words', () => {
      const result = extractEntities('Revenue of 5 million and 2 billion');
      assert.deepStrictEqual(result.numerical, ['5 million', '2 billion']);
    });

    it('extracts plain counts with units', () => {
      const result = extractEntities('512KB and 1TB');
      assert.deepStrictEqual(result.numerical, ['512KB', '1TB']);
    });

    it('does not extract plain numbers without units', () => {
      const result = extractEntities('There are 42 apples');
      assert.deepStrictEqual(result.numerical, []);
    });
  });

  describe('names', () => {
    it('extracts proper nouns', () => {
      const result = extractEntities('Google released a new product');
      assert.ok(result.names.includes('Google'), 'Should include Google');
    });

    it('extracts multi-word names', () => {
      const result = extractEntities('Dartmouth College is in New Hampshire');
      assert.ok(result.names.includes('Dartmouth College'), 'Should include Dartmouth College');
    });

    it('extracts acronyms', () => {
      const result = extractEntities('NASA and FBI work together');
      assert.ok(result.names.includes('NASA'), 'Should include NASA');
      assert.ok(result.names.includes('FBI'), 'Should include FBI');
    });

    it('extracts single capitalized word after first word', () => {
      const result = extractEntities('I visited Paris last summer');
      assert.ok(result.names.includes('Paris'), 'Should include Paris');
    });

    it('does not extract sentence-starting capitalized words as names', () => {
      const result = extractEntities('The quick brown fox');
      assert.ok(!result.names.includes('The'), 'Should not include sentence-start The');
    });

    it('extracts mixed names and acronyms', () => {
      const result = extractEntities('OpenAI and IBM partnered with Microsoft');
      assert.ok(result.names.includes('OpenAI'), 'Should include OpenAI');
      assert.ok(result.names.includes('IBM'), 'Should include IBM');
      assert.ok(result.names.includes('Microsoft'), 'Should include Microsoft');
    });
  });

  describe('locations', () => {
    it('extracts locations after prepositions', () => {
      const result = extractEntities('I live in Pennsylvania');
      assert.ok(result.locations.includes('Pennsylvania'), 'Should include Pennsylvania');
    });

    it('extracts locations with "the"', () => {
      const result = extractEntities('Hiking at the Grand Canyon');
      assert.ok(result.locations.includes('Grand Canyon'), 'Should include Grand Canyon');
    });

    it('extracts cities', () => {
      const result = extractEntities('Flight to Paris');
      assert.ok(result.locations.includes('Paris'), 'Should include Paris');
    });

    it('extracts countries', () => {
      const result = extractEntities('Born in Germany');
      assert.ok(result.locations.includes('Germany'), 'Should include Germany');
    });

    it('extracts multi-word locations', () => {
      const result = extractEntities('Conference in San Francisco');
      assert.ok(result.locations.includes('San Francisco'), 'Should include San Francisco');
    });
  });

  describe('descriptors', () => {
    it('extracts content words after stopword removal', () => {
      const result = extractEntities('The quick scheduler handles latency');
      assert.ok(result.descriptors.includes('scheduler'), 'Should include scheduler');
      assert.ok(result.descriptors.includes('latency'), 'Should include latency');
    });

    it('does not include stop words', () => {
      const result = extractEntities('The and of a in');
      assert.deepStrictEqual(result.descriptors, []);
    });

    it('extracts multi-word descriptors', () => {
      const result = extractEntities('High performance computing system');
      assert.ok(result.descriptors.includes('performance'), 'Should include performance');
      assert.ok(result.descriptors.includes('computing'), 'Should include computing');
      assert.ok(result.descriptors.includes('system'), 'Should include system');
    });

    it('filters out short non-descriptor words', () => {
      const result = extractEntities('A cat sat');
      // 'cat' and 'sat' might be filtered depending on stopword list; just ensure no stopwords
      assert.ok(!result.descriptors.includes('A'), 'Should not include A');
      assert.ok(!result.descriptors.includes('a'), 'Should not include a');
    });
  });

  describe('combined', () => {
    it('extracts all entity types from a complex query', () => {
      const query = 'In 2024, Google in California achieved 95% latency reduction';
      const result = extractEntities(query);
      assert.ok(result.temporal.includes('2024'), 'Should include temporal');
      assert.ok(result.numerical.includes('95%'), 'Should include numerical');
      assert.ok(result.names.includes('Google'), 'Should include names');
      assert.ok(result.locations.includes('California'), 'Should include locations');
      assert.ok(result.descriptors.includes('latency'), 'Should include descriptors');
    });
  });
});

describe('expandTemporalRanges', () => {
  it('expands a hyphen year range into individual years', () => {
    const result = expandTemporalRanges(['2018-2023']);
    assert.deepStrictEqual(result, ['2018', '2019', '2020', '2021', '2022', '2023']);
  });

  it('expands an en-dash year range', () => {
    const result = expandTemporalRanges(['2018–2020']);
    assert.deepStrictEqual(result, ['2018', '2019', '2020']);
  });

  it('expands a "to" year range', () => {
    const result = expandTemporalRanges(['2018 to 2020']);
    assert.deepStrictEqual(result, ['2018', '2019', '2020']);
  });

  it('passes through single years unchanged', () => {
    const result = expandTemporalRanges(['2024']);
    assert.deepStrictEqual(result, ['2024']);
  });

  it('handles mixed inputs', () => {
    const result = expandTemporalRanges(['2022', '2018-2020']);
    assert.deepStrictEqual(result, ['2022', '2018', '2019', '2020']);
  });

  it('returns empty array for empty input', () => {
    const result = expandTemporalRanges([]);
    assert.deepStrictEqual(result, []);
  });
});

describe('generateEntityBasedQueries', () => {
  it('generates queries from entities', () => {
    const entities: ExtractedEntities = {
      temporal: ['2024'],
      numerical: ['95%'],
      names: ['Google'],
      locations: ['California'],
      descriptors: ['latency'],
    };
    const queries = generateEntityBasedQueries(entities);
    assert.ok(queries.length > 0, 'Should generate at least one query');
    assert.ok(queries.some((q: string) => q.includes('Google')), 'Should include name query');
    assert.ok(queries.some((q: string) => q.includes('2024')), 'Should include temporal query');
  });

  it('deduplicates generated queries', () => {
    const entities: ExtractedEntities = {
      temporal: ['2024'],
      numerical: [],
      names: ['Google'],
      locations: [],
      descriptors: ['Google'], // duplicate with names
    };
    const queries = generateEntityBasedQueries(entities);
    const googleCount = queries.filter((q: string) => q === 'Google').length;
    assert.strictEqual(googleCount, 1, 'Should deduplicate Google');
  });

  it('respects maxQueries cap', () => {
    const entities: ExtractedEntities = {
      temporal: ['2020', '2021', '2022'],
      numerical: ['10%', '20%'],
      names: ['A', 'B', 'C'],
      locations: ['X', 'Y'],
      descriptors: ['fast', 'slow'],
    };
    const queries = generateEntityBasedQueries(entities, 5);
    assert.strictEqual(queries.length, 5, 'Should cap at maxQueries');
  });

  it('includes original query when provided', () => {
    const entities: ExtractedEntities = {
      temporal: [],
      numerical: [],
      names: ['Google'],
      locations: [],
      descriptors: [],
    };
    const original = 'What is Google?';
    const queries = generateEntityBasedQueries(entities, 10, original);
    assert.ok(queries.includes(original), 'Should include original query');
  });

  it('prefers richer queries when capping', () => {
    const entities: ExtractedEntities = {
      temporal: ['2024'],
      numerical: [],
      names: ['Google'],
      locations: [],
      descriptors: ['search'],
    };
    const queries = generateEntityBasedQueries(entities, 2);
    assert.strictEqual(queries.length, 2);
    // Should prefer combined query over single-entity ones
    assert.ok(queries[0]?.includes('Google') || queries[0]?.includes('2024'));
  });

  it('returns original query only when no entities', () => {
    const entities: ExtractedEntities = {
      temporal: [],
      numerical: [],
      names: [],
      locations: [],
      descriptors: [],
    };
    const queries = generateEntityBasedQueries(entities, 10, 'What is this?');
    assert.deepStrictEqual(queries, ['What is this?']);
  });

  it('returns empty array when no entities and no original query', () => {
    const entities: ExtractedEntities = {
      temporal: [],
      numerical: [],
      names: [],
      locations: [],
      descriptors: [],
    };
    const queries = generateEntityBasedQueries(entities);
    assert.deepStrictEqual(queries, []);
  });
});
