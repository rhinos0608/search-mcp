/**
 * Deep Research Benchmark grader — determines whether research output matches
 * ground truth answers.
 *
 * Two grading strategies:
 * 1. **LLM grading** (default when config provided): sends the question, ground
 *    truth, and research output to an LLM for binary correctness judgment.
 * 2. **Heuristic grading** (fallback): checks if required terms appear in the
 *    research output using case-insensitive substring matching.
 */

import { logger } from '../logger.js';
import { callOpenAiChatCompletion } from '../utils/llmChat.js';
import type { BenchmarkQuestion, GradeResult, GradeVerdict, GradeMethod } from './types.js';

// ── Grader configuration ───────────────────────────────────────────────────

export interface GraderConfig {
  /** LLM model for grading (e.g. 'gpt-4o-mini'). */
  model: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Optional API token. */
  apiToken?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

// ── Grading input ──────────────────────────────────────────────────────────

export interface GradingInput {
  question: BenchmarkQuestion;
  /** The executive summary from the research result. */
  executiveSummary: string;
  /** The first 2000 characters of the narrative markdown. */
  narrativeSnippet: string;
}

// ── LLM grading prompt ─────────────────────────────────────────────────────

const GRADER_SYSTEM_PROMPT = `You are a factuality grader for a deep research benchmark. Your job is to determine whether a research system's output correctly answers a factual question, given the known ground truth answer.

Rules:
- The ground truth answer is authoritative. If the research output contains information that matches the ground truth, mark it CORRECT.
- The research output does NOT need to be worded exactly like the ground truth — different phrasing of the same fact is fine.
- If the research output is vague, avoids the question, or gives a different answer, mark it INCORRECT.
- If there is insufficient information to judge (empty output, clearly garbled), mark it UNCLEAR.
- Minor inaccuracies in supporting details do not invalidate a correct core answer.
- If the research output contains the correct answer but also includes contradictory claims, mark it INCORRECT.

Respond with a JSON object:
{
  "verdict": "correct" | "incorrect" | "unclear",
  "extractedAnswer": "The answer as stated in the research output (one sentence max)",
  "reasoning": "Brief explanation of your judgment (one sentence)"
}`;

function buildGradingPrompt(input: GradingInput): string {
  return `Question: ${input.question.question}

Ground Truth Answer: ${input.question.answer}
${input.question.altAnswers ? `Alternative Accepted Answers: ${input.question.altAnswers.join(' | ')}` : ''}

Research Output (Executive Summary):
${input.executiveSummary || '[EMPTY]'}

Research Output (Narrative excerpt):
${input.narrativeSnippet || '[EMPTY]'}

Is the research output correct? Respond with JSON.`;
}

// ── Heuristic grading ──────────────────────────────────────────────────────

function heuristicGrade(input: GradingInput): GradeResult {
  const { question, executiveSummary, narrativeSnippet } = input;
  const combinedText = `${executiveSummary}\n${narrativeSnippet}`.toLowerCase();

  if (!executiveSummary.trim() && !narrativeSnippet.trim()) {
    return {
      questionId: question.id,
      verdict: 'unclear',
      reasoning: 'Empty research output — no content to grade.',
      extractedAnswer: '',
      unclearReason: 'empty_output',
    };
  }

  // Check required terms
  if (question.requiredTerms && question.requiredTerms.length > 0) {
    const missingTerms: string[] = [];
    for (const term of question.requiredTerms) {
      if (!combinedText.includes(term.toLowerCase())) {
        missingTerms.push(term);
      }
    }

    if (missingTerms.length === 0) {
      return {
        questionId: question.id,
        verdict: 'correct',
        reasoning: `All required terms found: ${question.requiredTerms.join(', ')}.`,
        extractedAnswer: executiveSummary.slice(0, 200),
      };
    }

    if (missingTerms.length === question.requiredTerms.length) {
      return {
        questionId: question.id,
        verdict: 'incorrect',
        reasoning: `No required terms found (missing: ${missingTerms.join(', ')}).`,
        extractedAnswer: executiveSummary.slice(0, 200),
      };
    }

    // Partial match — some terms found
    return {
      questionId: question.id,
      verdict: 'incorrect',
      reasoning: `Missing terms: ${missingTerms.join(', ')}. Found: ${question.requiredTerms.filter((t) => !missingTerms.includes(t)).join(', ')}.`,
      extractedAnswer: executiveSummary.slice(0, 200),
    };
  }

  // no required terms — check for answer substring
  const answerLower = question.answer.toLowerCase();
  if (combinedText.includes(answerLower)) {
    return {
      questionId: question.id,
      verdict: 'correct',
      reasoning: 'Answer text found in output.',
      extractedAnswer: executiveSummary.slice(0, 200),
    };
  }

  return {
    questionId: question.id,
    verdict: 'unclear',
    reasoning:
      'No required terms configured and no direct answer match — cannot grade heuristically.',
    extractedAnswer: executiveSummary.slice(0, 200),
    unclearReason: 'insufficient_heuristic_signal',
  };
}

// ── Grader class ────────────────────────────────────────────────────────────

export class BenchmarkGrader {
  private config: GraderConfig | null;

  constructor(config?: GraderConfig) {
    this.config = config ?? null;
  }

  get method(): GradeMethod {
    return this.config ? 'llm' : 'heuristic';
  }

  /**
   * Grade a single question against research output.
   * Returns LLM grade when configured, heuristic fallback otherwise.
   */
  async grade(input: GradingInput): Promise<GradeResult> {
    if (this.config) {
      return this.gradeWithLlm(input);
    }
    return heuristicGrade(input);
  }

  /**
   * Grade multiple questions. LLM grading batches are processed sequentially
   * to avoid rate-limiting issues; heuristic grading is synchronous.
   */
  async gradeBatch(inputs: GradingInput[]): Promise<GradeResult[]> {
    const results: GradeResult[] = [];

    if (this.config) {
      // Sequential LLM calls to avoid rate limits
      for (const input of inputs) {
        try {
          results.push(await this.gradeWithLlm(input));
        } catch (err) {
          logger.warn(
            { qid: input.question.id, err },
            'LLM grading failed, falling back to heuristic',
          );
          results.push(heuristicGrade(input));
        }
      }
    } else {
      for (const input of inputs) {
        results.push(heuristicGrade(input));
      }
    }

    return results;
  }

  // ── Private LLM grading ────────────────────────────────────────────────

  private async gradeWithLlm(input: GradingInput): Promise<GradeResult> {
    const config = this.config;
    if (!config) {
      // Should not happen — guarded by grade() method check
      return heuristicGrade(input);
    }
    const prompt = buildGradingPrompt(input);

    try {
      const response = await callOpenAiChatCompletion({
        baseUrl: config.baseUrl,
        model: config.model,
        messages: [
          { role: 'system', content: GRADER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        ...(config.apiToken ? { apiToken: config.apiToken } : {}),
        temperature: 0,
        maxTokens: 300,
        responseFormat: 'json_object',
        ...(config.timeoutMs !== undefined ? { totalTimeoutMs: config.timeoutMs } : {}),
      });

      if (!response.success) {
        throw new Error(response.error ?? 'LLM grading failed');
      }

      const content = response.content;

      const parsed = JSON.parse(content) as {
        verdict?: string;
        extractedAnswer?: string;
        reasoning?: string;
      };

      const rawVerdict = parsed.verdict?.toLowerCase();
      let verdict: GradeVerdict = 'unclear';
      if (rawVerdict === 'correct') verdict = 'correct';
      else if (rawVerdict === 'incorrect') verdict = 'incorrect';

      return {
        questionId: input.question.id,
        verdict,
        reasoning: parsed.reasoning ?? 'No reasoning provided.',
        extractedAnswer: parsed.extractedAnswer ?? '',
        ...(verdict === 'unclear' ? { unclearReason: 'llm_unclear' } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ qid: input.question.id, err: message }, 'LLM grading call failed');
      // Fall back to heuristic on LLM failure
      return heuristicGrade(input);
    }
  }
}
