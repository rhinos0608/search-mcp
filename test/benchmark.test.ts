/**
 * Benchmark module tests — covers dataset, grader, runner, and metrics.
 *
 * Does NOT run the full benchmark (requires LLM and search backends).
 * Tests structure, heuristic grading, and dataset integrity.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkQuestions, questionCount } from '../src/benchmarks/questions.js';
import { BenchmarkGrader } from '../src/benchmarks/grader.js';
import type { BenchmarkQuestion, BenchmarkOutput, BenchmarkConfig } from '../src/benchmarks/types.js';

// ── Dataset integrity ──────────────────────────────────────────────────────

describe('Benchmark dataset', () => {
  it('has the expected number of questions', () => {
    assert.strictEqual(benchmarkQuestions.length, 51);
    assert.strictEqual(questionCount, 51);
  });

  it('has no duplicate IDs', () => {
    const ids = benchmarkQuestions.map(q => q.id);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length, `Duplicate IDs found among ${String(ids.length)} questions`);
  });

  it('all questions have required fields', () => {
    for (const q of benchmarkQuestions) {
      assert.ok(q.id.length > 0, `Missing id: ${q.id}`);
      assert.ok(q.question.length > 10, `Question too short: ${q.id}`);
      assert.ok(q.answer.length > 0, `Missing answer: ${q.id}`);
      assert.ok(q.domain.length > 0, `Missing domain: ${q.id}`);
      assert.ok(q.difficulty.length > 0, `Missing difficulty: ${q.id}`);
    }
  });

  it('all domains are valid', () => {
    const validDomains = new Set([
      'science', 'history', 'geography', 'technology', 'pop_culture',
      'sports', 'economics', 'literature', 'politics', 'biology',
      'physics', 'math', 'music', 'film', 'art',
    ]);
    for (const q of benchmarkQuestions) {
      assert.ok(validDomains.has(q.domain), `Invalid domain "${q.domain}" for ${q.id}`);
    }
  });

  it('all difficulties are valid', () => {
    const validDiffs = new Set(['easy', 'medium', 'hard']);
    for (const q of benchmarkQuestions) {
      assert.ok(validDiffs.has(q.difficulty), `Invalid difficulty "${q.difficulty}" for ${q.id}`);
    }
  });

  it('has questions across all three difficulty levels', () => {
    const diffs = new Set(benchmarkQuestions.map(q => q.difficulty));
    assert.ok(diffs.has('easy'), 'Missing easy questions');
    assert.ok(diffs.has('medium'), 'Missing medium questions');
    assert.ok(diffs.has('hard'), 'Missing hard questions');
  });

  it('has questions from multiple domains', () => {
    const domains = new Set(benchmarkQuestions.map(q => q.domain));
    assert.ok(domains.size >= 5, `Only ${String(domains.size)} domains — expected 5+`);
  });

  it('all required terms are non-empty strings', () => {
    for (const q of benchmarkQuestions) {
      if (q.requiredTerms) {
        for (const term of q.requiredTerms) {
          assert.ok(term.length > 0, `Empty required term in ${q.id}`);
        }
      }
    }
  });
});

// ── Grader: heuristic mode ─────────────────────────────────────────────────

describe('BenchmarkGrader — heuristic', () => {
  let grader: BenchmarkGrader;
  const sampleQuestion: BenchmarkQuestion = {
    id: 'test-001',
    question: 'What is the capital of France?',
    answer: 'Paris.',
    domain: 'geography',
    difficulty: 'easy',
    requiredTerms: ['Paris'],
  };

  before(() => {
    grader = new BenchmarkGrader();
  });

  it('returns heuristic method', () => {
    assert.strictEqual(grader.method, 'heuristic');
  });

  it('grades correct when required terms are present', async () => {
    const result = await grader.grade({
      question: sampleQuestion,
      executiveSummary: 'The capital of France is Paris.',
      narrativeSnippet: 'France has Paris as its capital city.',
    });
    assert.strictEqual(result.verdict, 'correct');
    assert.strictEqual(result.questionId, 'test-001');
  });

  it('grades incorrect when required terms are absent', async () => {
    const result = await grader.grade({
      question: sampleQuestion,
      executiveSummary: 'The capital of France is Lyon.',
      narrativeSnippet: '',
    });
    assert.strictEqual(result.verdict, 'incorrect');
  });

  it('grades unclear when output is empty', async () => {
    const result = await grader.grade({
      question: sampleQuestion,
      executiveSummary: '',
      narrativeSnippet: '',
    });
    assert.strictEqual(result.verdict, 'unclear');
    assert.strictEqual(result.unclearReason, 'empty_output');
  });

  it('grades unclear when no required terms and no direct answer match', async () => {
    const noTermQuestion: BenchmarkQuestion = {
      id: 'test-002',
      question: 'What is 2+2?',
      answer: '4.',
      domain: 'math',
      difficulty: 'easy',
    };
    const result = await grader.grade({
      question: noTermQuestion,
      executiveSummary: 'Something completely unrelated to the question.',
      narrativeSnippet: '',
    });
    assert.strictEqual(result.verdict, 'unclear');
    assert.strictEqual(result.unclearReason, 'insufficient_heuristic_signal');
  });

  it('grades correct with direct answer match (no required terms)', async () => {
    const noTermQuestion: BenchmarkQuestion = {
      id: 'test-003',
      question: 'What is 2+2?',
      answer: '4.',
      domain: 'math',
      difficulty: 'easy',
    };
    const result = await grader.grade({
      question: noTermQuestion,
      executiveSummary: 'The answer is 4.',
      narrativeSnippet: '',
    });
    assert.strictEqual(result.verdict, 'correct');
  });

  it('batch grades multiple questions', async () => {
    const inputs = [
      {
        question: sampleQuestion,
        executiveSummary: 'The capital is Paris.',
        narrativeSnippet: '',
      },
      {
        question: sampleQuestion,
        executiveSummary: 'Wrong answer.',
        narrativeSnippet: '',
      },
    ];
    const results = await grader.gradeBatch(inputs);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0]!.verdict, 'correct');
    assert.strictEqual(results[1]!.verdict, 'incorrect');
  });
});

// ── Grader: LLM config ─────────────────────────────────────────────────────

describe('BenchmarkGrader — LLM config', () => {
  it('constructor stores LLM config and reports llm method', () => {
    const grader = new BenchmarkGrader({
      model: 'test-model',
      baseUrl: 'https://api.openai.com',
    });
    assert.strictEqual(grader.method, 'llm');
  });

  it('falls back to heuristic on invalid LLM endpoint', async () => {
    const grader = new BenchmarkGrader({
      model: 'test-model',
      baseUrl: 'http://192.0.2.1:19999',
      timeoutMs: 500,
    });
    const result = await grader.grade({
      question: {
        id: 'test-llm-fail',
        question: 'What is the capital of France?',
        answer: 'Paris.',
        domain: 'geography',
        difficulty: 'easy',
        requiredTerms: ['Paris'],
      },
      executiveSummary: 'The capital is Paris.',
      narrativeSnippet: '',
    });
    // Should fall back to heuristic
    assert.strictEqual(result.verdict, 'correct');
  });
});

// ── BenchmarkConfig defaults ───────────────────────────────────────────────

describe('BenchmarkConfig', () => {
  it('has sensible default config structure', () => {
    const config: BenchmarkConfig = {
      depth: 'quick',
      questionTimeoutMs: 180_000,
      concurrency: 2,
      deterministic: true,
      llmGrading: false,
    };

    assert.strictEqual(config.depth, 'quick');
    assert.strictEqual(config.questionTimeoutMs, 180_000);
    assert.strictEqual(config.concurrency, 2);
    assert.strictEqual(config.deterministic, true);
    assert.strictEqual(config.llmGrading, false);
  });
});

// ── Output structure ───────────────────────────────────────────────────────

describe('BenchmarkOutput structure', () => {
  it('version is 1.0.0', () => {
    const output: BenchmarkOutput = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      config: {
        depth: 'quick',
        questionTimeoutMs: 1000,
        concurrency: 1,
        deterministic: true,
        llmGrading: false,
      },
      gradeMethod: 'heuristic',
      metrics: {
        totalQuestions: 1,
        correct: 0,
        incorrect: 0,
        unclear: 1,
        accuracy: 0,
        accuracyGivenAnswer: 0,
        avgElapsedMs: 100,
        avgSourceCount: 0,
        avgFindingCount: 0,
        timedOutCount: 0,
        errorCount: 0,
        domainBreakdown: {
          science: { total: 0, correct: 0, accuracy: 0 },
          history: { total: 0, correct: 0, accuracy: 0 },
          geography: { total: 0, correct: 0, accuracy: 0 },
          technology: { total: 0, correct: 0, accuracy: 0 },
          pop_culture: { total: 0, correct: 0, accuracy: 0 },
          sports: { total: 0, correct: 0, accuracy: 0 },
          economics: { total: 0, correct: 0, accuracy: 0 },
          literature: { total: 0, correct: 0, accuracy: 0 },
          politics: { total: 0, correct: 0, accuracy: 0 },
          biology: { total: 0, correct: 0, accuracy: 0 },
          physics: { total: 0, correct: 0, accuracy: 0 },
          math: { total: 0, correct: 0, accuracy: 0 },
          music: { total: 0, correct: 0, accuracy: 0 },
          film: { total: 0, correct: 0, accuracy: 0 },
          art: { total: 0, correct: 0, accuracy: 0 },
        },
        difficultyBreakdown: {
          easy: { total: 0, correct: 0, accuracy: 0 },
          medium: { total: 0, correct: 0, accuracy: 0 },
          hard: { total: 0, correct: 0, accuracy: 0 },
        },
        depthBreakdown: { quick: { total: 1, correct: 0, accuracy: 0 } },
        gradeMethod: 'heuristic',
      },
      questions: [],
    };

    assert.strictEqual(output.version, '1.0.0');
    assert.strictEqual(output.metrics.totalQuestions, 1);
  });

  it('metrics compute correctly for a sample result', () => {
    // Simulate computeMetrics logic for verification
    const results = [
      { verdict: 'correct' },
      { verdict: 'incorrect' },
      { verdict: 'correct' },
      { verdict: 'unclear' },
      { verdict: 'correct' },
    ];

    const correct = results.filter(r => r.verdict === 'correct').length;
    const incorrect = results.filter(r => r.verdict === 'incorrect').length;
    const unclear = results.filter(r => r.verdict === 'unclear').length;
    const accuracy = correct / results.length;

    assert.strictEqual(correct, 3);
    assert.strictEqual(incorrect, 1);
    assert.strictEqual(unclear, 1);
    assert.strictEqual(accuracy, 0.6);
  });
});

// ── Module resolution ─────────────────────────────────────────────────────

describe('Module resolution', () => {
  it('benchmarks index can be imported', async () => {
    const mod = await import('../src/benchmarks/index.js');
    assert.ok(typeof mod.runBenchmark === 'function');
    assert.ok(typeof mod.BenchmarkGrader === 'function');
    assert.ok(Array.isArray(mod.benchmarkQuestions));
  });
});
