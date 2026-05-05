/**
 * TaxonomyRevision — Phase 1.5 of the deep research pipeline.
 *
 * After the first broad discovery pass, reviews whether the original
 * demotes those with no sources found, and proposes new research angles
 * from themes emerging in the source candidates.
 *
 * This is a rule-based analysis (no LLM calls) per the MVP scope.
 */

import { randomUUID } from 'node:crypto';
import type {
  ResearchTaxonomy,
  SourceCandidate,
  SubQuestion,
  QueryClassification,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
  return randomUUID().slice(0, 12);
}

// ── Coverage analysis ────────────────────────────────────────────────────────

/**
 * Per-sub-question coverage data computed from source candidates.
 */
export interface SubQuestionCoverage {
  subQuestionId: string;
  sourceCount: number;
  averageRelevance: number;
  averageQuality: number;
}

/**
 * Count sources and compute average relevance/quality per sub-question.
 */
function analyzeSourceCoverage(
  subQuestions: SubQuestion[],
  sources: SourceCandidate[],
): SubQuestionCoverage[] {
  return subQuestions.map((sq) => {
    const relevantSources = sources.filter((s) => s.subQuestionId === sq.id);
    const count = relevantSources.length;
    const avgRelevance =
      count > 0 ? relevantSources.reduce((sum, s) => sum + s.estimatedRelevance, 0) / count : 0;
    const avgQuality =
      count > 0 ? relevantSources.reduce((sum, s) => sum + s.estimatedQuality, 0) / count : 0;

    return {
      subQuestionId: sq.id,
      sourceCount: count,
      averageRelevance: avgRelevance,
      averageQuality: avgQuality,
    };
  });
}

// ── New angle detection ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'we',
  'you',
  'our',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'not',
  'no',
  'nor',
  'so',
  'if',
  'then',
  'than',
  'also',
  'very',
  'just',
  'about',
  'up',
  'out',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'very',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'why',
  'using',
  'used',
  'use',
  'based',
  'through',
  'into',
  'over',
  'between',
  'under',
  'before',
  'after',
  'during',
  'without',
  'within',
  'along',
  'among',
  'across',
  'because',
  'being',
  'while',
  'since',
  'until',
  'here',
  'there',
  'get',
  'got',
  'make',
  'made',
  'take',
  'took',
  'also',
  'well',
  'back',
  'now',
  'new',
  'one',
  'two',
  'like',
  'just',
  'much',
  'many',
  'some',
  'any',
  'way',
  'part',
  'set',
  'work',
  'need',
  'seem',
  'even',
  'still',
  'already',
  'yet',
  'next',
  'last',
  'first',
]);

/**
 * Simple keyword extraction: lower-case, split on non-word characters,
 * filter stop words and short tokens. Returns unique keywords.
 */
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));

  return [...new Set(words)];
}

/**
 * Detect potential new research angles from sources that are
 * under-covered by existing sub-questions.
 *
 * Clusters keyword co-occurrence across source titles and snippets,
 * then creates up to 2 new sub-questions from the most frequent
 * significant keywords.
 */
function detectNewAngles(
  subQuestions: SubQuestion[],
  sources: SourceCandidate[],
  originalQuery: string,
): SubQuestion[] {
  if (sources.length < 3) return [];

  const existingIds = new Set(subQuestions.map((sq) => sq.id));

  // Select sources that are either unmatched or belong to poorly-covered sub-questions
  const undercoveredSources = sources.filter((s) => {
    if (!existingIds.has(s.subQuestionId)) return true;
    const sq = subQuestions.find((q) => q.id === s.subQuestionId);
    if (!sq) return true;
    const sqSources = sources.filter((src) => src.subQuestionId === sq.id);
    return sqSources.length < 2;
  });

  if (undercoveredSources.length < 3) return [];

  // Build keyword frequency across under-covered sources
  const wordCounts = new Map<string, number>();

  for (const source of undercoveredSources) {
    const words = new Set([...extractKeywords(source.title), ...extractKeywords(source.snippet)]);
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Filter to keywords appearing in 2+ sources, sort by frequency
  const frequentKeywords = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a);

  if (frequentKeywords.length === 0) return [];

  // Derive classification from the first existing sub-question
  const parentClassification: QueryClassification = subQuestions[0]?.classification ?? 'explainer';

  const newQuestions: SubQuestion[] = [];
  const usedWords = new Set<string>();

  for (const [word] of frequentKeywords) {
    if (newQuestions.length >= 2) break;
    if (usedWords.has(word)) continue;

    // Skip keywords that are too generic or overlap with existing sub-question text
    const overlapsExisting = subQuestions.some((sq) => sq.text.toLowerCase().includes(word));
    if (overlapsExisting) {
      usedWords.add(word);
      continue;
    }

    usedWords.add(word);

    newQuestions.push({
      id: makeId(),
      text: `What is the role and impact of ${word} in the context of "${originalQuery}"?`,
      classification: parentClassification,
      evidenceType: 'emergent-angle',
      preferredSources: ['web', 'academic', 'news', 'reddit'],
      freshnessRequirement: 'within 2 years',
      failureModes: [
        'limited sources for niche angle',
        'angle may overlap with existing sub-questions',
        'keyword-driven angle may not reflect a coherent theme',
      ],
      budgetPriority: 5,
      status: 'pending',
    });
  }

  return newQuestions;
}

// ── Revision result ──────────────────────────────────────────────────────────

/**
 * Structured result of a taxonomy revision pass.
 */
export interface RevisionResult {
  taxonomy: ResearchTaxonomy;
  /** Sub-question IDs that were removed (demoted). */
  demotedIds: string[];
  /** New sub-question IDs that were added. */
  addedIds: string[];
}

// ── TaxonomyRevision ─────────────────────────────────────────────────────────

/**
 * Rule-based taxonomy revision engine.
 *
 * After the first discovery pass, reviews source coverage and adjusts
 * the sub-question tree:
 *  - Demotes (removes) sub-questions with zero sources found.
 *  - Adds new sub-questions for emergent themes detected in source candidates.
 *  - Preserves the original taxonomy when no revision is needed.
 */
export class TaxonomyRevision {
  /**
   * Revise a research taxonomy against discovered source candidates.
   *
   * @param original - The original taxonomy from Phase 1 decomposition.
   * @param sources  - Source candidates discovered in Phase 2.
   * @returns Revised taxonomy and a record of what changed.
   */
  revise(original: ResearchTaxonomy, sources: SourceCandidate[]): RevisionResult {
    const { originalQuery, subQuestions } = original;

    // No sources at all → nothing to revise against
    if (sources.length === 0) {
      return {
        taxonomy: { ...original, revised: false },
        demotedIds: [],
        addedIds: [],
      };
    }

    // 1. Analyze coverage
    const coverage = analyzeSourceCoverage(subQuestions, sources);
    const totalCovered = coverage.filter((c) => c.sourceCount > 0).length;

    // If ALL sub-questions have 0 sources, a single bad discovery pass
    // shouldn't nuke the entire plan — skip revision
    if (totalCovered === 0) {
      return {
        taxonomy: { ...original, revised: false },
        demotedIds: [],
        addedIds: [],
      };
    }

    // 2. Demote sub-questions with 0 sources
    const retained: SubQuestion[] = [];
    const demotedIds: string[] = [];

    for (const sq of subQuestions) {
      const cov = coverage.find((c) => c.subQuestionId === sq.id);
      if (cov?.sourceCount === 0) {
        demotedIds.push(sq.id);
      } else {
        retained.push(sq);
      }
    }

    // 3. Detect new angles
    const newSubQuestions = detectNewAngles(subQuestions, sources, originalQuery);
    const addedIds = newSubQuestions.map((sq) => sq.id);

    // 4. Assemble revised taxonomy
    const wasRevised = demotedIds.length > 0 || addedIds.length > 0;

    if (!wasRevised) {
      return {
        taxonomy: { ...original, revised: false },
        demotedIds: [],
        addedIds: [],
      };
    }

    const revisionLogParts: string[] = [];
    if (demotedIds.length > 0) {
      revisionLogParts.push(`demoted ${String(demotedIds.length)} question(s) with no sources`);
    }
    if (addedIds.length > 0) {
      revisionLogParts.push(
        `added ${String(addedIds.length)} emergent angle(s) from source analysis`,
      );
    }

    const revised: ResearchTaxonomy = {
      originalQuery,
      subQuestions: [...retained, ...newSubQuestions],
      revised: true,
      revisionHistory: [...original.revisionHistory, `Revised: ${revisionLogParts.join('; ')}.`],
    };

    return {
      taxonomy: revised,
      demotedIds,
      addedIds,
    };
  }
}
