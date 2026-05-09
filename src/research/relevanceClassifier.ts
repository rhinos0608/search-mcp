/**
 * RelevanceClassifier — post-extraction relevance scoring for findings.
 *
 * Scores each candidate finding against the original research query using
 * multi-signal relevance (token overlap, entity match, query term coverage).
 *
 * Design:
 * - Rule-based, no LLM calls — fast, deterministic, auditable.
 * - Each finding gets a relevanceScore (0-1) and relevanceReason.
 * - Findings at or above 0.72 are considered "relevant" to the query.
 * - Findings below 0.72 are flagged with lowRelevance in the reason field.
 * - NO findings are dropped — they remain in state for reference.
 * - The synthesizer gates what enters themes using the score.
 */

import type { Finding } from './types.js';
import { logger } from '../logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Threshold for a finding to be considered relevant enough for thematic inclusion. */
export const RELEVANCE_THRESHOLD = 0.72;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tokenize a string into a set of lowercase, non-empty words, excluding
 * common stop words that carry little topical signal.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
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
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'some',
  'any',
  'no',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'and',
  'but',
  'or',
  'if',
  'because',
  'about',
  'up',
  'down',
  'also',
  'well',
  'very',
  'quite',
  'pretty',
  'rather',
  'while',
  'since',
  'until',
  'although',
  'though',
  'even',
  'yet',
]);

function hasNonLatinChars(text: string): boolean {
  return Array.from(text).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0x7f && code !== 0x200b;
  });
}

/**
 * Tokenize a string into a set of lowercase, non-empty words, excluding
 * common stop words that carry little topical signal.
 * Language-aware: uses Unicode-aware segmentation for non-Latin scripts.
 */
function tokenize(text: string): string[] {
  // For non-Latin scripts, use Unicode word boundaries
  if (hasNonLatinChars(text)) {
    const tokens: string[] = [];
    // Use Intl.Segmenter for proper script-aware tokenization
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
      for (const segment of segmenter.segment(text)) {
        const word = segment.segment.trim().toLowerCase();
        if (word.length > 0) tokens.push(word);
      }
    } catch {
      // Fallback: char-by-char
      for (const ch of text) {
        if (/\p{L}/u.test(ch)) tokens.push(ch.toLowerCase());
      }
    }
    return tokens.filter((t) => t.length > 0);
  }
  // For Latin script (English), use English stop words
  return text
    .toLowerCase()
    .split(/[^\w']+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Compute token overlap ratio between two texts.
 * Uses Jaccard similarity on content-word sets.
 */
function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute query term coverage — what fraction of the query's
 * content words appear in the finding's claim text.
 */
function queryTermCoverage(query: string, claim: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 1;
  const claimTokens = new Set(tokenize(claim));
  let covered = 0;
  for (const term of queryTerms) {
    if (claimTokens.has(term)) covered++;
  }
  return covered / queryTerms.length;
}

/**
 * Detect entity-level topical drift.
 * Checks if the finding's core topic overlaps with the query.
 * Uses longest common content-word subsequence heuristics.
 */
function hasTopicalDrift(query: string, claim: string): { drift: boolean; reason: string } {
  // Extract key nouns from query
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return { drift: false, reason: 'Query has no extractable content words' };
  }

  // Check if at least 1 query content word appears in the finding
  const claimText = claim.toLowerCase();
  const anyMatch = queryTokens.some((t) => claimText.includes(t));

  if (!anyMatch) {
    // Also check the normalizedClaim
    return {
      drift: true,
      reason: `Topical drift: finding does not share content words with query ("${queryTokens.slice(0, 5).join(', ')}..."). Topic appears unrelated.`,
    };
  }

  return { drift: false, reason: '' };
}

// ── Classification patterns for common irrelevant categories ────────────────

/**
 * Known topical-irrelevance patterns.
 * These match when a finding discusses an entirely different topic
 * that happens to share some vocabulary with the query.
 *
 * Each entry maps when a finding's domain differs from the query's domain.
 * We detect this by checking if the finding mentions terms exclusive to
 * a different domain while missing the query's domain terms entirely.
 */
const DOMAIN_SIGNALS: Record<string, string[]> = {
  'ai-ml': [
    'model',
    'training',
    'inference',
    'llm',
    'transformer',
    'neural',
    'deep learning',
    'gpt',
    'dataset',
    'fine-tune',
    'parameter',
    'attention',
    'embedding',
    'token',
  ],
  'debt-finance': [
    'debt',
    'default',
    'bond',
    'credit',
    'lender',
    'borrower',
    'interest rate',
    'sovereign',
    'treasury',
    'yield',
    'spread',
    'repayment',
    'principal',
  ],
  'press-media': [
    'press',
    'freedom',
    'journalist',
    'media',
    'censorship',
    'editor',
    'publisher',
    'press freedom',
    'reporting',
    'newsroom',
    'outlet',
    'coverage',
    'article',
  ],
  software: [
    'api',
    'sdk',
    'library',
    'framework',
    'package',
    'dependency',
    'build',
    'deploy',
    'runtime',
    'compiler',
    'interface',
    'protocol',
  ],
  'health-medical': [
    'patient',
    'clinical',
    'trial',
    'treatment',
    'therapy',
    'diagnosis',
    'symptom',
    'disease',
    'drug',
    'dosage',
    'efficacy',
    'mortality',
  ],
  'climate-energy': [
    'emission',
    'carbon',
    'renewable',
    'solar',
    'wind',
    'grid',
    'energy',
    'climate',
    'temperature',
    'warming',
    'fossil fuel',
    'decarbonization',
    'clean energy',
  ],
};

/**
 * Detect domain contamination — a finding that discusses a different domain
 * than the query but happens to match on generic terms.
 */
function detectDomainContamination(
  query: string,
  claim: string,
): { contaminated: boolean; claimDomain?: string; reason?: string } {
  const queryTokens = new Set(tokenize(query));
  const claimTokens = new Set(tokenize(claim));

  // For each domain, check how many of its signals appear in query vs claim
  let queryDomain = '';
  let maxQuerySignals = 0;

  for (const [domain, signals] of Object.entries(DOMAIN_SIGNALS)) {
    let queryHits = 0;
    for (const s of signals) {
      if (query.toLowerCase().includes(s)) queryHits++;
    }
    // Also check individual signal words
    for (const s of signals) {
      for (const t of queryTokens) {
        if (s.includes(t) || t.includes(s)) {
          queryHits++;
          break;
        }
      }
    }
    if (queryHits > maxQuerySignals) {
      maxQuerySignals = queryHits;
      queryDomain = domain;
    }
  }

  // If query has no clear domain, skip contamination check
  if (maxQuerySignals < 2) return { contaminated: false };

  // Check if claim is in a different domain
  const claimText = claim.toLowerCase();
  for (const [domain, signals] of Object.entries(DOMAIN_SIGNALS)) {
    if (domain === queryDomain) continue;
    let claimHits = 0;
    for (const s of signals) {
      if (claimText.includes(s)) claimHits++;
    }
    for (const t of claimTokens) {
      for (const s of signals) {
        if (s.includes(t) || t.includes(s)) {
          claimHits++;
          break;
        }
      }
    }
    // If claim has strong signals for a different domain with no query overlap
    if (claimHits >= 3) {
      const queryHasDomain =
        queryTokens.size > 0 &&
        Array.from(queryTokens).some((t) => signals.some((s) => s.includes(t) || t.includes(s)));
      if (!queryHasDomain) {
        return {
          contaminated: true,
          claimDomain: domain,
          reason: `Domain contamination: finding discusses ${domain.replace(/-/g, ' ')} (detected ${String(claimHits)} domain signals) while query is in ${queryDomain.replace(/-/g, ' ')} domain.`,
        };
      }
    }
  }

  return { contaminated: false };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RelevanceScore {
  /** 0-1 relevance score. >= threshold is "relevant". */
  score: number;
  /** Human-readable explanation. */
  reason: string;
  /** Whether this finding should be admissible for thematic inclusion. */
  admissible: boolean;
}

function normalizeForScore(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function subjectAnchors(query: string): string[] {
  const rawTokens = query.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  const properNouns = rawTokens.filter((token) => /^[A-Z][\p{L}\p{N}'-]{1,}$/u.test(token));
  const contentTokens = tokenize(query).filter((token) => token.length >= 6);
  const generic = new Set([
    'what',
    'when',
    'where',
    'which',
    'whose',
    'deep',
    'history',
    'current',
    'status',
    'latest',
    'research',
    'briefing',
    'overview',
    'legal',
    'policy',
    'policies',
    'evidence',
    'source',
    'sources',
    'conviction',
    'convictions',
    'stipulation',
    'stipulations',
    'controversy',
    'controversies',
  ]);
  return [...new Set([...properNouns, ...contentTokens].map((token) => token.toLowerCase()))]
    .filter((token) => !generic.has(token))
    .slice(0, 4);
}

function scoreAgainstText(query: string, text: string, threshold: number): RelevanceScore {
  const signals: { weight: number; score: number; label: string }[] = [];

  // ── Signal 1: Token overlap with query (weight 0.35) ──
  const overlap = tokenOverlap(query, text);
  signals.push({ weight: 0.35, score: overlap, label: `token overlap ${overlap.toFixed(3)}` });

  // ── Signal 2: Query term coverage (weight 0.30) ──
  const coverage = queryTermCoverage(query, text);
  signals.push({ weight: 0.3, score: coverage, label: `term coverage ${coverage.toFixed(3)}` });

  // ── Signal 3: Topical drift check (weight 0.20) ──
  const drift = hasTopicalDrift(query, text);
  const driftScore = drift.drift ? 0.0 : 1.0;
  signals.push({
    weight: 0.2,
    score: driftScore,
    label: drift.drift ? 'topical drift' : 'topically aligned',
  });

  // ── Signal 4: Domain contamination check (weight 0.15) ──
  const contamination = detectDomainContamination(query, text);
  const contamScore = contamination.contaminated ? 0.0 : 1.0;
  signals.push({
    weight: 0.15,
    score: contamScore,
    label: contamination.contaminated
      ? `domain contamination: ${contamination.claimDomain ?? 'unknown'}`
      : 'clean domain',
  });

  let totalScore = 0;
  let totalWeight = 0;
  const parts: string[] = [];
  for (const s of signals) {
    totalScore += s.weight * s.score;
    totalWeight += s.weight;
    parts.push(s.label);
  }
  let finalScore = totalWeight > 0 ? totalScore / totalWeight : 0;

  const anchors = subjectAnchors(query);
  const normalizedText = normalizeForScore(text);
  const matchedAnchors = anchors.filter((anchor) => normalizedText.includes(anchor));
  if (anchors.length > 0 && matchedAnchors.length === 0) {
    finalScore *= 0.45;
    parts.push(`missing subject anchors: ${anchors.slice(0, 3).join(', ')}`);
  }

  let reason: string;
  if (drift.drift) {
    reason = drift.reason;
  } else if (contamination.contaminated) {
    reason = contamination.reason ?? 'Domain contamination detected';
  } else if (finalScore < 0.5) {
    const topQueryTerms = tokenize(query).slice(0, 5);
    const matchTerms = topQueryTerms.filter((t) => normalizedText.includes(t));
    const missingTerms = topQueryTerms.filter((t) => !normalizedText.includes(t));
    reason = `Low relevance (${finalScore.toFixed(2)}): text shares ${String(matchTerms.length)}/${String(topQueryTerms.length)} query content terms`;
    if (missingTerms.length > 0) {
      reason += ` — missing: "${missingTerms.slice(0, 3).join(', ')}"`;
    }
  } else if (finalScore < threshold) {
    reason = `Marginal relevance (${finalScore.toFixed(2)}): below threshold of ${String(threshold)}. Text touches the topic tangentially but lacks direct query alignment.`;
  } else {
    reason = `Relevant (${finalScore.toFixed(2)}): text directly addresses query content.`;
  }

  if (anchors.length > 0) {
    reason += ` Subject anchors matched ${String(matchedAnchors.length)}/${String(anchors.length)}.`;
  }

  return {
    score: Math.round(finalScore * 1000) / 1000,
    reason: `${reason} Signals: ${parts.join('; ')}.`,
    admissible: finalScore >= threshold,
  };
}

/**
 * Score arbitrary source/search text against the original research query.
 * Uses a lower threshold than findings because titles/snippets are shorter,
 * but applies a subject-anchor penalty to catch tangential source drift.
 */
export function scoreTextRelevance(query: string, text: string): RelevanceScore {
  return scoreAgainstText(query, text, 0.65);
}

/**
 * Score a single finding against the original research query.
 */
export function scoreFinding(
  query: string,
  finding: Pick<Finding, 'claim' | 'normalizedClaim'>,
): RelevanceScore {
  return scoreAgainstText(query, finding.claim, RELEVANCE_THRESHOLD);
}

/**
 * Score all findings in the state against the original research query.
 * Returns a map of finding ID → RelevanceScore.
 *
 * This is a pure function — it does NOT mutate findings.
 * The caller (pipeline strategy) applies the scores to findings.
 */
export function scoreAllFindings(
  query: string,
  findings: Pick<Finding, 'id' | 'claim' | 'normalizedClaim'>[],
): Map<string, RelevanceScore> {
  const results = new Map<string, RelevanceScore>();

  for (const f of findings) {
    const scored = scoreFinding(query, f);
    results.set(f.id, scored);
  }

  const admissible = [...results.values()].filter((r) => r.admissible).length;
  const total = findings.length;

  logger.info(
    {
      total,
      admissible: admissible,
      inadmissible: total - admissible,
      threshold: RELEVANCE_THRESHOLD,
    },
    'Relevance classification complete',
  );

  return results;
}

/**
 * Determine which findings are admissible for thematic synthesis.
 * Uses the relevance score from scoreAllFindings.
 * Returns the set of admissible finding IDs.
 */
export function getAdmissibleFindings(scores: Map<string, RelevanceScore>): Set<string> {
  const admissible = new Set<string>();
  for (const [id, score] of scores) {
    if (score.admissible) admissible.add(id);
  }
  return admissible;
}
