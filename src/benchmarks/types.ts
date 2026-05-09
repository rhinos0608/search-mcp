/**
 * Deep Research Benchmark types — SimpleQA-inspired factuality evaluation.
 *
 * Each question has a short, unambiguous ground-truth answer. The deep research
 * tool runs against each question, and an LLM grader compares the research output
 * to the ground truth.
 */

import type { ResearchDepth, QueryClassification } from '../research/types.js';

// ── Benchmark question ──────────────────────────────────────────────────────

export type BenchmarkDomain =
  | 'science'
  | 'history'
  | 'geography'
  | 'technology'
  | 'pop_culture'
  | 'sports'
  | 'economics'
  | 'literature'
  | 'politics'
  | 'biology'
  | 'physics'
  | 'math'
  | 'music'
  | 'film'
  | 'art';

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export interface BenchmarkQuestion {
  /** Stable unique identifier (e.g. 'sci-001'). */
  id: string;
  /** The question text — factual, unambiguous. */
  question: string;
  /** The known correct answer (short, 1–2 sentences max). */
  answer: string;
  /** Domain category. */
  domain: BenchmarkDomain;
  /** Subjective difficulty rating. */
  difficulty: BenchmarkDifficulty;
  /**
   * Optional alternative acceptable phrasings.
   * For questions where multiple formulations are all correct.
   */
  altAnswers?: string[];
  /**
   * Optional key terms that must appear in a correct answer.
   * Used as a fallback heuristic when no LLM grader is configured.
   */
  requiredTerms?: string[];
}

// ── Grade result ────────────────────────────────────────────────────────────

export type GradeVerdict = 'correct' | 'incorrect' | 'unclear';

export interface GradeResult {
  questionId: string;
  verdict: GradeVerdict;
  /** LLM grader's explanation, or heuristic reasoning. */
  reasoning: string;
  /** The extracted answer from the research output. */
  extractedAnswer: string;
  /** When verdict is 'unclear', the reason (e.g. 'timeout', 'empty output'). */
  unclearReason?: string;
}

/** Grading approach used. */
export type GradeMethod = 'llm' | 'heuristic';

// ── Per-question result ─────────────────────────────────────────────────────

export interface QuestionBenchmarkResult {
  question: BenchmarkQuestion;
  /** The research depth used. */
  depth: ResearchDepth;
  /** The query classification detected by the orchestrator. */
  classification: QueryClassification | 'unknown';
  /** Total wall-clock time for this question (ms). */
  elapsedMs: number;
  /** Number of sources discovered. */
  sourceCount: number;
  /** Number of findings extracted. */
  findingCount: number;
  /** The executive summary from the research. */
  executiveSummary: string;
  /** The full narrative markdown (trimmed). */
  narrativeMarkdown: string;
  /** Timing breakdown per phase. */
  phaseTimings: Record<string, number>;
  /** Grading result. */
  grade: GradeResult;
  /** Grade method used for this question. */
  gradeMethod: GradeMethod;
  /** Whether the research timed out. */
  timedOut: boolean;
  /** Error message if the research failed. */
  error?: string;
}

// ── Aggregate metrics ───────────────────────────────────────────────────────

export interface BenchmarkMetrics {
  /** Total questions attempted. */
  totalQuestions: number;
  /** Questions graded correct. */
  correct: number;
  /** Questions graded incorrect. */
  incorrect: number;
  /** Questions graded unclear / skipped. */
  unclear: number;
  /** Accuracy = correct / total. */
  accuracy: number;
  /** Accuracy excluding unclear = correct / (total - unclear). */
  accuracyGivenAnswer: number;
  /** Average elapsed time per question (ms). */
  avgElapsedMs: number;
  /** Average number of sources per question. */
  avgSourceCount: number;
  /** Average number of findings per question. */
  avgFindingCount: number;
  /** Number of questions that timed out. */
  timedOutCount: number;
  /** Number of questions that had errors. */
  errorCount: number;
  /** Per-domain accuracy breakdown. */
  domainBreakdown: Record<BenchmarkDomain, { total: number; correct: number; accuracy: number }>;
  /** Per-difficulty accuracy breakdown. */
  difficultyBreakdown: Record<
    BenchmarkDifficulty,
    { total: number; correct: number; accuracy: number }
  >;
  /** Per-depth accuracy breakdown (when multiple depths run). */
  depthBreakdown: Record<string, { total: number; correct: number; accuracy: number }>;
  /** Grading method used. */
  gradeMethod: GradeMethod;
}

// ── Full benchmark output ───────────────────────────────────────────────────

export interface BenchmarkOutput {
  /** Schema version for future compatibility. */
  version: '1.0.0';
  /** When the benchmark was run (ISO 8601). */
  timestamp: string;
  /** Configuration used. */
  config: BenchmarkConfig;
  /** Grading method actually used. */
  gradeMethod: GradeMethod;
  /** Aggregate metrics. */
  metrics: BenchmarkMetrics;
  /** Per-question detailed results. */
  questions: QuestionBenchmarkResult[];
}

// ── Benchmark configuration ─────────────────────────────────────────────────

export interface BenchmarkConfig {
  /** Research depth. */
  depth: ResearchDepth;
  /** Max time per question (ms). */
  questionTimeoutMs: number;
  /** Number of questions to run concurrently. */
  concurrency: number;
  /** Domain filter — only run questions from these domains. */
  domains?: BenchmarkDomain[];
  /** Difficulty filter — only run questions of these difficulties. */
  difficulties?: BenchmarkDifficulty[];
  /** Whether to use deterministic mode (no LLM calls for research). */
  deterministic: boolean;
  /** Whether to use LLM grading (vs heuristic keyword match). */
  llmGrading: boolean;
  /** LLM model for grading. When undefined, heuristic fallback is used. */
  graderModel?: string;
  /** LLM base URL for grading. */
  graderBaseUrl?: string;
  /** LLM API token for grading. */
  graderApiToken?: string;
}
