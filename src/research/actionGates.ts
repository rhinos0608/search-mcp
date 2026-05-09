import type { Gate, ResearchState, EvaluationResult } from './types.js';

interface GateComputationParams {
  state: ResearchState;
  step: number;
  lastEvaluation?: EvaluationResult;
  /** Number of extractions completed since the last evaluation (delta, not total). */
  extractedSinceLastEval?: number;
  budget: {
    toolCallsUsed: number;
    maxToolCalls: number;
    tokensUsed: number;
    maxTokens: number;
    extractionsUsed: number;
    maxExtractions: number;
    gapLoopsUsed: number;
    maxGapLoops: number;
    startTime: number;
    maxTimeMs: number;
  };
  sourceStats: {
    pending: number;
    extracted: number;
    failed: number;
  };
  activeGap?: { id: string; attempts: number };
}

/** Compute the set of legal actions for the current iteration. */
export function computeGates(params: GateComputationParams): Gate[] {
  const { state, lastEvaluation, extractedSinceLastEval, budget, sourceStats, activeGap } = params;

  const elapsed = Date.now() - budget.startTime;
  const budgetPctRemaining = {
    toolCalls: 1 - budget.toolCallsUsed / budget.maxToolCalls,
    tokens: 1 - budget.tokensUsed / budget.maxTokens,
    extractions: 1 - budget.extractionsUsed / budget.maxExtractions,
    gapLoops: 1 - budget.gapLoopsUsed / budget.maxGapLoops,
    time: 1 - elapsed / budget.maxTimeMs,
  };

  const isNearExhaustion = Object.values(budgetPctRemaining).some((p) => p < 0.1);
  const pendingSources = sourceStats.pending;
  const noActiveGaps =
    state.gaps.filter((g) => g.status === 'open' || g.status === 'in_progress').length === 0;
  const unansweredQuestions = state.subQuestions.filter(
    (sq) => sq.status === 'pending' || sq.status === 'low_confidence',
  ).length;

  // answer: blocked after failed eval unless new evidence arrived
  let answerAllowed = true;
  let answerReason: string | undefined;
  if (lastEvaluation && !lastEvaluation.pass) {
    const extractedDelta = extractedSinceLastEval ?? sourceStats.extracted;
    const hasNewEvidence =
      activeGap !== undefined && (extractedDelta > 0 || sourceStats.pending > 0);
    if (!hasNewEvidence) {
      answerAllowed = false;
      answerReason = 'Previous answer failed evaluation and no new evidence has been added';
    }
  }

  // discover: blocked when source backlog is large
  let discoverAllowed = true;
  let discoverReason: string | undefined;
  if (pendingSources > 20) {
    discoverAllowed = false;
    discoverReason = 'Pending source backlog exceeds 20 — prefer extract before discover';
  }
  if (budgetPctRemaining.toolCalls < 0.15) {
    discoverAllowed = false;
    discoverReason = 'Budget too low for discovery — prefer synthesize or extract existing';
  }

  // extract: blocked for the whole batch only if low-yield from the SAME batch
  let extractAllowed = true;
  let extractReason: string | undefined;
  if (pendingSources === 0) {
    extractAllowed = false;
    extractReason = 'No pending sources to extract';
  }
  if (budgetPctRemaining.time < 0.05) {
    extractAllowed = false;
    extractReason = 'Time budget near exhaustion — prefer synthesize';
  }

  // generate_queries: allowed when unanswered questions remain and budget permits
  let generateQueriesAllowed = true;
  let generateQueriesReason: string | undefined;
  if (unansweredQuestions === 0) {
    generateQueriesAllowed = false;
    generateQueriesReason = 'No unanswered questions remain';
  }
  if (budgetPctRemaining.toolCalls < 0.2) {
    generateQueriesAllowed = false;
    generateQueriesReason = 'Budget too low for query generation';
  }

  // synthesize: always allowed but reason provided if forced
  let synthesizeReason: string | undefined;
  if (isNearExhaustion) {
    synthesizeReason = 'Budget near exhaustion — synthesize is recommended';
  }

  // decompose: allowed when taxonomy is not yet set or needs revision
  let decomposeAllowed = true;
  let decomposeReason: string | undefined;
  if (state.subQuestions.length > 0 && state.currentPhase !== 'taxonomy_revision') {
    decomposeAllowed = false;
    decomposeReason = 'Taxonomy already exists';
  }

  // fill_gaps: allowed when open gaps exist and budget permits
  let fillGapsAllowed = true;
  let fillGapsReason: string | undefined;
  const openGaps = state.gaps.filter((g) => g.status === 'open' || g.status === 'in_progress');
  if (openGaps.length === 0) {
    fillGapsAllowed = false;
    fillGapsReason = 'No open gaps to fill';
  }
  if (budgetPctRemaining.toolCalls < 0.1) {
    fillGapsAllowed = false;
    fillGapsReason = 'Budget too low for gap filling';
  }

  // contradiction_scan: allowed when multiple findings exist
  const contradictionScanAllowed = state.findings.length >= 3;

  const gates: Gate[] = [
    {
      action: 'answer',
      allowed: answerAllowed,
      ...(answerReason !== undefined ? { reason: answerReason } : {}),
    },
    {
      action: 'decompose',
      allowed: decomposeAllowed,
      ...(decomposeReason !== undefined ? { reason: decomposeReason } : {}),
    },
    {
      action: 'discover',
      allowed: discoverAllowed,
      ...(discoverReason !== undefined ? { reason: discoverReason } : {}),
    },
    {
      action: 'extract',
      allowed: extractAllowed,
      ...(extractReason !== undefined ? { reason: extractReason } : {}),
    },
    {
      action: 'fill_gaps',
      allowed: fillGapsAllowed,
      ...(fillGapsReason !== undefined ? { reason: fillGapsReason } : {}),
    },
    {
      action: 'generate_queries',
      allowed: generateQueriesAllowed,
      ...(generateQueriesReason !== undefined ? { reason: generateQueriesReason } : {}),
    },
    { action: 'contradiction_scan', allowed: contradictionScanAllowed },
    { action: 'audit', allowed: true },
    {
      action: 'synthesize',
      allowed: true,
      ...(synthesizeReason !== undefined ? { reason: synthesizeReason } : {}),
    },
    { action: 'complete', allowed: isNearExhaustion || noActiveGaps },
  ];

  return gates;
}
