/**
 * Deep Research Benchmark CLI — run the SimpleQA-style factuality benchmark.
 *
 * Usage:
 *   npx tsx scripts/run-benchmark.ts [options]
 *
 * Options:
 *   --depth <depth>         Research depth: quick | standard | deep (default: quick)
 *   --timeout <ms>          Per-question timeout in ms (default: 180000)
 *   --concurrency <n>       Max concurrent questions (default: 2)
 *   --domain <domain>       Filter by domain (repeatable)
 *   --difficulty <diff>     Filter by difficulty (repeatable)
 *   --deterministic         Run without LLM (pipeline strategy only)
 *   --grading-model <m>     LLM model for grading (enables LLM grading)
 *   --grading-base-url <u>  LLM base URL for grading
 *   --grading-token <t>     API token for grading LLM
 *   --output <path>         Write JSON results to path (default: stdout summary)
 *   --markdown              Output results as a Markdown table
 *   --model <model>         LLM model for research orchestrator
 *   --worker-model <model>  LLM model for research workers
 *   --base-url <url>        LLM base URL for research
 *   --api-token <token>     API token for research LLM
 *   --help                  Show help
 *
 * Environment variables:
 *   DEEP_RESEARCH_ENABLED=true (required)
 *   DEEP_RESEARCH_BASE_URL     LLM base URL for research
 *   DEEP_RESEARCH_MODEL        Orchestrator model
 *   DEEP_RESEARCH_WORKER_MODEL Worker model
 *   BENCHMARK_GRADER_MODEL     Grader LLM model
 *   BENCHMARK_GRADER_BASE_URL  Grader LLM base URL
 *   BENCHMARK_GRADER_API_TOKEN Grader API token
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { runBenchmark, filterQuestions } from '../src/benchmarks/runner.js';
import type { BenchmarkConfig, BenchmarkDomain, BenchmarkDifficulty } from '../src/benchmarks/types.js';
import type { ResearchDepth } from '../src/research/types.js';
import type { OrchestratorLlmConfig } from '../src/research/orchestrator.js';
import type { BenchmarkOutput, QuestionBenchmarkResult } from '../src/benchmarks/types.js';
import type { GraderConfig } from '../src/benchmarks/grader.js';

// ── CLI argument parsing ──────────────────────────────────────────────────

interface ParsedArgs {
  depth: ResearchDepth;
  timeout: number;
  concurrency: number;
  domains: BenchmarkDomain[];
  difficulties: BenchmarkDifficulty[];
  deterministic: boolean;
  gradingModel?: string;
  gradingBaseUrl?: string;
  gradingToken?: string;
  output?: string;
  markdown: boolean;
  model?: string;
  workerModel?: string;
  baseUrl?: string;
  apiToken?: string;
  help: boolean;
}

const VALID_DOMAINS = new Set<BenchmarkDomain>([
  'science', 'history', 'geography', 'technology', 'pop_culture',
  'sports', 'economics', 'literature', 'politics', 'biology',
  'physics', 'math', 'music', 'film', 'art',
]);

const VALID_DIFFICULTIES = new Set<BenchmarkDifficulty>(['easy', 'medium', 'hard']);

const VALID_DEPTHS = new Set<ResearchDepth>(['quick', 'standard', 'deep', 'exhaustive', 'tree']);

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    depth: 'quick',
    timeout: 180_000,
    concurrency: 2,
    domains: [],
    difficulties: [],
    deterministic: false,
    markdown: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '--depth': {
        const val = argv[++i];
        if (val && VALID_DEPTHS.has(val as ResearchDepth)) {
          args.depth = val as ResearchDepth;
        } else {
          console.error(`Invalid depth "${val}". Valid: ${[...VALID_DEPTHS].join(', ')}`);
          process.exit(1);
        }
        break;
      }
      case '--timeout': {
        const val = Number(argv[++i]);
        if (!isNaN(val) && val >= 10000) args.timeout = val;
        else { console.error('Invalid timeout. Must be >= 10000 ms.'); process.exit(1); }
        break;
      }
      case '--concurrency': {
        const val = Number(argv[++i]);
        if (!isNaN(val) && val >= 1 && val <= 10) args.concurrency = val;
        else { console.error('Invalid concurrency. Must be 1–10.'); process.exit(1); }
        break;
      }
      case '--domain': {
        const val = argv[++i];
        if (val && VALID_DOMAINS.has(val as BenchmarkDomain)) {
          args.domains.push(val as BenchmarkDomain);
        } else { console.error(`Invalid domain "${val}".`); process.exit(1); }
        break;
      }
      case '--difficulty': {
        const val = argv[++i];
        if (val && VALID_DIFFICULTIES.has(val as BenchmarkDifficulty)) {
          args.difficulties.push(val as BenchmarkDifficulty);
        } else { console.error(`Invalid difficulty "${val}".`); process.exit(1); }
        break;
      }
      case '--deterministic':
        args.deterministic = true;
        break;
      case '--grading-model': {
        const val = argv[++i];
        if (val) args.gradingModel = val;
        else { console.error('Invalid --grading-model value.'); process.exit(1); }
        break;
      }
      case '--grading-base-url': {
        const val = argv[++i];
        if (val) args.gradingBaseUrl = val;
        else { console.error('Invalid --grading-base-url value.'); process.exit(1); }
        break;
      }
      case '--grading-token': {
        const val = argv[++i];
        if (val) args.gradingToken = val;
        else { console.error('Invalid --grading-token value.'); process.exit(1); }
        break;
      }
      case '--output': {
        const val = argv[++i];
        if (val) args.output = val;
        else { console.error('Invalid --output value.'); process.exit(1); }
        break;
      }
      case '--markdown':
        args.markdown = true;
        break;
      case '--model': {
        const val = argv[++i];
        if (val) args.model = val;
        else { console.error('Invalid --model value.'); process.exit(1); }
        break;
      }
      case '--worker-model': {
        const val = argv[++i];
        if (val) args.workerModel = val;
        else { console.error('Invalid --worker-model value.'); process.exit(1); }
        break;
      }
      case '--base-url': {
        const val = argv[++i];
        if (val) args.baseUrl = val;
        else { console.error('Invalid --base-url value.'); process.exit(1); }
        break;
      }
      case '--api-token': {
        const val = argv[++i];
        if (val) args.apiToken = val;
        else { console.error('Invalid --api-token value.'); process.exit(1); }
        break;
      }
      case '--help':
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
    i++;
  }

  return args;
}

// ── Help text ─────────────────────────────────────────────────────────────

const HELP = `Deep Research Benchmark — SimpleQA-style factuality evaluation.

Usage:
  npx tsx scripts/run-benchmark.ts [options]

Options:
  --depth <depth>         Research depth: quick | standard | deep (default: quick)
  --timeout <ms>          Per-question timeout in ms (default: 180000 = 3 min)
  --concurrency <n>       Max concurrent questions (default: 2, max: 10)
  --domain <domain>       Filter by domain (repeatable). Options: science, history,
                          geography, technology, pop_culture, sports, economics,
                          literature, politics, biology, physics, math, music,
                          film, art
  --difficulty <diff>     Filter by difficulty (repeatable): easy, medium, hard
  --deterministic         Run without LLM (uses pipeline strategy, regex extraction)
  --grading-model <m>     LLM model for grading (enables LLM grading vs heuristic)
  --grading-base-url <u>  LLM base URL for grading
  --grading-token <t>     API token for grading LLM
  --output <path>         Write JSON results to file
  --markdown              Print results as a Markdown table (for README)
  --model <model>         LLM model for research orchestrator
  --worker-model <model>  LLM model for research worker
  --base-url <url>        LLM base URL for research
  --api-token <token>     API token for research LLM
  --help                  Show this help

Environment variables for LLM config:
  DEEP_RESEARCH_BASE_URL, DEEP_RESEARCH_MODEL, DEEP_RESEARCH_WORKER_MODEL
  BENCHMARK_GRADER_MODEL, BENCHMARK_GRADER_BASE_URL, BENCHMARK_GRADER_API_TOKEN

Examples:
  # Quick deterministic run (no LLM needed)
  npx tsx scripts/run-benchmark.ts --deterministic --depth quick --markdown

  # Full LLM-powered run with grading
  npx tsx scripts/run-benchmark.ts --depth standard --model gpt-4o --worker-model gpt-4o-mini \\
    --base-url https://api.openai.com --api-token sk-... \\
    --grading-model gpt-4o-mini --grading-base-url https://api.openai.com --grading-token sk-...

  # Filter to science questions only
  npx tsx scripts/run-benchmark.ts --domain science --domain biology --markdown
`;

// ── Markdown formatting ───────────────────────────────────────────────────

function formatMarkdownTable(output: BenchmarkOutput): string {
  const { metrics, config, timestamp } = output;
  const lines: string[] = [];

  lines.push('## Deep Research Benchmark Results');
  lines.push('');
  lines.push(`**Date:** ${timestamp.slice(0, 10)}`);
  lines.push(`**Depth:** \`${config.depth}\``);
  lines.push(`**Strategy:** ${config.deterministic ? 'Pipeline (deterministic)' : 'Agent (LLM)'}`);
  lines.push(`**Grading:** ${output.gradeMethod}`);
  lines.push(`**Questions:** ${String(metrics.totalQuestions)}`);
  lines.push('');

  // Summary metrics
  lines.push('### Overall Accuracy');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Accuracy | **${(metrics.accuracy * 100).toFixed(1)}%** |`);
  lines.push(`| Accuracy (given answer) | ${(metrics.accuracyGivenAnswer * 100).toFixed(1)}% |`);
  lines.push(`| Correct | ${String(metrics.correct)} |`);
  lines.push(`| Incorrect | ${String(metrics.incorrect)} |`);
  lines.push(`| Unclear | ${String(metrics.unclear)} |`);
  lines.push(`| Avg time/question | ${(metrics.avgElapsedMs / 1000).toFixed(1)}s |`);
  lines.push(`| Avg sources/question | ${metrics.avgSourceCount.toFixed(1)} |`);
  lines.push(`| Avg findings/question | ${metrics.avgFindingCount.toFixed(1)} |`);
  lines.push(`| Timed out | ${String(metrics.timedOutCount)} |`);
  lines.push(`| Errors | ${String(metrics.errorCount)} |`);
  lines.push('');

  // Per-domain breakdown (only if there are multiple domains)
  const domains = Object.entries(metrics.domainBreakdown);
  if (domains.length > 1) {
    lines.push('### By Domain');
    lines.push('');
    lines.push('| Domain | Questions | Correct | Accuracy |');
    lines.push('|--------|-----------|---------|----------|');
    for (const [domain, data] of domains.sort((a, b) => b[1].accuracy - a[1].accuracy)) {
      lines.push(`| ${domain} | ${String(data.total)} | ${String(data.correct)} | ${(data.accuracy * 100).toFixed(1)}% |`);
    }
    lines.push('');
  }

  // Per-difficulty breakdown
  const diffs = Object.entries(metrics.difficultyBreakdown);
  if (diffs.length > 1) {
    lines.push('### By Difficulty');
    lines.push('');
    lines.push('| Difficulty | Questions | Correct | Accuracy |');
    lines.push('|------------|-----------|---------|----------|');
    for (const [diff, data] of diffs.sort((a, b) => {
      const order: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
      return (order[a[0]] ?? 0) - (order[b[0]] ?? 0);
    })) {
      lines.push(`| ${diff} | ${String(data.total)} | ${String(data.correct)} | ${(data.accuracy * 100).toFixed(1)}% |`);
    }
    lines.push('');
  }

  // Per-question detail table
  lines.push('### Per-Question Results');
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Click to expand — all question results</summary>');
  lines.push('');
  lines.push('| ID | Domain | Question | Verdict | Time | Sources |');
  lines.push('|----|--------|----------|---------|------|---------|');

  for (const qr of output.questions) {
    const q = qr.question;
    const shortQ = q.question.length > 80 ? q.question.slice(0, 77) + '...' : q.question;
    const emoji = qr.grade.verdict === 'correct' ? '✅' : qr.grade.verdict === 'incorrect' ? '❌' : '⚠️';
    lines.push(
      `| ${q.id} | ${q.domain} | ${shortQ} | ${emoji} ${qr.grade.verdict} | ${(qr.elapsedMs / 1000).toFixed(1)}s | ${String(qr.sourceCount)} |`,
    );
  }

  lines.push('');
  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Benchmark schema version: ${output.version}. Run with \`npx tsx scripts/run-benchmark.ts\` to reproduce.*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Build LLM config for research
  let llmConfig: OrchestratorLlmConfig | undefined;
  const researchBaseUrl = args.baseUrl ?? process.env['DEEP_RESEARCH_BASE_URL'];
  const researchModel = args.model ?? process.env['DEEP_RESEARCH_MODEL'];
  const researchWorkerModel = args.workerModel ?? process.env['DEEP_RESEARCH_WORKER_MODEL'];

  if (!args.deterministic && researchBaseUrl && researchModel) {
    llmConfig = {
      baseUrl: researchBaseUrl,
      model: researchModel,
      workerModel: researchWorkerModel ?? researchModel,
      ...(args.apiToken ? { apiToken: args.apiToken } : {}),
    };
  } else if (!args.deterministic) {
    console.error('Error: LLM config required for non-deterministic mode.');
    console.error('  Set --base-url and --model, or DEEP_RESEARCH_BASE_URL and DEEP_RESEARCH_MODEL.');
    console.error('  Or use --deterministic for rule-based execution.');
    process.exit(1);
  }

  // Build grader config
  let graderConfig: GraderConfig | undefined;
  const gradingModel = args.gradingModel ?? process.env['BENCHMARK_GRADER_MODEL'];
  const gradingBaseUrl = args.gradingBaseUrl ?? process.env['BENCHMARK_GRADER_BASE_URL'];
  const gradingToken = args.gradingToken ?? process.env['BENCHMARK_GRADER_API_TOKEN'];

  if (gradingModel && gradingBaseUrl) {
    graderConfig = {
      model: gradingModel,
      baseUrl: gradingBaseUrl,
      ...(gradingToken ? { apiToken: gradingToken } : {}),
    };
  }

  // Build benchmark config
  const benchmarkConfig: BenchmarkConfig = {
    depth: args.depth,
    questionTimeoutMs: args.timeout,
    concurrency: args.concurrency,
    domains: args.domains.length > 0 ? args.domains : undefined,
    difficulties: args.difficulties.length > 0 ? args.difficulties : undefined,
    deterministic: args.deterministic,
    llmGrading: graderConfig !== undefined,
    graderModel: graderConfig?.model,
    graderBaseUrl: graderConfig?.baseUrl,
    graderApiToken: graderConfig?.apiToken,
  };

  const questions = filterQuestions(benchmarkConfig);

  console.error(`Starting benchmark: ${String(questions.length)} questions, depth=${args.depth}, deterministic=${String(args.deterministic)}, grading=${graderConfig ? 'llm' : 'heuristic'}`);
  console.error('');

  const output = await runBenchmark({
    config: benchmarkConfig,
    llmConfig,
    graderConfig,
    onProgress: (completed, total) => {
      console.error(`  Progress: ${String(completed)}/${String(total)}`);
    },
  });

  // Write JSON output
  if (args.output) {
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.error(`Results written to ${outPath}`);
  }

  // Print summary
  if (args.markdown) {
    console.log(formatMarkdownTable(output));
  } else {
    // Text summary
    const { metrics: m } = output;
    console.log('');
    console.log('=== Benchmark Results ===');
    console.log(`Total: ${String(m.totalQuestions)} | Accuracy: ${(m.accuracy * 100).toFixed(1)}% | Correct: ${String(m.correct)} | Incorrect: ${String(m.incorrect)} | Unclear: ${String(m.unclear)}`);
    console.log(`Avg time: ${(m.avgElapsedMs / 1000).toFixed(1)}s | Avg sources: ${m.avgSourceCount.toFixed(1)} | Grading: ${String(m.gradeMethod)}`);
    if (args.output) {
      console.log(`Full results: ${args.output}`);
    }
  }

  // Exit code based on results
  const exitCode = output.metrics.accuracy >= 0.5 ? 0 : 1;
  process.exit(exitCode);
}

// Only run when executed directly (not imported for testing)
const isMainModule = process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^\.\//, ''));

if (isMainModule) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(2);
  });
}
