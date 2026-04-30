/**
 * Phase 5 — Evaluation Framework: Metrics Types & Runner
 *
 * Provides offline retrieval evaluation metrics and a golden-query runner.
 * Designed for CI use with pre-recorded corpora and for optional live evals.
 */

// ── Golden Query Types ──────────────────────────────────────────────────────

export interface GoldenQuery {
  id: string;
  domain: string;
  query: string;
  expectedSection?: string | undefined;
  expectedTerms?: string[] | undefined;
  expectedTags?: string[] | undefined;
  expectedLocation?: string | undefined;
  expectedWorkMode?: string | undefined;
  minAcceptedScore?: number | undefined;
  minRelevant: number;
  difficulty: 'easy' | 'medium' | 'hard';
  relevantDocIds?: string[] | undefined;
  relevantTexts?: string[] | undefined;
}

export type GoldenQueriesIndex = Record<string, GoldenQuery[]>;

// ── Evaluation Result Types ─────────────────────────────────────────────────

export interface EvalResult {
  queryId: string;
  domain: string;
  query: string;
  precisionAtK: number;
  recallAtK: number;
  ndcg: number;
  averageScore: number;
  topResultScore: number;
  numResults: number;
  numRelevant: number;
  relevantFound: number;
  passed: boolean;
  difficulty: string;
  details: {
    hits: number;
    misses: number;
    scores: number[];
    relevantPositions: number[];
  };
}

export interface EvalSummary {
  timestamp: Date;
  totalQueries: number;
  passed: number;
  failed: number;
  passRate: number;
  averagePrecision: number;
  averageRecall: number;
  averageNdcg: number;
  byDomain: Record<
    string,
    {
      total: number;
      passed: number;
      averagePrecision: number;
      averageRecall: number;
      averageNdcg: number;
    }
  >;
  byDifficulty: Record<
    string,
    {
      total: number;
      passed: number;
      averagePrecision: number;
      averageRecall: number;
    }
  >;
  results: EvalResult[];
}

// ── Corpus Snapshot Types (for offline/recorded eval) ────────────────────────

export interface CorpusSnapshotChunk {
  id: string;
  text: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface CorpusSnapshot {
  id: string;
  chunks: CorpusSnapshotChunk[];
  embeddingModel?: string | undefined;
  dimensions?: number | undefined;
}

// ── Scoring Functions ────────────────────────────────────────────────────────

/**
 * Calculate precision@k: fraction of top-k results that are relevant.
 */
export function precisionAtK(relevantIndices: Set<number>, k: number): number {
  if (k === 0) return 0;
  let relevant = 0;
  for (let i = 0; i < k; i++) {
    if (relevantIndices.has(i)) relevant++;
  }
  return relevant / k;
}

/**
 * Calculate recall@k: fraction of all relevant items found in top-k.
 */
export function recallAtK(relevantIndices: Set<number>, totalRelevant: number, k: number): number {
  if (totalRelevant === 0) return 0;
  let found = 0;
  for (let i = 0; i < k; i++) {
    if (relevantIndices.has(i)) found++;
  }
  return found / totalRelevant;
}

/**
 * Calculate nDCG@k (normalized Discounted Cumulative Gain).
 *
 * DCG = sum(rel_i / log2(i + 1)) for i = 1..k
 * nDCG = DCG / IDCG (ideal DCG with perfect ranking)
 */
export function ndcgAtK(scores: number[], relevantIndices: Set<number>, k: number): number {
  if (k === 0 || scores.length === 0) return 0;

  const actualK = Math.min(k, scores.length);

  // DCG for actual ranking
  let dcg = 0;
  for (let i = 0; i < actualK; i++) {
    const relevance: number = relevantIndices.has(i) ? 1 : 0;
    const rank = i + 1;
    dcg += relevance / Math.log2(rank + 1);
  }

  // IDCG: ideal ranking (all relevant items first)
  const numRelevant = relevantIndices.size;
  let idcg = 0;
  for (let i = 0; i < Math.min(numRelevant, actualK); i++) {
    const rank = i + 1;
    idcg += 1 / Math.log2(rank + 1);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

// ── Relevance Detection ─────────────────────────────────────────────────────

/**
 * Check if a result text is relevant to the golden query.
 * Uses expectedTerms matching (both exact and fuzzy).
 */
export function isResultRelevant(
  resultText: string,
  resultMetadata: Record<string, unknown> | undefined,
  query: GoldenQuery,
): boolean {
  const text = resultText.toLowerCase();

  // Check expected terms
  if (query.expectedTerms && query.expectedTerms.length > 0) {
    const matched = query.expectedTerms.filter((term) => text.includes(term.toLowerCase()));
    if (matched.length === 0) return false;
  }

  // Check expected section in metadata
  if (query.expectedSection && resultMetadata?.section) {
    const sectionValue = resultMetadata.section;
    const section = typeof sectionValue === 'string' ? sectionValue.toLowerCase() : '';
    if (section !== query.expectedSection.toLowerCase()) return false;
  }

  // Check expected tags in metadata
  if (query.expectedTags && resultMetadata?.tags) {
    const tags = resultMetadata.tags as string[];
    const matched = query.expectedTags.some((t) =>
      tags.some((tag) => tag.toLowerCase().includes(t.toLowerCase())),
    );
    if (!matched) return false;
  }

  return true;
}

/**
 * Find which result indices are relevant for a given query.
 */
export function findRelevantIndices(
  results: { text: string; metadata?: Record<string, unknown> | undefined }[],
  query: GoldenQuery,
): Set<number> {
  const relevant = new Set<number>();

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result && isResultRelevant(result.text, result.metadata, query)) {
      relevant.add(index);
    }
  }

  return relevant;
}

// ── Evaluation Runner ───────────────────────────────────────────────────────

export interface RetrievalAPI {
  retrieve: (
    query: string,
    topK?: number,
  ) => Promise<{
    results: { text: string; score?: number; metadata?: Record<string, unknown> }[];
  }>;
}

/**
 * Evaluate a single query against an API.
 */
export async function evaluateQuery(
  query: GoldenQuery,
  api: RetrievalAPI,
  topK = 10,
): Promise<EvalResult> {
  const response = await api.retrieve(query.query, topK);
  const results = response.results;
  const scores = results.map((r) => r.score ?? 0);

  const relevantIndices = findRelevantIndices(results, query);
  const numRelevant = query.relevantDocIds?.length ?? query.minRelevant;
  const relevantFound = relevantIndices.size;

  const pAt10 = precisionAtK(relevantIndices, Math.min(10, results.length));
  const rAt10 = recallAtK(relevantIndices, Math.max(numRelevant, 1), Math.min(10, results.length));
  const ndcg = ndcgAtK(scores, relevantIndices, Math.min(10, results.length));

  const averageScore =
    scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : 0;

  const topResultScore = scores[0] ?? 0;

  const relevantPositions: number[] = [];
  for (const idx of relevantIndices) {
    relevantPositions.push(idx);
  }

  const passed = relevantFound >= numRelevant;

  return {
    queryId: query.id,
    domain: query.domain,
    query: query.query,
    precisionAtK: pAt10,
    recallAtK: rAt10,
    ndcg,
    averageScore,
    topResultScore,
    numResults: results.length,
    numRelevant,
    relevantFound,
    passed,
    difficulty: query.difficulty,
    details: {
      hits: relevantFound,
      misses: results.length - relevantFound,
      scores,
      relevantPositions,
    },
  };
}

/**
 * Run a full evaluation suite against a set of golden queries.
 */
export async function runEvaluation(
  queries: GoldenQuery[],
  api: RetrievalAPI,
  topK = 10,
): Promise<EvalSummary> {
  const results: EvalResult[] = [];
  interface ByDomainAccum {
    total: number;
    passed: number;
    precisionSum: number;
    recallSum: number;
    ndcgSum: number;
  }

  interface ByDifficultyAccum {
    total: number;
    passed: number;
    precisionSum: number;
    recallSum: number;
  }

  const byDomain: Record<string, ByDomainAccum> = {};

  const byDifficulty: Record<string, ByDifficultyAccum> = {};

  for (const query of queries) {
    const result = await evaluateQuery(query, api, topK);
    results.push(result);

    // Aggregate by domain
    byDomain[result.domain] ??= { total: 0, passed: 0, precisionSum: 0, recallSum: 0, ndcgSum: 0 };
    const domainEntry = byDomain[result.domain];
    if (domainEntry !== undefined) {
      domainEntry.total++;
      if (result.passed) domainEntry.passed++;
      domainEntry.precisionSum += result.precisionAtK;
      domainEntry.recallSum += result.recallAtK;
      domainEntry.ndcgSum += result.ndcg;
    }

    // Aggregate by difficulty
    byDifficulty[result.difficulty] ??= { total: 0, passed: 0, precisionSum: 0, recallSum: 0 };
    const diffEntry = byDifficulty[result.difficulty];
    if (diffEntry !== undefined) {
      diffEntry.total++;
      if (result.passed) diffEntry.passed++;
      diffEntry.precisionSum += result.precisionAtK;
      diffEntry.recallSum += result.recallAtK;
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const totalPrecision = results.reduce((s, r) => s + r.precisionAtK, 0);
  const totalRecall = results.reduce((s, r) => s + r.recallAtK, 0);
  const totalNdcg = results.reduce((s, r) => s + r.ndcg, 0);
  const queryCount = results.length;

  const makeDomainSummary = (d: string) => {
    const entry = byDomain[d];
    if (entry === undefined) {
      return { total: 0, passed: 0, averagePrecision: 0, averageRecall: 0, averageNdcg: 0 };
    }
    return {
      total: entry.total,
      passed: entry.passed,
      averagePrecision: entry.total > 0 ? entry.precisionSum / entry.total : 0,
      averageRecall: entry.total > 0 ? entry.recallSum / entry.total : 0,
      averageNdcg: entry.total > 0 ? entry.ndcgSum / entry.total : 0,
    };
  };

  const makeDifficultySummary = (d: string) => {
    const entry = byDifficulty[d];
    if (entry === undefined) {
      return { total: 0, passed: 0, averagePrecision: 0, averageRecall: 0 };
    }
    return {
      total: entry.total,
      passed: entry.passed,
      averagePrecision: entry.total > 0 ? entry.precisionSum / entry.total : 0,
      averageRecall: entry.total > 0 ? entry.recallSum / entry.total : 0,
    };
  };

  const domainSummary: Record<string, ReturnType<typeof makeDomainSummary>> = {};
  for (const domain of Object.keys(byDomain)) {
    domainSummary[domain] = makeDomainSummary(domain);
  }

  const difficultySummary: Record<string, ReturnType<typeof makeDifficultySummary>> = {};
  for (const diff of Object.keys(byDifficulty)) {
    difficultySummary[diff] = makeDifficultySummary(diff);
  }

  return {
    timestamp: new Date(),
    totalQueries: queryCount,
    passed,
    failed: queryCount - passed,
    passRate: queryCount > 0 ? passed / queryCount : 0,
    averagePrecision: queryCount > 0 ? totalPrecision / queryCount : 0,
    averageRecall: queryCount > 0 ? totalRecall / queryCount : 0,
    averageNdcg: queryCount > 0 ? totalNdcg / queryCount : 0,
    byDomain: domainSummary,
    byDifficulty: difficultySummary,
    results,
  };
}

/**
 * Filter golden queries by domain.
 */
export function filterByDomain(queries: GoldenQuery[], domain: string): GoldenQuery[] {
  return queries.filter((q) => q.domain === domain);
}

/**
 * Filter golden queries by difficulty.
 */
export function filterByDifficulty(queries: GoldenQuery[], difficulty: string): GoldenQuery[] {
  return queries.filter((q) => q.difficulty === difficulty);
}
