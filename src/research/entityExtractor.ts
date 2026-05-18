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

  // Single capitalized words anywhere, filtering out stop words.
  for (const match of query.matchAll(/\b[A-Z][a-zA-Z]*\b/g)) {
    const word = match[0];
    if (!STOP_WORDS.has(word.toLowerCase()) && word.length >= 2) {
      names.add(word);
    }
  }

  // Multi-word capitalized sequences of 2-4 words anywhere.
  const tokens = Array.from(query.matchAll(/[A-Za-z]+/g)).map((m) => m[0]);
  for (let start = 0; start < tokens.length; start++) {
    if (!/^[A-Z][a-zA-Z]*$/.test(tokens[start]!)) continue;

    for (let len = 2; len <= 4 && start + len <= tokens.length; len++) {
      const slice = tokens.slice(start, start + len);
      if (slice.every((w) => /^[A-Z][a-zA-Z]*$/.test(w))) {
        names.add(slice.join(' '));
      }
    }
  }

  return Array.from(names);
}

function extractLocations(query: string): string[] {
  const locations = new Set<string>();
  // Preposition + optional "the" + capitalized word(s)
  const pattern =
    /\b(?:in|at|on|near|from|to|of|by|within|around)\s+(?:the\s+)?((?:[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2}))\b/g;

  for (const match of query.matchAll(pattern)) {
    const candidate = match[1]!;
    // Exclude acronyms and all-caps, and stop words
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
  const tokens = query.matchAll(/[a-zA-Z]+/g);
  for (const match of tokens) {
    const word = match[0].toLowerCase();
    if (!STOP_WORDS.has(word) && word.length >= 2) {
      descriptors.add(word);
    }
  }
  return Array.from(descriptors);
}

export function extractEntities(query: string): ExtractedEntities {
  const temporal: string[] = [];
  for (const match of query.matchAll(TEMPORAL_PATTERN)) {
    temporal.push(match[1]!);
  }

  const numerical: string[] = [];
  for (const match of query.matchAll(NUMERICAL_ATTACHED_PATTERN)) {
    numerical.push(match[0]);
  }
  for (const match of query.matchAll(NUMERICAL_SCALE_PATTERN)) {
    numerical.push(match[0]);
  }

  const names = extractNames(query);
  const locations = extractLocations(query);
  const descriptors = extractDescriptors(query);

  return {
    temporal,
    numerical,
    names,
    locations,
    descriptors,
  };
}

export function expandTemporalRanges(entities: string[]): string[] {
  const result: string[] = [];
  for (const entity of entities) {
    const rangeMatch = entity.match(/^(\d{4})\s*(?:-|–|to)\s*(\d{4})$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let year = start; year <= end; year++) {
        result.push(String(year));
      }
    } else {
      result.push(entity);
    }
  }
  return result;
}

export function generateEntityBasedQueries(
  entities: ExtractedEntities,
  maxQueries = 10,
  originalQuery?: string,
): string[] {
  const queries = new Set<string>();

  // Prefer combined queries (richer)
  const nonEmptyArrays = [
    entities.names,
    entities.temporal,
    entities.numerical,
    entities.locations,
    entities.descriptors,
  ].filter((arr) => arr.length > 0);

  if (nonEmptyArrays.length >= 2) {
    const first = nonEmptyArrays[0]![0];
    const second = nonEmptyArrays[1]![0];
    if (first && second) {
      queries.add(`${first} ${second}`);
    }
  }

  for (const arr of nonEmptyArrays) {
    for (const entity of arr) {
      queries.add(entity);
    }
  }

  if (originalQuery) {
    queries.add(originalQuery);
  }

  const ordered = Array.from(queries);
  return ordered.slice(0, maxQueries);
}
