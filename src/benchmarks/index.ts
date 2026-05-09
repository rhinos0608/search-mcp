/**
 * Deep Research Benchmark — SimpleQA-inspired factuality evaluation.
 *
 * Public API surface.
 */

export { runBenchmark } from './runner.js';
export type { RunBenchmarkOptions } from './runner.js';
export { BenchmarkGrader } from './grader.js';
export type { GraderConfig, GradingInput } from './grader.js';
export { benchmarkQuestions, questionCount } from './questions.js';
export type {
  BenchmarkQuestion,
  BenchmarkOutput,
  BenchmarkMetrics,
  BenchmarkConfig,
  QuestionBenchmarkResult,
  GradeResult,
  GradeVerdict,
  GradeMethod,
  BenchmarkDomain,
  BenchmarkDifficulty,
} from './types.js';
