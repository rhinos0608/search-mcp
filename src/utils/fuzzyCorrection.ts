/**
 * Levenshtein-distance fuzzy query correction.
 *
 * Provides query typo auto-correction using a domain vocabulary of ~200
 * common search / programming terms. Words ≤ 2 chars are never corrected.
 *
 * Adaptive edit-distance thresholds:
 *   – word length ≤ 4: max 1 edit
 *   – word length ≤ 12: max 2 edits
 *   – word length > 12: max 3 edits
 */

import { ENGLISH_WORDS } from './englishWords.js';

// ── Levenshtein distance ───────────────────────────────────────────────────

export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const diag = prev[j - 1] ?? 0;
      const up = prev[j] ?? 0;
      const left = curr[j - 1] ?? 0;
      curr[j] =
        a[i - 1] === b[j - 1]
          ? diag
          : 1 + Math.min(up, left, diag);
    }
    prev = curr;
  }

  return prev[b.length] ?? 0;
}

// ── Adaptive edit-distance thresholds ──────────────────────────────────────

export function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// ── Domain vocabulary ──────────────────────────────────────────────────────

const VOCABULARY_WORDS = [
  // Common programming terms
  'algorithm',
  'annotation',
  'asynchronous',
  'authentication',
  'authorization',
  'automation',
  'benchmark',
  'boolean',
  'callback',
  'certificate',
  'changelog',
  'closure',
  'cluster',
  'compiler',
  'component',
  'configuration',
  'container',
  'concurrency',
  'continuous',
  'coverage',
  'database',
  'debugging',
  'declarative',
  'decryption',
  'delegation',
  'dependency',
  'deployment',
  'deprecation',
  'deserialization',
  'destructuring',
  'documentation',
  'ecosystem',
  'encapsulation',
  'encryption',
  'enumeration',
  'environment',
  'exception',
  'expression',
  'extension',
  'framework',
  'function',
  'generator',
  'getter',
  'hashing',
  'identifier',
  'immutable',
  'implementation',
  'import',
  'inference',
  'inheritance',
  'initialization',
  'injection',
  'instance',
  'integration',
  'interface',
  'interpolation',
  'interpreter',
  'invariant',
  'iterator',
  'javascript',
  'json',
  'linter',
  'mapping',
  'middleware',
  'migration',
  'mock',
  'module',
  'monorepo',
  'mutation',
  'namespace',
  'navigation',
  'nullable',
  'observable',
  'observer',
  'operator',
  'optimization',
  'orchestrator',
  'overloading',
  'overriding',
  'package',
  'parser',
  'polyfill',
  'polymorphism',
  'preprocessor',
  'production',
  'profiling',
  'programming',
  'promise',
  'property',
  'protocol',
  'prototype',
  'provider',
  'recursive',
  'refactoring',
  'reference',
  'registry',
  'regression',
  'rendering',
  'repository',
  'resolution',
  'responsive',
  'rest',
  'serialization',
  'server',
  'session',
  'setter',
  'snapshot',
  'specification',
  'standard',
  'statement',
  'subscription',
  'syntax',
  'template',
  'testing',
  'threshold',
  'tolerant',
  'transformer',
  'transpiler',
  'typescript',
  'utility',
  'validation',
  'variable',
  'version',
  'viewport',
  'visibility',
  'websocket',
  'wildcard',
  'wrapper',
  'yaml',

  // Common search terms
  'alternative',
  'analysis',
  'article',
  'best',
  'blog',
  'book',
  'cheatsheet',
  'cheat',
  'compare',
  'comparison',
  'course',
  'crash',
  'demo',
  'difference',
  'example',
  'faq',
  'features',
  'glossary',
  'guide',
  'handbook',
  'introduction',
  'latest',
  'manual',
  'overview',
  'patterns',
  'playbook',
  'practices',
  'quickstart',
  'reference',
  'release',
  'roadmap',
  'sample',
  'starter',
  'syntax',
  'troubleshooting',
  'tutorial',
  'upgrade',
  'usage',
  'video',
  'walkthrough',
  'workshop',

  // Technology / product names
  'angular',
  'ansible',
  'aws',
  'azure',
  'bash',
  'cassandra',
  'circleci',
  'cloudflare',
  'couchdb',
  'css',
  'django',
  'docker',
  'drupal',
  'elasticsearch',
  'eslint',
  'express',
  'firebase',
  'flask',
  'flutter',
  'gatsby',
  'gcp',
  'git',
  'github',
  'gitlab',
  'golang',
  'gradle',
  'graphql',
  'grpc',
  'html',
  'http',
  'istanbul',
  'java',
  'jenkins',
  'jest',
  'jquery',
  'kafka',
  'keras',
  'kotlin',
  'kubernetes',
  'lambda',
  'laravel',
  'linux',
  'lodash',
  'maven',
  'mocha',
  'mongodb',
  'mysql',
  'neo4j',
  'nestjs',
  'nextjs',
  'nginx',
  'nodejs',
  'npm',
  'nuxt',
  'numpy',
  'openapi',
  'openshift',
  'opentelemetry',
  'pandas',
  'php',
  'playwright',
  'postgresql',
  'postman',
  'prettier',
  'prometheus',
  'pulumi',
  'puppeteer',
  'pytorch',
  'python',
  'rabbitmq',
  'react',
  'reactnative',
  'reactivex',
  'redis',
  'redux',
  'ruby',
  'rust',
  'sass',
  'scala',
  'scikit',
  'selenium',
  'serverless',
  'shopify',
  'solidity',
  'spring',
  'sqlite',
  'storybook',
  'stripe',
  'svelte',
  'swagger',
  'swift',
  'tailwind',
  'tensorflow',
  'terraform',
  'travis',
  'twilio',
  'ubuntu',
  'vagrant',
  'vscode',
  'vue',
  'webpack',
  'wordpress',
  'yarn',
];

const VOCABULARY_SET = new Set(VOCABULARY_WORDS);

// ── Correction types ───────────────────────────────────────────────────────

export interface Correction {
  original: string;
  corrected: string;
  distance: number;
}

export interface CorrectQueryResult {
  corrected: string;
  changes: Correction[];
}

// ── Main correction function ───────────────────────────────────────────────

/**
 * Attempt to correct typos in a search query against the domain vocabulary.
 *
 * Splits the query into words, checks each against the vocabulary,
 * and applies Levenshtein-distance-based fuzzy matching for unknown words.
 *
 * Words ≤ 2 characters are never corrected.
 * If no correction is found, the original query is returned unchanged.
 *
 * @param query        The original search query.
 * @param options      Optional overrides for vocabulary and max corrections.
 * @returns            The corrected query and list of individual changes.
 */
export function correctQuery(
  query: string,
  options?: {
    vocabulary?: string[];
    maxCorrections?: number;
  },
): CorrectQueryResult {
  const vocabulary = options?.vocabulary ?? VOCABULARY_WORDS;
  const maxCorrections = options?.maxCorrections ?? 3;
  const changes: Correction[] = [];

  const words = query.trim().split(/\s+/);
  if (words.length === 0 || (words.length === 1 && words[0] === '')) {
    return { corrected: query, changes: [] };
  }

  const correctedWords = words.map((word) => {
    // Never correct words ≤ 2 characters
    if (word.length <= 2) return word;

    const lower = word.toLowerCase();

    // Fast path: word is already in vocabulary
    if (VOCABULARY_SET.has(lower)) return word;

    // Never correct recognized English words
    if (ENGLISH_WORDS.has(lower)) return word;

    // Skip if we've already made maxCorrections changes
    if (changes.length >= maxCorrections) return word;

    // Find the closest vocabulary match within edit distance threshold
    const limit = maxEditDistance(lower.length);
    let bestMatch: string | undefined;
    let bestDist = limit + 1;

    for (const vocabWord of vocabulary) {
      // Quick length filter: |len(a) - len(b)| must be ≤ limit
      const lenDiff = Math.abs(lower.length - vocabWord.length);
      if (lenDiff > limit) continue;

      const dist = levenshteinDistance(lower, vocabWord);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = vocabWord;
      }
    }

    if (bestMatch !== undefined) {
      // Preserve original casing patterns
      const corrected =
        word[0]?.toUpperCase() === word[0]
          ? bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1)
          : bestMatch;

      changes.push({
        original: word,
        corrected,
        distance: bestDist,
      });
      return corrected;
    }

    return word;
  });

  if (changes.length === 0) {
    return { corrected: query, changes: [] };
  }

  return {
    corrected: correctedWords.join(' '),
    changes,
  };
}
