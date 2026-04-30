/**
 * Phase 5 — Evaluation Framework: Runner
 *
 * Orchestrates offline evaluation runs against golden queries.
 * Supports both recorded (fixture-based) and live API modes.
 */

import { runEvaluation } from './metrics.js';
import { getAllQueries, getQueriesByDomain } from './golden-queries/index.js';
import type { GoldenQuery, RetrievalAPI, EvalSummary, CorpusSnapshot } from './metrics.js';

// ── Fixture-based (offline) runner ──────────────────────────────────────────

export interface OfflineRetrievalResult {
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface OfflineRetrievalResponse {
  results: OfflineRetrievalResult[];
}

export type OfflineRetrievalFn = (
  query: string,
  topK: number,
  corpusSnapshot: CorpusSnapshot,
) => OfflineRetrievalResponse;

/**
 * Create a RetrievalAPI from a corpus snapshot and retrieval function.
 * Useful for offline/recorded eval in CI.
 */
export function createOfflineAPI(
  corpusSnapshot: CorpusSnapshot,
  retrieveFn: OfflineRetrievalFn,
): RetrievalAPI {
  return {
    retrieve: (_query: string, _topK = 10) => {
      const response = retrieveFn(_query, _topK, corpusSnapshot);
      // Ensure score type compatibility
      const results = response.results.map((r) => {
        const result: { text: string; score?: number; metadata?: Record<string, unknown> } = {
          text: r.text,
        };
        if (r.score !== undefined) {
          result.score = r.score;
        }
        if (r.metadata !== undefined) {
          result.metadata = r.metadata;
        }
        return result;
      });
      return Promise.resolve({ results });
    },
  };
}

/**
 * Run offline evaluation against a corpus snapshot.
 */
export async function runOfflineEval(
  corpusSnapshot: CorpusSnapshot,
  retrieveFn: OfflineRetrievalFn,
  options?: {
    domains?: string[] | undefined;
    difficulties?: string[] | undefined;
    topK?: number | undefined;
    queries?: GoldenQuery[] | undefined;
  },
): Promise<EvalSummary> {
  let queries: GoldenQuery[];

  if (options?.queries) {
    queries = options.queries;
  } else if (options?.domains && options.domains.length > 0) {
    queries = options.domains.flatMap((d) => getQueriesByDomain(d));
  } else {
    queries = getAllQueries();
  }

  // Filter by difficulty if specified
  if (options?.difficulties && options.difficulties.length > 0) {
    const difficulties = options.difficulties;
    queries = queries.filter((q) => difficulties.includes(q.difficulty));
  }

  const api = createOfflineAPI(corpusSnapshot, retrieveFn);
  return runEvaluation(queries, api, options?.topK ?? 10);
}

// ── Live API runner ─────────────────────────────────────────────────────────

/**
 * Create a RetrievalAPI from a live retrieval function.
 * Used for optional live evals outside CI.
 */
export function createLiveAPI(
  retrieveFn: (
    query: string,
    topK: number,
  ) => Promise<{
    results: { text: string; score?: number; metadata?: Record<string, unknown> }[];
  }>,
): RetrievalAPI {
  return {
    retrieve: async (query: string, topK = 10) => {
      return retrieveFn(query, topK);
    },
  };
}

/**
 * Run live evaluation against a retrieval function.
 */
export async function runLiveEval(
  retrieveFn: (
    query: string,
    topK: number,
  ) => Promise<{
    results: { text: string; score?: number; metadata?: Record<string, unknown> }[];
  }>,
  options?: {
    domains?: string[] | undefined;
    difficulties?: string[] | undefined;
    topK?: number | undefined;
    queries?: GoldenQuery[] | undefined;
  },
): Promise<EvalSummary> {
  let queries: GoldenQuery[];

  if (options?.queries) {
    queries = options.queries;
  } else if (options?.domains && options.domains.length > 0) {
    queries = options.domains.flatMap((d) => getQueriesByDomain(d));
  } else {
    queries = getAllQueries();
  }

  // Filter by difficulty if specified
  if (options?.difficulties && options.difficulties.length > 0) {
    const difficulties = options.difficulties;
    queries = queries.filter((q) => difficulties.includes(q.difficulty));
  }

  const api = createLiveAPI(retrieveFn);
  return runEvaluation(queries, api, options?.topK ?? 10);
}

// ── Summary formatting ──────────────────────────────────────────────────────

interface DomainSummary {
  total: number;
  passed: number;
  averagePrecision: number;
  averageRecall: number;
  averageNdcg: number;
}

interface DifficultySummary {
  total: number;
  passed: number;
  averagePrecision: number;
  averageRecall: number;
}

/**
 * Format an EvalSummary as a human-readable string.
 */
export function formatEvalSummary(summary: EvalSummary): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════');
  lines.push('  EVALUATION SUMMARY');
  lines.push('═══════════════════════════════════════════');
  lines.push('');
  lines.push(`  Timestamp:   ${summary.timestamp.toISOString()}`);
  lines.push(`  Queries:     ${String(summary.totalQueries)}`);
  lines.push(`  Passed:      ${String(summary.passed)}`);
  lines.push(`  Failed:      ${String(summary.failed)}`);
  lines.push(`  Pass Rate:   ${(summary.passRate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('  ── Averages ───────────────────────────────');
  lines.push(`  Precision@10: ${(summary.averagePrecision * 100).toFixed(1)}%`);
  lines.push(`  Recall@10:    ${(summary.averageRecall * 100).toFixed(1)}%`);
  lines.push(`  nDCG@10:      ${(summary.averageNdcg * 100).toFixed(1)}%`);
  lines.push('');

  const domainNames = Object.keys(summary.byDomain);
  if (domainNames.length > 0) {
    lines.push('  ── By Domain ───────────────────────────────');
    for (const domain of domainNames.sort()) {
      const d = summary.byDomain[domain] as DomainSummary | undefined;
      if (d === undefined) continue;
      lines.push(
        `  ${domain.padEnd(15)} ` +
          `${String(d.passed)}/${String(d.total)} ` +
          `P@10:${(d.averagePrecision * 100).toFixed(1)}% ` +
          `R@10:${(d.averageRecall * 100).toFixed(1)}% ` +
          `nDCG:${(d.averageNdcg * 100).toFixed(1)}%`,
      );
    }
    lines.push('');
  }

  const diffNames = Object.keys(summary.byDifficulty);
  if (diffNames.length > 0) {
    lines.push('  ── By Difficulty ────────────────────────────');
    for (const diff of diffNames.sort()) {
      const d = summary.byDifficulty[diff] as DifficultySummary | undefined;
      if (d === undefined) continue;
      lines.push(
        `  ${diff.padEnd(10)} ` +
          `${String(d.passed)}/${String(d.total)} ` +
          `P@10:${(d.averagePrecision * 100).toFixed(1)}% ` +
          `R@10:${(d.averageRecall * 100).toFixed(1)}%`,
      );
    }
    lines.push('');
  }

  lines.push('  ── Individual Results ───────────────────────');
  for (const result of summary.results) {
    const status = result.passed ? '✓' : '✗';
    lines.push(
      `  ${status} ${result.queryId.padEnd(10)} ` +
        `P@10:${(result.precisionAtK * 100).toFixed(1)}% ` +
        `R@10:${(result.recallAtK * 100).toFixed(1)}% ` +
        `nDCG:${(result.ndcg * 100).toFixed(1)}% ` +
        `(relevant: ${String(result.relevantFound)}/${String(result.numRelevant)})`,
    );
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════');

  return lines.join('\n');
}

export type { RetrievalAPI };
export type {
  GoldenQuery,
  EvalResult,
  EvalSummary,
  CorpusSnapshot,
  CorpusSnapshotChunk,
} from './metrics.js';
