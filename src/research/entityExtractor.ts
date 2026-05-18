export interface ExtractedEntities {
  temporal: string[];
  numerical: string[];
  names: string[];
  locations: string[];
  descriptors: string[];
}

const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  "aren't",
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  "can't",
  'cannot',
  'could',
  "couldn't",
  'did',
  "didn't",
  'do',
  'does',
  "doesn't",
  'doing',
  "don't",
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  "hadn't",
  'has',
  "hasn't",
  'have',
  "haven't",
  'having',
  'he',
  "he'd",
  "he'll",
  "he's",
  'her',
  'here',
  "here's",
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  "how's",
  'i',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'if',
  'in',
  'into',
  'is',
  "isn't",
  'it',
  "it's",
  'its',
  'itself',
  'let',
  "let's",
  'me',
  'more',
  'most',
  "mustn't",
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  "shan't",
  'she',
  "she'd",
  "she'll",
  "she's",
  'should',
  "shouldn't",
  'so',
  'some',
  'such',
  'than',
  'that',
  "that's",
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  "there's",
  'these',
  'they',
  "they'd",
  "they'll",
  "they're",
  "they've",
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  "wasn't",
  'we',
  "we'd",
  "we'll",
  "we're",
  "we've",
  'were',
  "weren't",
  'what',
  "what's",
  'when',
  "when's",
  'where',
  "where's",
  'which',
  'while',
  'who',
  "who's",
  'whom',
  'why',
  "why's",
  'with',
  "won't",
  'would',
  "wouldn't",
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
  'yours',
  'yourself',
  'yourselves',
  'can',
  'will',
  'just',
  'now',
]);

const TEMPORAL_PATTERN = /\b((?:19|20)\d{2}(?:\s*(?:-|–|to)\s*(?:19|20)\d{2})?)\b/g;

const NUMERICAL_ATTACHED_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:km\/h|km|mph|ms|MB|KB|GB|TB|%)(?!\w)/g;

const NUMERICAL_SCALE_PATTERN =
  /\b\d+(?:\.\d+)?\s+(?:million|billion|thousand)\b/g;

function extractNames(query: string): string[] {
  const names = new Set<string>();

  // Acronyms anywhere
  for (const match of query.matchAll(/\b[A-Z]{2,}\b/g)) {
    names.add(match[0]);
  }

  // Determine sentence-start token positions
  const sentenceStartPositions = new Set<number>();
  const firstToken = query.match(/[A-Za-z]+/);
  if (firstToken?.index !== undefined) {
    sentenceStartPositions.add(firstToken.index);
  }
  for (const m of query.matchAll(/[.!?]\s+/g)) {
    if (m.index !== undefined) {
      const rest = query.slice(m.index + m[0].length);
      const nextToken = rest.match(/[A-Za-z]+/);
      if (nextToken?.index !== undefined) {
        sentenceStartPositions.add(m.index + m[0].length + nextToken.index);
      }
    }
  }

  // Single capitalized words anywhere, filtering out stop words and sentence starts.
  for (const match of query.matchAll(/\b[A-Z][a-zA-Z]*\b/g)) {
    const word = match[0];
    if (match.index !== undefined && sentenceStartPositions.has(match.index)) {
      continue;
    }
    if (!STOP_WORDS.has(word.toLowerCase()) && word.length >= 2) {
      names.add(word);
    }
  }

  // Multi-word capitalized sequences of 2-4 words anywhere.
  const tokens = Array.from(query.matchAll(/[A-Za-z]+/g)).map((m) => m[0]);
  for (let start = 0; start < tokens.length; start++) {
    const firstToken = tokens[start];
    if (!firstToken || !/^[A-Z][a-zA-Z]*$/.test(firstToken)) continue;
    if (STOP_WORDS.has(firstToken.toLowerCase())) continue;

    for (let len = 2; len <= 4 && start + len <= tokens.length; len++) {
      const slice = tokens.slice(start, start + len);
      if (slice.length !== len) continue;
      if (
        slice.every(
          (w) =>
            /^[A-Z][a-zA-Z]*$/.test(w) && !STOP_WORDS.has(w.toLowerCase()),
        )
      ) {
        names.add(slice.join(' '));
      }
    }
  }

  return Array.from(names);
}

function extractLocations(query: string): string[] {
  const locations = new Set<string>();
  const pattern =
    /\b(?:in|at|on|near|from|to|of|by|within|around)\s+(?:the\s+)?((?:[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2}))\b/g;

  for (const match of query.matchAll(pattern)) {
    const candidate = match[1] ?? '';
    if (!candidate) continue;
    const words = candidate.split(/\s+/);
    const filtered = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
    if (filtered.length > 0 && !words.every((w) => /^[A-Z]+$/.test(w))) {
      locations.add(filtered.join(' '));
    }
  }

  return Array.from(locations);
}

function extractDescriptors(query: string): string[] {
  const descriptors = new Set<string>();
  const tokens = query.matchAll(/\b[a-z]+\b/g);
  for (const match of tokens) {
    const word = match[0];
    if (!STOP_WORDS.has(word) && word.length >= 2) {
      descriptors.add(word);
    }
  }
  return Array.from(descriptors);
}

/**
 * Extract entities (temporal, numerical, names, locations, descriptors)
 * from a natural-language query string.
 *
 * @param query - The input query to analyze.
 * @returns An object containing arrays of extracted entity strings.
 */
export function extractEntities(query: string): ExtractedEntities {
  const temporal = new Set<string>();
  for (const match of query.matchAll(TEMPORAL_PATTERN)) {
    const value = match[1];
    if (value) {
      temporal.add(value);
    }
  }

  const numerical = new Set<string>();
  for (const match of query.matchAll(NUMERICAL_ATTACHED_PATTERN)) {
    numerical.add(match[0]);
  }
  for (const match of query.matchAll(NUMERICAL_SCALE_PATTERN)) {
    numerical.add(match[0]);
  }

  const names = extractNames(query);
  const locations = extractLocations(query);
  const descriptors = extractDescriptors(query);

  return {
    temporal: Array.from(temporal),
    numerical: Array.from(numerical),
    names,
    locations,
    descriptors,
  };
}

/**
 * Expand year-range entities into individual years.
 *
 * Reversed ranges are normalized, and ranges spanning more than 20 years
 * are left unchanged.
 *
 * @param entities - Array of temporal entity strings.
 * @returns Array with ranges expanded to individual years, capped at 20 years.
 */
export function expandTemporalRanges(entities: string[]): string[] {
  const result: string[] = [];
  for (const entity of entities) {
    const rangeMatch = entity.match(/^(\d{4})\s*(?:-|–|to)\s*(\d{4})$/);
    if (rangeMatch) {
      let start = parseInt(rangeMatch[1] ?? '0', 10);
      let end = parseInt(rangeMatch[2] ?? '0', 10);
      if (start > end) {
        [start, end] = [end, start];
      }
      if (end - start <= 20) {
        for (let year = start; year <= end; year++) {
          result.push(String(year));
        }
      } else {
        result.push(entity);
      }
    } else {
      result.push(entity);
    }
  }
  return result;
}

/**
 * Generate search queries from extracted entities.
 *
 * Priority order:
 * 1. Original query (if provided) — placed first so it is never sliced off.
 * 2. Name + descriptor combinations.
 * 3. Name + temporal combinations.
 * 4. Descriptor-only combinations for disambiguation.
 * 5. Individual entities as fallback.
 *
 * @param entities - The extracted entities.
 * @param maxQueries - Maximum number of queries to return (default 5).
 * @param originalQuery - Optional original query to include first.
 * @returns Array of generated query strings, deduplicated and capped.
 */
export function generateEntityBasedQueries(
  entities: ExtractedEntities,
  maxQueries = 5,
  originalQuery?: string,
): string[] {
  const queries: string[] = [];

  // 1. Always include original query first so it doesn't get sliced off
  if (originalQuery) {
    queries.push(originalQuery);
  }

  // 2. Name + descriptor combinations
  for (const name of entities.names) {
    for (const desc of entities.descriptors) {
      queries.push(`${name} ${desc}`);
    }
  }

  // 3. Name + temporal combinations
  for (const name of entities.names) {
    for (const temp of entities.temporal) {
      queries.push(`${name} ${temp}`);
    }
  }

  // 4. Descriptor-only for disambiguation (descriptor + temporal / numerical)
  for (const desc of entities.descriptors) {
    for (const temp of entities.temporal) {
      queries.push(`${desc} ${temp}`);
    }
    for (const num of entities.numerical) {
      queries.push(`${desc} ${num}`);
    }
  }

  // Fallback: individual entities
  for (const name of entities.names) {
    queries.push(name);
  }
  for (const desc of entities.descriptors) {
    queries.push(desc);
  }
  for (const temp of entities.temporal) {
    queries.push(temp);
  }
  for (const num of entities.numerical) {
    queries.push(num);
  }
  for (const loc of entities.locations) {
    queries.push(loc);
  }

  const deduped = [...new Set(queries)];
  return deduped.slice(0, maxQueries);
}
