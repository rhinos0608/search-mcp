import type { ExtractedEntities } from './entityExtractor.js';
import type { SourceType } from './types.js';

export type DomainCategory =
  | 'medical'
  | 'scientific'
  | 'technical'
  | 'current-events'
  | 'background-knowledge'
  | 'code'
  | 'community-opinion'
  | 'comparative'
  | 'how-to'
  | 'general';

export interface DomainRoute {
  category: DomainCategory;
  confidence: number;
  primaryBackends: SourceType[];
  secondaryBackends: SourceType[];
  reasoning: string;
}

interface DomainSpec {
  category: DomainCategory;
  keywords: string[];
  primaryBackends: SourceType[];
  secondaryBackends: SourceType[];
}

const DOMAINS: DomainSpec[] = [
  {
    category: 'medical',
    keywords: [
      'treatment',
      'symptom',
      'clinical trial',
      'FDA',
      'drug',
      'medicine',
      'patient',
      'diagnosis',
      'therapy',
      'vaccine',
      'pharma',
      'disease',
      'condition',
      'health',
      'medical',
      'clinical',
      'hospital',
      'physician',
    ],
    primaryBackends: ['pubmed', 'academic'],
    secondaryBackends: ['web', 'wikipedia'],
  },
  {
    category: 'scientific',
    keywords: [
      'paper',
      'arxiv',
      'study',
      'hypothesis',
      'experiment',
      'research',
      'publication',
      'journal',
      'peer-reviewed',
      'methodology',
      'findings',
      'literature',
      'survey',
      'meta-analysis',
      'observation',
      'theory',
    ],
    primaryBackends: ['academic', 'web'],
    secondaryBackends: ['github', 'wikipedia'],
  },
  {
    category: 'technical',
    keywords: [
      'API',
      'benchmark',
      'latency',
      'architecture',
      'performance',
      'throughput',
      'scalability',
      'system',
      'framework',
      'protocol',
      'infrastructure',
      'runtime',
      'compiler',
      'kernel',
      'microservice',
    ],
    primaryBackends: ['github', 'documentation'],
    secondaryBackends: ['academic', 'web'],
  },
  {
    category: 'current-events',
    keywords: [
      'today',
      'breaking',
      'just announced',
      'latest',
      'recent',
      'news',
      'update',
      'developments',
      'happening',
      'this week',
      'this month',
      'announced',
      'released',
      'launch',
      'unveiled',
      'current',
    ],
    primaryBackends: ['news', 'web'],
    secondaryBackends: ['reddit', 'hackernews'],
  },
  {
    category: 'background-knowledge',
    keywords: [
      'what is',
      'define',
      'history of',
      'explain',
      'meaning of',
      'overview of',
      'introduction to',
      'basics of',
      'fundamentals',
      'background',
      'definition',
      'what are',
      'how does',
      'how do',
    ],
    primaryBackends: ['wikipedia', 'web'],
    secondaryBackends: ['academic'],
  },
  {
    category: 'code',
    keywords: [
      'repo',
      'github',
      'npm',
      'library',
      'implementation',
      'code',
      'source code',
      'package',
      'module',
      'sdk',
      'crate',
      'gem',
      'pip',
      'maven',
      'gradle',
    ],
    primaryBackends: ['github', 'stackoverflow'],
    secondaryBackends: ['documentation', 'web'],
  },
  {
    category: 'community-opinion',
    keywords: [
      'reddit',
      'best',
      'vs',
      'review',
      'opinion',
      'experience',
      'recommendation',
      'thoughts on',
      'what do you think',
      'favorite',
      'worst',
      'worth it',
      'should i buy',
    ],
    primaryBackends: ['reddit', 'hackernews'],
    secondaryBackends: ['youtube', 'web'],
  },
  {
    category: 'comparative',
    keywords: [
      'compare',
      'vs',
      'versus',
      'difference between',
      'better than',
      'pros and cons',
      'tradeoff',
      'which is better',
      'which one',
      'alternatives',
      'comparison',
    ],
    primaryBackends: ['web', 'reddit'],
    secondaryBackends: ['academic', 'github'],
  },
  {
    category: 'how-to',
    keywords: [
      'how to',
      'tutorial',
      'guide',
      'setup',
      'install',
      'configure',
      'deploy',
      'getting started',
      'step by step',
      'walkthrough',
      'example',
      'sample',
    ],
    primaryBackends: ['documentation', 'stackoverflow'],
    secondaryBackends: ['github', 'web'],
  },
];

const KEYWORD_MATCH_SCORE = 0.4;
const PREFIX_MATCH_SCORE = 0.3;
const TEMPORAL_BOOST_SCORE = 0.2;
const CONFIDENCE_THRESHOLD = 0.5;

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function hasKeywordMatch(normalized: string, keyword: string): boolean {
  const lowerKeyword = keyword.toLowerCase();
  if (lowerKeyword.includes(' ')) {
    const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`,
      'i',
    );
    return regex.test(normalized);
  }
  const regex = new RegExp(`\\b${lowerKeyword}\\b`, 'i');
  return regex.test(normalized);
}

function hasPrefixMatch(normalized: string, keyword: string): boolean {
  const lowerKeyword = keyword.toLowerCase();
  if (lowerKeyword.includes(' ')) {
    if (normalized.startsWith(lowerKeyword)) {
      const nextChar = normalized[lowerKeyword.length];
      return !nextChar || /[^a-z0-9]/.test(nextChar);
    }
    return false;
  }
  const firstTokenMatch = /^([a-z]+)/.exec(normalized);
  if (!firstTokenMatch) return false;
  const firstToken = firstTokenMatch[1];
  if (!firstToken) return false;
  return firstToken === lowerKeyword;
}

/**
 * Route a query to a domain category based on keyword heuristics.
 *
 * Confidence scoring:
 * - Exact keyword match in domain keyword list → +0.4 per match
 * - Query prefix match (e.g., "what is" → background-knowledge) → +0.3
 * - Temporal entity overlap (current-events) → +0.2
 * - Capped at 1.0
 *
 * If the highest confidence is below 0.5, falls back to the general category.
 * LLM-based classification can be added as an optional fallback for v2.
 */
export function routeQuery(
  query: string,
  entities?: ExtractedEntities,
): DomainRoute {
  const normalized = normalizeQuery(query);

  let bestCategory: DomainCategory = 'general';
  let bestConfidence = 0;
  let bestReasoning =
    'No matching keywords found; falling back to general search.';
  let bestPrimary: SourceType[] = ['web'];
  let bestSecondary: SourceType[] = ['academic', 'wikipedia'];

  for (const domain of DOMAINS) {
    let confidence = 0;
    const matchedKeywords: string[] = [];

    for (const keyword of domain.keywords) {
      if (hasKeywordMatch(normalized, keyword)) {
        confidence += KEYWORD_MATCH_SCORE;
        matchedKeywords.push(keyword);
      }
      if (hasPrefixMatch(normalized, keyword)) {
        confidence += PREFIX_MATCH_SCORE;
      }
    }

    if (
      domain.category === 'current-events' &&
      entities &&
      entities.temporal.length > 0
    ) {
      confidence += TEMPORAL_BOOST_SCORE;
    }

    confidence = Math.min(confidence, 1.0);

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestCategory = domain.category;
      bestPrimary = domain.primaryBackends;
      bestSecondary = domain.secondaryBackends;
      if (matchedKeywords.length > 0) {
        bestReasoning = `Matched keywords: ${matchedKeywords.join(', ')}. Confidence: ${confidence.toFixed(2)}.`;
      } else if (
        domain.category === 'current-events' &&
        entities &&
        entities.temporal.length > 0
      ) {
        bestReasoning = `Temporal entity boost for current-events. Confidence: ${confidence.toFixed(2)}.`;
      } else {
        bestReasoning = `Prefix match for ${domain.category}. Confidence: ${confidence.toFixed(2)}.`;
      }
    }
  }

  if (bestConfidence < CONFIDENCE_THRESHOLD) {
    return {
      category: 'general',
      confidence: 0,
      primaryBackends: ['web'],
      secondaryBackends: ['academic', 'wikipedia'],
      reasoning:
        'Confidence below threshold (0.5); falling back to general search. LLM classification can be used for ambiguous queries.',
    };
  }

  return {
    category: bestCategory,
    confidence: bestConfidence,
    primaryBackends: bestPrimary,
    secondaryBackends: bestSecondary,
    reasoning: bestReasoning,
  };
}
