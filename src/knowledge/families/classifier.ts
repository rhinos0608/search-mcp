/**
 * Phase 4 — Pass 1 classifier: assigns entities to families.
 * Embedding similarity → candidate families → LLM assignments → fallback.
 */

import { logger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import { embedTexts } from '../../rag/embedding.js';
import { callSimpleLlm } from '../extractor/llm.js';
import { getFamily } from '../store/projections.js';
import { findSimilarEmbeddings, storeEmbedding } from '../store/embeddings.js';
import crypto from 'node:crypto';
import { appendEvents, generateUlid } from '../store/events.js';
import {
  queueFamilyAssignment,
  queueFamilyCandidate,
  getPendingFamiliesForSolidification,
  solidifyFamily,
} from '../store/family-pending.js';
import type { KnowledgeGraphConfig, KgFamily } from '../types.js';

export interface Pass1ClassifierResult {
  assignments: { entityId: string; familyId: string }[];
  newCandidates: { id: string; label: string; description?: string; entityIds: string[]; runIds: string[] }[];
}

export interface RunEntity { id: string; label: string; type: string }
export interface RunMetadata { topic?: string; query?: string; description?: string; familyHint?: string }

const TOP_K_SIMILAR = 10;
const SIMILARITY_THRESHOLD = 0.5;

export async function createFamilyEmbedding(label: string, description?: string): Promise<number[] | null> {
  try {
    const config = loadConfig();
    const embedText = description ? `${label}: ${description}` : label;
    const response = await embedTexts({ texts: [embedText], mode: 'document', dimensions: config.embeddingSidecar.dimensions });
    const embedding = response.embeddings[0] ?? null;
    if (embedding === null) { logger.warn({ label }, 'kg: createFamilyEmbedding returned null'); return null; }
    const contentHash = crypto.createHash('sha256').update(embedText).digest('hex');
    storeEmbedding(label, 'family', response.model || config.embeddingSidecar.provider, embedding, contentHash);
    return embedding;
  } catch (err) { logger.warn({ err, label }, 'kg: createFamilyEmbedding failed'); return null; }
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a knowledge graph family classifier. Your job is to group entities into families based on shared topics, concepts, or domains.

Given a list of extracted entities, run metadata, and existing families, decide:

1. ASSIGNMENTS: Which entities should be assigned to existing families?
   - Respond with lines: ASSIGN <entityId> <familyId>
   - Only assign when there is a clear semantic match.

2. NEW FAMILIES: Which new families should be created?
   - Respond with lines: NEW <label> <entityId1,entityId2,...> [optional description]
   - Group entities that share a coherent topic and are not well-covered by existing families.

Rules:
- Each entity can be assigned to at most one family.
- If an entity does not fit any existing or new family, leave it unassigned.
- New family labels should be concise and descriptive.
- Descriptions are optional but helpful for future matching.

Respond with only ASSIGN and NEW lines, one per line, no markdown, no commentary.`;

function buildClassifierUserPrompt(entities: RunEntity[], metadata: RunMetadata, existingFamilies: KgFamily[]): string {
  let prompt = '## Run Metadata\n';
  if (metadata.topic) prompt += `Topic: ${metadata.topic}\n`;
  if (metadata.query) prompt += `Query: ${metadata.query}\n`;
  if (metadata.familyHint) prompt += `Family Hint: ${metadata.familyHint}\n`;
  if (metadata.description) prompt += `Description: ${metadata.description}\n`;
  prompt += `\n## Entities (${String(entities.length)})\n`;
  for (const ent of entities) prompt += `- ${ent.id} | ${ent.type}: ${ent.label}\n`;
  if (existingFamilies.length > 0) {
    prompt += `\n## Existing Families (${String(existingFamilies.length)})\n`;
    for (const fam of existingFamilies) prompt += `- ${fam.id} | ${fam.label}${fam.description ? ` — ${fam.description}` : ''}\n`;
  }
  return prompt;
}

function parseClassifierResponse(content: string, maxNewFamilies = 5): { assignments: { entityId: string; familyId: string }[]; newFamilyCandidates: { label: string; entityIds: string[]; description?: string }[] } {
  const assignments: { entityId: string; familyId: string }[] = [];
  const newFamilyCandidates: { label: string; entityIds: string[]; description?: string }[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('ASSIGN ')) {
      const parts = line.slice(7).split(/\s+/);
      if (parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined) {
        assignments.push({ entityId: parts[0], familyId: parts[1] });
      }
    } else if (line.startsWith('NEW ') && newFamilyCandidates.length < maxNewFamilies) {
      const rest = line.slice(4).trim();
      const labelEnd = rest.indexOf(' ');
      if (labelEnd === -1) continue;
      const label = rest.slice(0, labelEnd);
      const afterLabel = rest.slice(labelEnd + 1).trim();
      const idEnd = afterLabel.indexOf(' ');
      const idCsv = idEnd === -1 ? afterLabel : afterLabel.slice(0, idEnd);
      const description = idEnd === -1 ? undefined : afterLabel.slice(idEnd + 1).trim();
      const entityIds = idCsv.split(',').map(s => s.trim()).filter(s => s.length > 0);
      if (entityIds.length > 0) newFamilyCandidates.push(description !== undefined ? { label, entityIds, description } : { label, entityIds });
    }
  }
  return { assignments, newFamilyCandidates };
}

function typeBasedFallback(entities: RunEntity[], runId: string): Pass1ClassifierResult {
  const grouped = new Map<string, RunEntity[]>();
  for (const ent of entities) {
    const existing = grouped.get(ent.type) ?? [];
    existing.push(ent);
    grouped.set(ent.type, existing);
  }
  const newCandidates: Pass1ClassifierResult['newCandidates'] = [];
  for (const [type, typeEntities] of grouped) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    newCandidates.push({ id: `fallback-${type}-${runId.slice(0, 8)}`, label, entityIds: typeEntities.map(e => e.id), runIds: [runId] });
  }
  return { assignments: [], newCandidates };
}

export async function runPass1Classifier(runEntities: RunEntity[], runMetadata: RunMetadata, runId: string, _config: KnowledgeGraphConfig): Promise<Pass1ClassifierResult> {
  logger.info({ runId, entityCount: runEntities.length }, 'kg: runPass1Classifier starting');
  try {
    const queryText = runMetadata.query ?? runMetadata.topic ?? '';
    let similarFamilies: { objectId: string; similarity: number }[] = [];
    const configGlobal = loadConfig();
    if (queryText && configGlobal.embeddingSidecar.baseUrl) {
      try {
        const dimensions = configGlobal.embeddingSidecar.dimensions;
        const embedResponse = await embedTexts({ texts: [queryText], mode: 'query', dimensions });
        const queryEmbedding = embedResponse.embeddings[0];
        if (queryEmbedding) similarFamilies = findSimilarEmbeddings(queryEmbedding, 'family', SIMILARITY_THRESHOLD, TOP_K_SIMILAR);
      } catch { logger.warn({ err: null }, 'kg: Pass1 embedding search failed, continuing without'); }
    }
    const candidateFamilies: KgFamily[] = [];
    for (const s of similarFamilies) { const fam = getFamily(s.objectId); if (fam !== null) candidateFamilies.push(fam); }
    if (!configGlobal.llm.baseUrl || !configGlobal.llm.provider) {
      logger.info('kg: LLM not configured, using type-based fallback');
      const fallback = typeBasedFallback(runEntities, runId);
      for (const c of fallback.newCandidates) queueFamilyCandidate(c);
      return fallback;
    }
    const llmResponse = await callSimpleLlm(configGlobal.llm, CLASSIFIER_SYSTEM_PROMPT, buildClassifierUserPrompt(runEntities, runMetadata, candidateFamilies));
    if (!llmResponse.success) {
      logger.warn({ error: llmResponse.error }, 'kg: Pass1 LLM failed, falling back');
      const fallback = typeBasedFallback(runEntities, runId);
      for (const c of fallback.newCandidates) queueFamilyCandidate(c);
      return fallback;
    }
    const parsed = parseClassifierResponse(llmResponse.content);
    logger.info({ assignments: parsed.assignments.length, newCandidates: parsed.newFamilyCandidates.length }, 'kg: Pass1 LLM response parsed');
    for (const a of parsed.assignments) queueFamilyAssignment(a.entityId, a.familyId, runId);
    const candidates: Pass1ClassifierResult['newCandidates'] = [];
    for (const nc of parsed.newFamilyCandidates) {
      const id = generateUlid();
      const candidate: { id: string; label: string; description?: string; entityIds: string[]; runIds: string[] } = { id, label: nc.label, entityIds: nc.entityIds, runIds: [runId] };
      if (nc.description !== undefined) candidate.description = nc.description;
      queueFamilyCandidate(candidate);
      candidates.push(candidate);
    }
    return { assignments: parsed.assignments, newCandidates: candidates };
  } catch (err) {
    logger.warn({ err, runId }, 'kg: runPass1Classifier failed');
    try { const fallback = typeBasedFallback(runEntities, runId); for (const c of fallback.newCandidates) queueFamilyCandidate(c); return fallback; }
    catch { return { assignments: [], newCandidates: [] }; }
  } finally { void _config; }
}

export function solidifyFamilies(config: KnowledgeGraphConfig): number {
  logger.info('kg: solidifyFamilies starting');
  let solidified = 0;
  try {
    const pending = getPendingFamiliesForSolidification();
    if (pending.length === 0) return 0;
    const solid = config.solidification;
    for (const pf of pending) {
      try {
        const distinctRunCount = new Set(pf.runIds).size;
        const entityCount = pf.entityIds.length;
        let shouldSolidify = false;
        if (distinctRunCount >= solid.minRuns && entityCount >= solid.minEntities) shouldSolidify = true;
        if (!shouldSolidify && distinctRunCount === 1 && entityCount >= solid.minEntities) {
          // High-confidence single-run override (spec lines 539-543):
          // Requires extraction_confidence >= 0.85 on all entities,
          // evidence_verbatim ratio >= 0.7, and >= 3 distinct source IDs.
          // V7.0 note: these metrics are not yet stored on assignments;
          // the override is disabled until per-assignment confidence tracking
          // is added to the extractor pipeline in a follow-up.
          shouldSolidify = false;
        }
        if (shouldSolidify) {
          const familyId = generateUlid();
          appendEvents([{ timestamp: new Date().toISOString(), eventType: 'FAMILY_CREATED', eventVersion: 1, runId: pf.runIds[0] ?? 'unknown', batchId: null, actor: 'classifier', entityId: familyId, entityType: 'family', payload: JSON.stringify({ family_id: familyId, label: pf.label, description: pf.description, entityIds: pf.entityIds, runIds: pf.runIds, createdAt: new Date().toISOString() }), payloadHash: null }]);
          const classifyRaw = pf.assignments.map(a => ({ timestamp: new Date().toISOString(), eventType: 'FAMILY_CLASSIFIED' as const, eventVersion: 1, runId: a.runId, batchId: null as string | null, actor: 'classifier' as const, entityId: a.entityId, entityType: 'node' as const, payload: JSON.stringify({ entity_id: a.entityId, family_id: familyId }), payloadHash: null as string | null }));
          if (classifyRaw.length > 0) appendEvents(classifyRaw);
          solidifyFamily(familyId, pf.assignments);
          solidified++;
          logger.info({ familyId, label: pf.label, entityCount, distinctRunCount }, 'kg: family solidified');
        }
      } catch (err) { logger.warn({ err, pendingId: pf.id }, 'kg: failed to process pending family'); }
    }
    logger.info({ solidified, totalPending: pending.length }, 'kg: solidifyFamilies complete');
    return solidified;
  } catch (err) { logger.warn({ err }, 'kg: solidifyFamilies failed'); return solidified; }
}
