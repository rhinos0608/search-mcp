/**
 * PostProcessingPhase — runs after extraction, before audit.
 *
 * Relevance classification, finding splitting, and contradiction/open-question
 * generation via LLM (preferred) with regex fallback. Runs for ALL paths.
 * Extracted from PipelineStrategy.analyze() lines 129-201.
 */

import { BasePhase } from './basePhase.js';
import type { StrategyContext } from '../strategies/types.js';
import { logger } from '../../logger.js';
import { ContradictionDetector } from '../contradictionDetector.js';

export class PostProcessingPhase extends BasePhase {
  readonly name = 'post_processing';
  readonly requiresLlm = false;

  async execute(query: string, ctx: StrategyContext): Promise<void> {
    this.checkAborted(ctx);

    const allFindings = ctx.state.getFindings();
    if (allFindings.length === 0) return;

    const { scoreAllFindings } = await import('../relevanceClassifier.js');
    const { processAndSplitFindings } = await import('../findingSplitter.js');
    const { generateFromEvidencePool, mergeContradictions } =
      await import('../contradictionGenerator.js');

    // 1. Relevance classify all findings against the original query
    const relevanceScores = scoreAllFindings(query, allFindings);
    for (const f of allFindings) {
      const scored = relevanceScores.get(f.id);
      if (scored) {
        f.relevanceScore = scored.score;
        f.relevanceReason = scored.reason;
      }
    }
    const admissibleCount = [...relevanceScores.values()].filter((r) => r.admissible).length;
    logger.info(
      {
        total: allFindings.length,
        admissible: admissibleCount,
        inadmissible: allFindings.length - admissibleCount,
      },
      'Relevance classification applied to findings',
    );

    // 2. Split multi-claim findings into atomic ones
    const { updated, newSplits } = processAndSplitFindings(allFindings);
    // Replace original findings with updated versions (preserving id)
    for (const f of ctx.state.getFindings()) {
      const updatedData = updated.get(f.id);
      if (updatedData) {
        Object.assign(f, updatedData);
      }
    }
    // Add split findings to state
    let splitAdded = 0;
    for (const split of newSplits) {
      ctx.state.addFinding(split);
      splitAdded++;
    }
    if (splitAdded > 0) {
      logger.info({ splitAdded }, 'Finding splitter: atomic findings added');
    }

    // 3. LLM-based contradiction + open-question detection (preferred path)
    if (ctx.llm && !ctx.deterministic) {
      const detector = new ContradictionDetector(ctx.llm);
      const llmResult = await detector.analyze(
        ctx.state.getFindings(),
        ctx.state.getSources(),
        ctx.state.getState().contradictions,
        query,
      );

      if (llmResult.contradictions.length > 0) {
        const merged = mergeContradictions(
          ctx.state.getState().contradictions,
          llmResult.contradictions,
        );
        ctx.state.setContradictions(merged);
        logger.info(
          { added: llmResult.contradictions.length, total: merged.length },
          'LLM contradiction detector: contradictions added',
        );
      }

      if (llmResult.openQuestions.length > 0) {
        for (const q of llmResult.openQuestions) {
          ctx.state.addOpenQuestion(q);
        }
        logger.info(
          { added: llmResult.openQuestions.length },
          'LLM open-questions generator: open questions added',
        );
      }
    }

    // 3b. Regex-based evidence-pool contradiction generation (always runs as supplement)
    const generated = generateFromEvidencePool(
      ctx.state.getFindings(),
      ctx.state.getSources(),
      query,
    );
    if (generated.contradictions.length > 0) {
      const merged = mergeContradictions(
        ctx.state.getState().contradictions,
        generated.contradictions,
      );
      ctx.state.setContradictions(merged);
      logger.info(
        { added: generated.contradictions.length, total: merged.length },
        'Contradiction generator: evidence-pool contradictions added',
      );
    }
    if (generated.uncertainties.length > 0) {
      for (const u of generated.uncertainties) {
        ctx.state.addOpenQuestion(u);
      }
      logger.info(
        { uncertainties: generated.uncertainties.length },
        'Contradiction generator: uncertainties added to open questions',
      );
    }
  }
}
