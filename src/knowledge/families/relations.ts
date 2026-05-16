/**
 * Phase 4 — Pass 2 relation detection: cross-family relationship detection.
 */

import { logger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import { callSimpleLlm } from '../extractor/llm.js';
import { getNode, queryFamilies, queryNodes, getEdgesForNode } from '../store/projections.js';
import { queryEvents, appendEvents, generateUlid } from '../store/events.js';
import { getKgDb } from '../store/db.js';
import type { KgFamily, FamilyRelationType } from '../types.js';

export interface Pass2RelationResult { newRelations: number; removedRelations: number; familyPairsChecked: number }

const LAST_PASS_2_KEY = '__pass2_last_run_id';

function getLastPass2RunId(): string | null {
  const db = getKgDb(); if (db === null) return null;
  try { const row = db.prepare('SELECT ref_id FROM kg_event_refs WHERE event_id = ? AND ref_type = ?').get(LAST_PASS_2_KEY, 'checkpoint') as { ref_id: string } | undefined; return row?.ref_id ?? null; } catch { return null; }
}

function setLastPass2RunId(): void {
  const db = getKgDb(); if (db === null) return;
  try { db.prepare('INSERT OR REPLACE INTO kg_event_refs (event_id, ref_type, ref_id) VALUES (?, ?, ?)').run(LAST_PASS_2_KEY, 'checkpoint', String(Date.now())); } catch { /* best effort */ }
}

export function shouldRunPass2(): boolean {
  try {
    const db = getKgDb(); if (db === null) return false;
    const lastRunId = getLastPass2RunId();
    if (lastRunId === null) return true;
    const runCountRow = db.prepare('SELECT COUNT(*) as cnt FROM kg_events WHERE event_type = ? AND timestamp > (SELECT COALESCE(MAX(timestamp), \'\') FROM kg_events WHERE id = ?)').get('RUN_COMPLETED', lastRunId) as { cnt: number } | undefined;
    return (runCountRow?.cnt ?? 0) >= 5;
  } catch (err) { logger.warn({ err }, 'kg: shouldRunPass2 failed'); return false; }
}

const RELATION_SYSTEM_PROMPT = `You are a knowledge graph relationship detector. Given two family summaries and their shared entities, determine the relationship.

Possible relationship types:
- adjacent: families are topically related but one does not contain the other
- contradicts: families contain contradictory information
- parent: family A is a broader category that contains family B
- child: family A is a narrower sub-category of family B
- supersedes: family A replaces family B with more recent information

Respond with exactly one line: RELATION <type> <reason>
Or if no relation: NONE

<type> must be one of: adjacent, contradicts, parent, child, supersedes.`;

function buildRelationPrompt(familyA: KgFamily, familyB: KgFamily, sharedEntityLabels: string[], sharedEdgeTypes: string[]): string {
  return [`Family A: ${familyA.label}`, familyA.description ? `  Description: ${familyA.description}` : '', '', `Family B: ${familyB.label}`, familyB.description ? `  Description: ${familyB.description}` : '', '', `Shared entities (${String(sharedEntityLabels.length)}): ${sharedEntityLabels.join(', ')}`, sharedEdgeTypes.length > 0 ? `Cross-family edges: ${sharedEdgeTypes.join(', ')}` : '', '', 'What is the relationship, if any? Respond with RELATION <type> <reason> or NONE.'].filter(Boolean).join('\n');
}

function parseRelationResponse(content: string): { relationType: FamilyRelationType | null; reason?: string } {
  const trimmed = content.trim();
  if (trimmed.startsWith('NONE')) return { relationType: null };
  const match = /^RELATION\s+(adjacent|contradicts|parent|child|supersedes)\s+(.+)$/i.exec(trimmed);
  if (match?.[1]) return { relationType: match[1].toLowerCase() as FamilyRelationType, reason: match[2] ?? 'unknown' };
  return { relationType: null };
}

async function checkTemporalSupersedes(familyA: KgFamily, familyB: KgFamily): Promise<boolean> {
  try {
    const db = getKgDb();
    if (db === null) return false;
    // Compare latest source-level timestamps, fall back to family-level dates
    const aSource = db.prepare('SELECT MAX(retrieved_at) as latest FROM kg_sources WHERE run_id IN (SELECT first_seen_run_id FROM kg_nodes WHERE id IN (SELECT node_id FROM kg_node_families WHERE family_id = ?))').get(familyA.id) as { latest: string | null } | undefined;
    const bSource = db.prepare('SELECT MAX(retrieved_at) as latest FROM kg_sources WHERE run_id IN (SELECT first_seen_run_id FROM kg_nodes WHERE id IN (SELECT node_id FROM kg_node_families WHERE family_id = ?))').get(familyB.id) as { latest: string | null } | undefined;
    const aTime = aSource?.latest ? new Date(aSource.latest).getTime() : (familyA.lastActivity ? new Date(familyA.lastActivity).getTime() : 0);
    const bTime = bSource?.latest ? new Date(bSource.latest).getTime() : (familyB.createdAt ? new Date(familyB.createdAt).getTime() : 0);
    return aTime > bTime;
  } catch { return false; }
}

async function detectStaleRelations(families: KgFamily[]): Promise<number> {
  let removed = 0;
  try {
    const relationEvents = queryEvents({ eventType: 'FAMILY_RELATED' });
    const currentFamilyIds = new Set(families.map(f => f.id));
    for (const ev of relationEvents) {
      const payload = JSON.parse(ev.payload) as Record<string, unknown>;
      const familyA = (payload.family_a ?? payload.familyA) as string | undefined;
      const familyB = (payload.family_b ?? payload.familyB) as string | undefined;
      if (!familyA || !familyB) continue;
      if (!currentFamilyIds.has(familyA) || !currentFamilyIds.has(familyB)) {
        const relationId = (payload.relation_id as string | undefined) ?? generateUlid();
        appendEvents([{ timestamp: new Date().toISOString(), eventType: 'FAMILY_RELATION_REMOVED', eventVersion: 1, runId: ev.runId, batchId: null, actor: 'classifier', entityId: familyA, entityType: 'family', payload: JSON.stringify({ relation_id: relationId, family_a: familyA, family_b: familyB, reason: 'One or both families no longer exist' }), payloadHash: null }]);
        removed++;
      }
    }
    return removed;
  } catch (err) { logger.warn({ err }, 'kg: detectStaleRelations failed'); return removed; }
}

export async function runPass2Relations(): Promise<Pass2RelationResult> {
  logger.info('kg: runPass2Relations starting');
  const result: Pass2RelationResult = { newRelations: 0, removedRelations: 0, familyPairsChecked: 0 };
  try {
    const cfgGlobal = loadConfig();
    const kgConfig = cfgGlobal.knowledgeGraph;
    if (!cfgGlobal.llm.baseUrl || !cfgGlobal.llm.provider) { logger.info('kg: LLM not configured, skipping Pass 2'); return result; }
    const maxFamilies = kgConfig.relations.maxFamilies;
    const maxNodesPerFamily = kgConfig.relations.maxNodesPerFamily;
    const families = queryFamilies({ limit: maxFamilies }).families;
    if (families.length < 2) return result;
    const familyNodeIds = new Map<string, string[]>();
    for (const fam of families) { familyNodeIds.set(fam.id, queryNodes({ familyId: fam.id, limit: maxNodesPerFamily }).nodes.map(n => n.id)); }

    // Build inverted index: nodeId -> Set<familyId>
    const nodeToFamilies = new Map<string, Set<string>>();
    for (const [famId, nids] of familyNodeIds) {
      for (const nid of nids) {
        let families = nodeToFamilies.get(nid);
        if (!families) { families = new Set(); nodeToFamilies.set(nid, families); }
        families.add(famId);
      }
    }

    // Collect candidate pairs from shared nodes
    const candidatePairKeys = new Set<string>();
    for (const [, families] of nodeToFamilies) {
      const arr = [...families];
      for (const [i, a] of arr.entries()) {
        for (const b of arr.slice(i + 1)) {
          candidatePairKeys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
      }
    }

    // Also check pairs linked by cross-family edges (edge-only connections)
    for (const a of families) {
      const aNodeIds = familyNodeIds.get(a.id) ?? [];
      const seenNeighborFamilies = new Set<string>();
      for (const nid of aNodeIds) {
        for (const edge of getEdgesForNode(nid)) {
          const neighborId = edge.fromId === nid ? edge.toId : edge.fromId;
          const neighborFams = nodeToFamilies.get(neighborId);
          if (neighborFams) {
            for (const nfid of neighborFams) {
              if (nfid !== a.id) seenNeighborFamilies.add(nfid);
            }
          }
        }
      }
      for (const nfid of seenNeighborFamilies) {
        candidatePairKeys.add(a.id < nfid ? `${a.id}:${nfid}` : `${nfid}:${a.id}`);
      }
    }

    const familyMap = new Map(families.map(f => [f.id, f]));
    const pairsToCheck: { familyA: KgFamily; familyB: KgFamily }[] = [];
    for (const pairKey of candidatePairKeys) {
      const parts = pairKey.split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      const familyA = familyMap.get(parts[0]);
      const familyB = familyMap.get(parts[1]);
      if (familyA && familyB) pairsToCheck.push({ familyA, familyB });
    }

    logger.info({ pairsToCheck: pairsToCheck.length }, 'kg: Pass2 candidate pairs');
    for (const pair of pairsToCheck) {
      try {
        result.familyPairsChecked++;
        const aNodeIds = familyNodeIds.get(pair.familyA.id) ?? [], bNodeIds = new Set(familyNodeIds.get(pair.familyB.id) ?? []);
        const sharedEntityLabels: string[] = [], sharedEdgeTypes: string[] = [];
        for (const nid of aNodeIds) {
          if (bNodeIds.has(nid)) {
            const node = getNode(nid); if (node !== null) sharedEntityLabels.push(node.label);
            for (const edge of getEdgesForNode(nid)) { if (bNodeIds.has(edge.fromId) || bNodeIds.has(edge.toId)) { if (!sharedEdgeTypes.includes(edge.type)) sharedEdgeTypes.push(edge.type); } }
          }
        }
        const llmResponse = await callSimpleLlm(cfgGlobal.llm, RELATION_SYSTEM_PROMPT, buildRelationPrompt(pair.familyA, pair.familyB, sharedEntityLabels.length > 0 ? sharedEntityLabels : ['(shared via edges)'], sharedEdgeTypes));
        if (!llmResponse.success) { logger.warn({ error: llmResponse.error }, 'kg: Pass2 LLM failed'); continue; }
        const parsed = parseRelationResponse(llmResponse.content);
        if (parsed.relationType === null) continue;
        if (parsed.relationType === 'supersedes' && !(await checkTemporalSupersedes(pair.familyA, pair.familyB))) { logger.info({ familyA: pair.familyA.id, familyB: pair.familyB.id }, 'kg: supersedes skipped — no temporal evidence'); continue; }
        const relationId = generateUlid();
        appendEvents([{ timestamp: new Date().toISOString(), eventType: 'FAMILY_RELATED', eventVersion: 1, runId: 'pass2', batchId: null, actor: 'classifier', entityId: pair.familyA.id, entityType: 'family', payload: JSON.stringify({ relation_id: relationId, family_a: pair.familyA.id, family_b: pair.familyB.id, relation_type: parsed.relationType, reason: parsed.reason ?? null }), payloadHash: null }]);
        result.newRelations++;
        logger.info({ familyA: pair.familyA.label, familyB: pair.familyB.label, relationType: parsed.relationType }, 'kg: Pass2 detected');
      } catch (err) { logger.warn({ err, familyA: pair.familyA.id, familyB: pair.familyB.id }, 'kg: Pass2 failed for pair'); }
    }
    result.removedRelations = await detectStaleRelations(families);
    setLastPass2RunId();
    logger.info(result, 'kg: runPass2Relations complete');
    return result;
  } catch (err) { logger.warn({ err }, 'kg: runPass2Relations failed'); return result; }
}
