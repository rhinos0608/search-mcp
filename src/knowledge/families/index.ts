/**
 * Phase 4 — Family Manager orchestration.
 * Re-exports all family pipeline modules and provides runFamilyPipelineAfterRun.
 */

import { logger } from '../../logger.js';
import { runPass1Classifier, solidifyFamilies } from './classifier.js';
import { runPass2Relations, shouldRunPass2 } from './relations.js';
import { runConsolidationPass, shouldRunConsolidation, getLastConsolidationTime } from './consolidation.js';
import type { KnowledgeGraphConfig } from '../types.js';
import type { RunEntity, RunMetadata } from './classifier.js';
import type { Pass2RelationResult } from './relations.js';
import type { ConsolidationResult } from './consolidation.js';

export { runPass1Classifier, solidifyFamilies } from './classifier.js';
export { runPass2Relations, shouldRunPass2 } from './relations.js';
export { runConsolidationPass, shouldRunConsolidation } from './consolidation.js';

export interface FamilyPipelineResult {
  classifier: { assignmentCount: number; newCandidateCount: number };
  solidified: number;
  relations: Pass2RelationResult | null;
  consolidation: ConsolidationResult | null;
}

export async function runFamilyPipelineAfterRun(runEntities: RunEntity[], runMetadata: RunMetadata, runId: string, config: KnowledgeGraphConfig): Promise<FamilyPipelineResult> {
  logger.info({ runId, entityCount: runEntities.length }, 'kg: runFamilyPipelineAfterRun starting');
  const result: FamilyPipelineResult = { classifier: { assignmentCount: 0, newCandidateCount: 0 }, solidified: 0, relations: null, consolidation: null };

  try {
    const classifierResult = await runPass1Classifier(runEntities, runMetadata, runId, config);
    result.classifier = { assignmentCount: classifierResult.assignments.length, newCandidateCount: classifierResult.newCandidates.length };
    logger.info({ assignmentCount: result.classifier.assignmentCount, newCandidateCount: result.classifier.newCandidateCount }, 'kg: Pass 1 complete');
  } catch (err) { logger.warn({ err }, 'kg: Pass 1 failed, continuing'); }

  try {
    result.solidified = solidifyFamilies(config);
    logger.info({ solidified: result.solidified }, 'kg: solidification complete');
  } catch (err) { logger.warn({ err }, 'kg: solidification failed, continuing'); }

  try {
    if (shouldRunPass2()) {
      result.relations = await runPass2Relations();
      logger.info({ newRelations: result.relations.newRelations, removed: result.relations.removedRelations }, 'kg: Pass 2 complete');
    } else { logger.info('kg: Pass 2 skipped'); }
  } catch (err) { logger.warn({ err }, 'kg: Pass 2 failed, continuing'); }

  try {
    const lastConsolidation = getLastConsolidationTime();
    if (shouldRunConsolidation(lastConsolidation, config)) {
      result.consolidation = await runConsolidationPass(config);
      logger.info({ pairsChecked: result.consolidation.pairsChecked, autoMerged: result.consolidation.autoMerged, candidatesCreated: result.consolidation.candidatesCreated }, 'kg: consolidation complete');
    } else { logger.info('kg: consolidation skipped'); }
  } catch (err) { logger.warn({ err }, 'kg: consolidation failed, continuing'); }

  logger.info(result, 'kg: runFamilyPipelineAfterRun complete');
  return result;
}
