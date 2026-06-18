/**
 * ContradictionDetector — LLM + embedding-based contradiction and open-question detection.
 *
 * Provides a shared detection layer used by PostProcessingPhase, GapLoopPhase, and
 * state.postProcessFindings(). When an LLM client is available, uses targeted LLM
 * calls for robust detection. When unavailable, falls back to rule-based regex
 * detection (detectContradictions in state.ts, generateFromEvidencePool).
 *
 * This centralises the contradiction/open-question pipeline so ALL research paths
 * (agent, pipeline, deterministic, tree) benefit from LLM-powered detection.
 */

import { randomUUID } from 'node:crypto';
import type { Finding, Contradiction, ContradictionType, SourceEntry } from './types.js';
import type { DeepResearchLlmClient } from './llm/chat.js';
import { ORCHESTRATOR_CONTRADICTION_SCAN, ORCHESTRATOR_OPEN_QUESTIONS } from './llm/prompts.js';
import { logger } from '../logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
  return randomUUID().slice(0, 12);
}

const MAX_FINDINGS_PER_BATCH = 20;

// ── Detector ─────────────────────────────────────────────────────────────────

export interface ContradictionDetectorOptions {
  /** Minimum number of findings before LLM detection runs. */
  minFindingsForLlm?: number;
  /** Maximum findings sent to LLM in one batch. */
  maxBatchSize?: number;
}

export class ContradictionDetector {
  private readonly llm: DeepResearchLlmClient | undefined;
  private readonly options: Required<ContradictionDetectorOptions>;

  constructor(llm?: DeepResearchLlmClient, options?: ContradictionDetectorOptions) {
    this.llm = llm;
    this.options = {
      minFindingsForLlm: options?.minFindingsForLlm ?? 3,
      maxBatchSize: options?.maxBatchSize ?? MAX_FINDINGS_PER_BATCH,
    };
  }

  /**
   * Detect contradictions via LLM (when available) from the given findings.
   *
   * When LLM is unavailable or findings are below the minimum, returns an empty
   * array — callers should fall back to rule-based detection separately.
   *
   * @param findings - All findings in the research state.
   * @param existingContradictions - Already-detected contradictions (for dedup).
   * @returns New contradictions to add to state.
   */
  async detectContradictions(
    findings: Finding[],
    existingContradictions: Contradiction[],
  ): Promise<Contradiction[]> {
    if (!this.llm) return [];
    if (findings.length < this.options.minFindingsForLlm) return [];

    // Group findings by sub-question for better context
    const bySubQuestion = new Map<string, Finding[]>();
    for (const f of findings) {
      for (const sqId of f.subQuestionIds) {
        const group = bySubQuestion.get(sqId) ?? [];
        group.push(f);
        bySubQuestion.set(sqId, group);
      }
    }

    // Select qualifying sub-questions (≥2 findings for meaningful comparison)
    const qualifying = [...bySubQuestion.entries()]
      .filter(([, group]) => group.length >= 2)
      .sort(([, a], [, b]) => b.length - a.length);

    if (qualifying.length === 0) return [];

    // Build batch: take up to maxBatchSize findings across qualifying sub-questions
    const batched: Finding[] = [];
    for (const [, group] of qualifying) {
      for (const f of group) {
        if (batched.length >= this.options.maxBatchSize) break;
        batched.push(f);
      }
      if (batched.length >= this.options.maxBatchSize) break;
    }

    if (batched.length < 2) return [];

    // Build existing contradiction dedup set
    const existingPairs = new Set<string>();
    for (const c of existingContradictions) {
      existingPairs.add(`${c.claimA.slice(0, 80)}|||${c.claimB.slice(0, 80)}`);
      existingPairs.add(`${c.claimB.slice(0, 80)}|||${c.claimA.slice(0, 80)}`);
    }

    const findingsInput = batched
      .map(
        (f) =>
          `[${f.id}] ${f.claim} (sources: ${String(f.sourceIds.length)}, sub-questions: ${f.subQuestionIds.join(', ')})`,
      )
      .join('\n');

    const existingContradictionSummary =
      existingContradictions.length > 0
        ? `\nExisting contradictions already recorded (DO NOT re-flag these):\n${existingContradictions.map((c) => `- "${c.claimA.slice(0, 80)}" vs "${c.claimB.slice(0, 80)}"`).join('\n')}`
        : '';

    try {
      const result = await this.llm.callJSON<{
        contradictions: {
          claimA: string;
          claimB: string;
          contradictionType: string;
          explanation: string;
          followUpSearchRecommended?: string;
        }[];
      }>({
        model: 'orchestrator',
        messages: [
          { role: 'system', content: ORCHESTRATOR_CONTRADICTION_SCAN },
          {
            role: 'user',
            content: `Scan the following findings for hidden contradictions:\n\n${findingsInput}${existingContradictionSummary}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 2000,
      });

      if (!result.success || result.data.contradictions.length === 0) return [];

      const newContradictions: Contradiction[] = [];
      for (const c of result.data.contradictions) {
        const pairKey = `${c.claimA.slice(0, 80)}|||${c.claimB.slice(0, 80)}`;
        if (existingPairs.has(pairKey)) continue;

        const id = makeId();
        newContradictions.push({
          id,
          claimA: c.claimA,
          claimB: c.claimB,
          sourceIdsA: [],
          sourceIdsB: [],
          contradictionType: c.contradictionType as ContradictionType,
          likelyExplanation: c.explanation,
          resolutionStatus: 'unresolved',
          ...(c.followUpSearchRecommended
            ? { followUpSearchRecommended: c.followUpSearchRecommended }
            : {}),
        });
        existingPairs.add(pairKey);
      }

      if (newContradictions.length > 0) {
        logger.info(
          {
            scanned: batched.length,
            found: result.data.contradictions.length,
            added: newContradictions.length,
          },
          'LLM contradiction detector: new contradictions detected',
        );
      }

      return newContradictions;
    } catch (err) {
      logger.warn({ err }, 'LLM contradiction detector failed; returning empty');
      return [];
    }
  }

  /**
   * Generate open questions via LLM from the current research state.
   *
   * When LLM is unavailable, returns an empty array — callers should fall back
   * to rule-based generation (generateFromEvidencePool).
   *
   * @param findings - All findings in the research state.
   * @param sources - All sources in the research state.
   * @param query - The original research query for context.
   * @returns Open question strings to add to state.
   */
  async generateOpenQuestions(
    findings: Finding[],
    sources: SourceEntry[],
    query: string,
  ): Promise<string[]> {
    if (!this.llm) return [];
    if (findings.length < this.options.minFindingsForLlm) return [];

    // Build a concise state summary for the LLM
    const stateSummary = {
      query,
      sourceTypes: [...new Set(sources.map((s) => s.sourceType))],
      sourceCount: sources.length,
      findingCount: findings.length,
      singleSourceFindings: findings.filter((f) => f.sourceIds.length === 1).length,
      speculativeCount: findings.filter((f) => f.evidenceDirectness === 'speculative').length,
      sampleFindings: findings.slice(0, 15).map((f) => ({
        claim: f.claim.slice(0, 200),
        evidenceDirectness: f.evidenceDirectness,
        sourceCount: f.sourceIds.length,
      })),
    };

    try {
      const result = await this.llm.callJSON<{
        openQuestions: {
          question: string;
          category: string;
          severity: string;
        }[];
      }>({
        model: 'orchestrator',
        messages: [
          { role: 'system', content: ORCHESTRATOR_OPEN_QUESTIONS },
          {
            role: 'user',
            content: `Research state:\n${JSON.stringify(stateSummary, null, 2)}`,
          },
        ],
        temperature: 0.3,
        maxTokens: 1500,
      });

      if (!result.success || result.data.openQuestions.length === 0) return [];

      const questions = result.data.openQuestions.map((q) => q.question);
      logger.info(
        { generated: questions.length },
        'LLM open-questions generator: new questions identified',
      );

      return questions;
    } catch (err) {
      logger.warn({ err }, 'LLM open-questions generator failed; returning empty');
      return [];
    }
  }

  /**
   * Full analysis: detect contradictions AND generate open questions in one pass.
   *
   * This is the primary entry point for PostProcessingPhase and GapLoopPhase.
   * Returns new contradictions to merge and new open questions to add.
   */
  async analyze(
    findings: Finding[],
    sources: SourceEntry[],
    existingContradictions: Contradiction[],
    query: string,
  ): Promise<{
    contradictions: Contradiction[];
    openQuestions: string[];
  }> {
    const [contradictions, openQuestions] = await Promise.all([
      this.detectContradictions(findings, existingContradictions),
      this.generateOpenQuestions(findings, sources, query),
    ]);

    return { contradictions, openQuestions };
  }
}
