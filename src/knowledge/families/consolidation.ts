/**
 * Phase 4 — Background consolidation: finds families that should be merged.
 * Pairwise cosine similarity → LLM judgment → auto-merge | store candidate.
 */

import { logger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import { callSimpleLlm } from '../extractor/llm.js';
import { queryFamilies, getFamily } from '../store/projections.js';
import { appendEvents } from '../store/events.js';
import { getKgDb } from '../store/db.js';
import { embedTexts } from '../../rag/embedding.js';
import { storeEmbedding } from '../store/embeddings.js';
import type { KnowledgeGraphConfig } from '../types.js';

export interface ConsolidationResult { pairsChecked: number; autoMerged: number; candidatesCreated: number; llmCalls: number; durationMs: number }

const AUTO_MERGE_CONFIDENCE = 0.92;
const MIN_CANDIDATE_CONFIDENCE = 0.75;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai !== undefined && bi !== undefined) {
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function shouldRunConsolidation(lastRunTime: number | null, config: KnowledgeGraphConfig): boolean {
  if (lastRunTime === null) return true;
  return Date.now() - lastRunTime >= config.consolidation.cadenceMs;
}

export function getLastConsolidationTime(): number | null {
  const db = getKgDb(); if (db === null) return null;
  try {
    const row = db.prepare('SELECT created_at FROM kg_projection_checkpoints WHERE projection_version = 0 AND id = ?').get('__consolidation_last_run') as { created_at: string } | undefined;
    return row ? new Date(row.created_at).getTime() : null;
  } catch {
    return null;
  }
}

function saveConsolidationTime(): void {
  const db = getKgDb(); if (db === null) return;
  try {
    db.prepare('INSERT OR REPLACE INTO kg_projection_checkpoints (projection_version, id, created_at) VALUES (0, ?, ?)').run('__consolidation_last_run', new Date().toISOString());
  } catch {
    /* best effort */
  }
}

const MERGE_SYSTEM_PROMPT = `You are a knowledge graph consolidation assistant. Given two family summaries, decide if they should be merged into a single family.

Respond with exactly:
- YES <short reason> if they should be merged
- NO <short reason> if they should remain separate

Two families should be merged when:
- They cover the same or overlapping topic
- One is a subset of the other
- They describe the same concept from different sources
- They cannot be clearly distinguished

Two families should remain separate when:
- They cover distinct topics
- They have a parent/child or adjacent relationship that is useful to preserve
- They contain contradictory information (keep separate to avoid confusion)`;

function buildMergePrompt(familyA: { label: string; description: string | null }, familyB: { label: string; description: string | null }): string {
  return [`Family A: ${familyA.label}`, familyA.description ? `  Description: ${familyA.description}` : '  (no description)', '', `Family B: ${familyB.label}`, familyB.description ? `  Description: ${familyB.description}` : '  (no description)', '', 'Should these families be merged?'].join('\n');
}

function parseMergeResponse(content: string): { shouldMerge: boolean; reason?: string } {
  const trimmed = content.trim().toUpperCase();
  if (trimmed.startsWith('YES')) { const reason = content.trim().slice(3).trim() || 'LLM judged merge appropriate'; return { shouldMerge: true, reason }; }
  return { shouldMerge: false, reason: content.trim() || 'LLM judged keep separate' };
}

export async function runConsolidationPass(config: KnowledgeGraphConfig): Promise<ConsolidationResult> {
  const startedAt = Date.now();
  logger.info('kg: runConsolidationPass starting');
  const result: ConsolidationResult = { pairsChecked: 0, autoMerged: 0, candidatesCreated: 0, llmCalls: 0, durationMs: 0 };
  try {
    const families = queryFamilies({ limit: config.consolidation.maxFamilies ?? 300 }).families;
    if (families.length < 2) return result;
    if (families.length >= config.consolidation.annThreshold) { logger.warn({ familyCount: families.length }, 'kg: consolidation skipped — exceeds ANN threshold, V7.1+ required'); return result; }
    const cfgGlobal = loadConfig();
    const dimensions = cfgGlobal.embeddingSidecar.dimensions;
    const db = getKgDb();
    const familyEmbeddings: { id: string; embedding: number[] }[] = [];
    for (const fam of families) {
      try {
        let embedding: number[] | null = null;
        if (db !== null) {
          const row = db.prepare('SELECT embedding FROM kg_embeddings WHERE object_id = ? AND object_type = ?').get(fam.id, 'family') as { embedding: Buffer } | undefined;
          if (row?.embedding) { const blob = row.embedding; const vec: number[] = []; for (let i = 0; i < blob.byteLength / 4; i++) vec.push(blob.readFloatLE(i * 4)); embedding = vec; }
        }
        if (embedding === null && cfgGlobal.embeddingSidecar.baseUrl) {
          const response = await embedTexts({ texts: [fam.description ? `${fam.label}: ${fam.description}` : fam.label], mode: 'document', dimensions });
          embedding = response.embeddings[0] ?? null;
          if (embedding) storeEmbedding(fam.id, 'family', response.model || cfgGlobal.embeddingSidecar.provider, embedding, fam.id);
        }
        if (embedding !== null) familyEmbeddings.push({ id: fam.id, embedding });
      } catch (err) { logger.warn({ err, familyId: fam.id }, 'kg: embed failed'); }
    }
    if (familyEmbeddings.length < 2) return result;
    const CONSOLIDATION_LLM_CAP = 50;
    let llmCalls = 0;
    let capReached = false;
    for (let i = 0; i < familyEmbeddings.length && !capReached; i++) {
      for (let j = i + 1; j < familyEmbeddings.length; j++) {
        const a = familyEmbeddings[i];
        const b = familyEmbeddings[j];
        if (!a || !b) continue;
        const sim = cosineSimilarity(a.embedding, b.embedding);
        result.pairsChecked++;
        if (sim < MIN_CANDIDATE_CONFIDENCE) continue;
        const familyA = getFamily(a.id), familyB = getFamily(b.id);
        if (familyA === null || familyB === null) continue;
        // Cap LLM calls — stop all further processing
        if (llmCalls >= CONSOLIDATION_LLM_CAP) {
          logger.info({ llmCalls }, 'kg: consolidation LLM cap reached');
          capReached = true;
          break;
        }
        llmCalls++;
        const llmResponse = await callSimpleLlm(cfgGlobal.llm, MERGE_SYSTEM_PROMPT, buildMergePrompt(familyA, familyB));
        if (!llmResponse.success) {
          logger.warn({ familyA: familyA.label, familyB: familyB.label }, 'kg: merge LLM failed');
          if (db) { try { db.prepare('INSERT OR REPLACE INTO kg_family_merge_candidates (family_a, family_b, confidence, reason, generated_at) VALUES (?, ?, ?, ?, ?)').run(a.id, b.id, sim, `LLM unavailable, sim=${sim.toFixed(3)}`, new Date().toISOString()); result.candidatesCreated++; } catch { /* best effort */ } }
          continue;
        }
        const parsed = parseMergeResponse(llmResponse.content);
        if (parsed.shouldMerge && sim >= AUTO_MERGE_CONFIDENCE) {
          appendEvents([{ timestamp: new Date().toISOString(), eventType: 'FAMILY_MERGED', eventVersion: 1, runId: 'consolidation', batchId: null, actor: 'classifier', entityId: a.id, entityType: 'family', payload: JSON.stringify({ from_id: a.id, into_id: b.id, confidence: sim, reason: parsed.reason ?? 'Auto-merge' }), payloadHash: null }]);
          result.autoMerged++;
          logger.info({ keep: familyA.label, merged: familyB.label, sim }, 'kg: auto-merged');
        } else if (db) {
          try { db.prepare('INSERT OR REPLACE INTO kg_family_merge_candidates (family_a, family_b, confidence, reason, generated_at, consolidation_version) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, b.id, sim, parsed.shouldMerge ? `LLM: ${parsed.reason ?? 'merge'}, sim=${sim.toFixed(3)}` : `LLM: ${parsed.reason ?? 'keep separate'}, sim=${sim.toFixed(3)}`, new Date().toISOString(), 'v7.0'); result.candidatesCreated++; } catch { /* best effort */ }
        }
      }
    }
    result.llmCalls = llmCalls;
    saveConsolidationTime();
    result.durationMs = Date.now() - startedAt;
    logger.info(result, 'kg: runConsolidationPass complete');
    return result;
  } catch (err) { logger.warn({ err }, 'kg: runConsolidationPass failed'); result.durationMs = Date.now() - startedAt; return result; }
}
