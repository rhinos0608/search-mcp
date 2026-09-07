import type {
  EvalLabel,
  EvalQuery,
  FrozenCorpus,
  GradedLabel,
  GradedRelevance,
  PairwiseLabel,
  QueryMetrics,
  RankedItem,
  SuiteMetrics,
} from './types.js';

// ---------------------------------------------------------------------------
// Individual metric functions
// ---------------------------------------------------------------------------

/** Precision@k: fraction of top-k retrieved that are relevant. */
export function precisionAtK(
  retrieved: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) return 0;
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  let hits = 0;
  for (const item of top) {
    if (relevant.has(item.documentId)) hits++;
  }
  return hits / top.length;
}

/** Recall@k: fraction of all relevant docs that appear in top-k. */
export function recallAtK(
  retrieved: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let hits = 0;
  for (const item of top) {
    if (relevant.has(item.documentId)) hits++;
  }
  return hits / relevant.size;
}

/** Graded nDCG@k. Unlabeled documents are excluded from DCG (not treated as 0). */
export function ndcgAtK(
  retrieved: readonly RankedItem[],
  grades: ReadonlyMap<string, GradedRelevance>,
  k: number,
): number {
  if (k <= 0) return 0;

  // Build list of (grade, isLabeled) for top-k
  const rankedGrades: number[] = [];
  for (const item of retrieved.slice(0, k)) {
    const g = grades.get(item.documentId);
    if (g !== undefined) rankedGrades.push(g);
  }

  if (rankedGrades.length === 0) return 0;

  // DCG
  let dcg = 0;
  for (let i = 0; i < rankedGrades.length; i++) {
    dcg += (rankedGrades[i] ?? 0) / Math.log2(i + 2);
  }

  // IDCG: ideal ordering is all labeled docs sorted descending
  const ideal = [...grades.values()].sort((a, b) => b - a);
  const idealLen = Math.min(k, ideal.length);
  let idcg = 0;
  for (let i = 0; i < idealLen; i++) {
    idcg += (ideal[i] ?? 0) / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

/** Fixed-budget recall: recall at the query's declared candidate cap. */
export function fixedBudgetRecall(
  retrieved: readonly RankedItem[],
  relevant: ReadonlySet<string>,
  budget: number,
): number {
  return recallAtK(retrieved, relevant, budget);
}

/** Pairwise accuracy: fraction of pairs where system ranks preferred above other. */
export function pairwiseAccuracy(
  retrieved: readonly RankedItem[],
  pairs: readonly PairwiseLabel[],
): number {
  if (pairs.length === 0) return 0;
  const rankMap = new Map<string, number>();
  for (const item of retrieved) {
    rankMap.set(item.documentId, item.rank);
  }
  let wins = 0;
  for (const pair of pairs) {
    const prefRank = rankMap.get(pair.preferredDocumentId);
    const otherRank = rankMap.get(pair.otherDocumentId);
    // Unranked document counts as loss
    if (prefRank !== undefined && (otherRank === undefined || prefRank < otherRank)) {
      wins++;
    }
  }
  return wins / pairs.length;
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function gradeFromBinary(relevant: boolean): GradedRelevance {
  return relevant ? 3 : 0;
}

// ---------------------------------------------------------------------------
// evaluateQuery
// ---------------------------------------------------------------------------

export function evaluateQuery(
  query: EvalQuery,
  retrieved: readonly RankedItem[],
  labels: readonly EvalLabel[],
): QueryMetrics {
  // Partition labels for this query
  const binaryLabels = labels.filter(
    (l): l is Extract<EvalLabel, { kind: 'binary' }> =>
      l.kind === 'binary' && l.queryId === query.queryId,
  );
  const gradedLabels = labels.filter(
    (l): l is GradedLabel => l.kind === 'graded' && l.queryId === query.queryId,
  );
  const pairwiseLabels = labels.filter(
    (l): l is PairwiseLabel => l.kind === 'pairwise' && l.queryId === query.queryId,
  );

  // Build binary relevant set
  const relevant = new Set<string>();
  for (const l of binaryLabels) {
    if (l.relevant) relevant.add(l.documentId);
  }

  // Build grades map (graded takes precedence over binary mapping)
  const grades = new Map<string, GradedRelevance>();
  for (const l of gradedLabels) {
    grades.set(l.documentId, l.grade);
  }
  // Map binary to grades where graded doesn't cover
  for (const l of binaryLabels) {
    if (!grades.has(l.documentId)) {
      grades.set(l.documentId, gradeFromBinary(l.relevant));
    }
  }

  const labeledRelevantCount = binaryLabels.filter((l) => l.relevant).length;

  // Count unlabeled: documents in retrieved that have no label at all
  const labeledDocIds = new Set<string>();
  for (const l of binaryLabels) labeledDocIds.add(l.documentId);
  for (const l of gradedLabels) labeledDocIds.add(l.documentId);
  let unlabeledCount = 0;
  for (const item of retrieved) {
    if (!labeledDocIds.has(item.documentId)) unlabeledCount++;
  }

  // Precision@10 uses only labeled docs in denominator (binary relevant)
  // Actually per contract: P@10 = |{ d in R[1..10] : relevant(d) }| / min(10, |R|)
  // But |R| is the total number of retrieved items (including unlabeled)
  // Re-reading: P@10 = |{ d in R[1..10] : relevant(d) }| / min(10, |R|)
  // This uses the full retrieved list size
  const p10 = precisionAtK(retrieved, relevant, query.kPrecision);

  // Recall@20 uses labeled relevant as denominator
  const r20 = recallAtK(retrieved, relevant, query.kRecall);

  const ndcg = ndcgAtK(retrieved, grades, query.kNdcg);

  const fbr = fixedBudgetRecall(retrieved, relevant, query.fixedBudget);

  // Pairwise accuracy
  let pwAcc: number | undefined;
  if (pairwiseLabels.length > 0) {
    pwAcc = pairwiseAccuracy(retrieved, pairwiseLabels);
  }

  const base: QueryMetrics = {
    queryId: query.queryId,
    category: query.category,
    split: query.split,
    precisionAt10: p10,
    recallAt20: r20,
    ndcgAt10: ndcg,
    fixedBudgetRecall: fbr,
    unlabeledCount,
    labeledRelevantCount,
  };
  if (pwAcc !== undefined) {
    base.pairwiseAccuracy = pwAcc;
  }
  return base;
}

// ---------------------------------------------------------------------------
// evaluateSuite
// ---------------------------------------------------------------------------

export function evaluateSuite(
  corpus: FrozenCorpus,
  retrieve: (query: EvalQuery) => RankedItem[],
  split: 'test' = 'test',
): SuiteMetrics {
  const testQueries = corpus.queries.filter((q) => q.split === split);
  const perQuery = testQueries.map((q) => evaluateQuery(q, retrieve(q), corpus.labels));

  // Macro averages
  const mean = (vals: number[]): number =>
    vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;

  const macroP = mean(perQuery.map((q) => q.precisionAt10));
  const macroR = mean(perQuery.map((q) => q.recallAt20));
  const macroN = mean(perQuery.map((q) => q.ndcgAt10));
  const macroF = mean(perQuery.map((q) => q.fixedBudgetRecall));

  // Pairwise: only if at least one query has it
  const pwValues = perQuery
    .map((q) => q.pairwiseAccuracy)
    .filter((v): v is number => v !== undefined);
  const macroPwRaw = pwValues.length > 0 ? mean(pwValues) : undefined;

  // By category
  const byCategory: SuiteMetrics['byCategory'] = {};
  const byCatMap = new Map<string, QueryMetrics[]>();
  for (const qm of perQuery) {
    let arr = byCatMap.get(qm.category);
    if (!arr) {
      arr = [];
      byCatMap.set(qm.category, arr);
    }
    arr.push(qm);
  }
  for (const [cat, metrics] of byCatMap) {
    byCategory[cat] = metrics;
  }

  return {
    corpusId: corpus.manifest.corpusId,
    suiteId: corpus.manifest.suiteId,
    suiteVersion: corpus.manifest.suiteVersion,
    manifestHash: corpus.manifest.manifestHash,
    split: 'test',
    queryCount: testQueries.length,
    macro: {
      precisionAt10: macroP,
      recallAt20: macroR,
      ndcgAt10: macroN,
      fixedBudgetRecall: macroF,
      ...(macroPwRaw !== undefined ? { pairwiseAccuracy: macroPwRaw } : {}),
    },
    byCategory,
    perQuery,
  };
}
