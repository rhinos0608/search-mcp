/**
 * V7.0.0 — Entity canonicalization for the knowledge graph extractor.
 *
 * After entities are extracted from source text, they are canonicalized
 * against existing nodes in the graph. This prevents duplicate nodes for
 * the same real-world entity.
 *
 * Process:
 * 1. Compute embedding for each new entity label
 * 2. Search kg_embeddings for similar entities by type-aware threshold
 * 3. For each close candidate, use LLM judgment to decide if same entity
 * 4. If same → add to merges list (ENTITY_MERGED)
 * 5. If new → add to newNodes list (NODE_ADDED)
 */

import { logger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import { getKgDb } from '../store/db.js';
import { findSimilarEmbeddings, storeEmbedding } from '../store/embeddings.js';
import { createHash } from 'node:crypto';
import { embedTexts } from '../../rag/embedding.js';
import type { NormalizedEntity } from './schemas.js';
import type { KgNode } from '../types.js';
import { callSimpleLlm } from './llm.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/**
 * Result of canonicalizing a batch of new entities against existing nodes.
 */
export interface CanonicalizationResult {
  /** Entities determined to be new (will produce NODE_ADDED events). */
  newNodes: NormalizedEntity[];
  /** Entities determined to match existing nodes (will produce ENTITY_MERGED events). */
  merges: {
    /** The local_id of the new entity. */
    fromId: string;
    /** The kg_node id of the existing node it merges into. */
    intoId: string;
    /** Human-readable reason for the merge. */
    reason: string;
  }[];
}

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/**
 * Type-aware similarity thresholds for embedding-based dedup.
 *
 * Entities of type `person` and `org` have a lower threshold because
 * their names are more distinctive and we want to catch more candidates.
 * All other types use a higher threshold to avoid false positives.
 */
function getThresholdForType(type: string): number {
  if (type === 'person' || type === 'org') return 0.75;
  return 0.85;
}

// ────────────────────────────────────────────────────────────────────
// Embedding helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Compute an embedding vector for an entity label + type description.
 *
 * Constructs a descriptive text from the label and type, then embeds it.
 * Gracefully returns null when the embedding provider is unavailable.
 */
export async function computeEntityEmbedding(
  label: string,
  type: string,
): Promise<number[] | null> {
  try {
    const config = loadConfig();
    const dimensions = config.embeddingSidecar.dimensions;
    const embedText = `${type}: ${label}`;

    const response = await embedTexts({
      texts: [embedText],
      mode: 'document',
      dimensions,
    });

    return response.embeddings[0] ?? null;
  } catch (err) {
    logger.warn({ err, label, type }, 'kg: computeEntityEmbedding failed');
    return null;
  }
}

/**
 * Store an entity embedding in the kg_embeddings table.
 *
 * The content hash is computed from the label + type to detect staleness.
 * Gracefully handles when the DB is not initialised.
 */
export function storeEntityEmbedding(
  nodeId: string,
  label: string,
  type: string,
  embedding: number[],
): void {
  try {
    const config = loadConfig();
    const model = config.embeddingSidecar.provider;
    const contentHash = createHash('sha256').update(`${label} ${type}`, 'utf8').digest('hex');
    storeEmbedding(nodeId, 'node', model, embedding, contentHash);
  } catch (err) {
    logger.warn({ err, nodeId }, 'kg: storeEntityEmbedding failed');
  }
}

/**
 * Search the kg_embeddings table for similar entities of the given type.
 *
 * Returns existing nodes that are close enough in embedding space.
 * Gracefully returns empty array when the embedding provider is unavailable
 * or the DB is not initialised.
 */
export async function searchSimilarEntities(
  embedding: number[],
  type: string,
): Promise<KgNode[]> {
  try {
    const threshold = getThresholdForType(type);

    const similar = findSimilarEmbeddings(embedding, 'node', threshold);

    if (similar.length === 0) return [];

    const db = getKgDb();
    if (db === null) {
      logger.warn('kg: searchSimilarEntities called before database initialised');
      return [];
    }

    // Fetch full node records for matching IDs
    const ids = similar.map((s) => s.objectId);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM kg_nodes WHERE id IN (${placeholders})`)
      .all(...ids) as KgNode[];

    return rows;
  } catch (err) {
    logger.warn({ err, type }, 'kg: searchSimilarEntities failed');
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// LLM judgment (simple prompt-based)
// ────────────────────────────────────────────────────────────────────

/**
 * Use the configured LLM to decide if two entity labels refer to the
 * same real-world entity.
 *
 * Returns true if the LLM judges them to be the same entity.
 * On LLM failure, defaults to false (safer to treat as new).
 */
async function llmJudgesSameEntity(
  newLabel: string,
  newType: string,
  existingLabel: string,
  existingType: string,
): Promise<boolean> {
  const config = loadConfig();
  if (!config.llm.baseUrl || !config.llm.provider) {
    // No LLM configured — fall back to strict label comparison
    return newLabel.toLowerCase() === existingLabel.toLowerCase();
  }

  try {
    const systemPrompt =
      'You are an entity resolution assistant. Determine if two entity labels refer to the same real-world entity. Respond with only "YES" or "NO".';
    const userMessage = `Entity 1: type="${newType}", label="${newLabel}"\nEntity 2: type="${existingType}", label="${existingLabel}"\n\nDo these refer to the same real-world entity? Answer YES or NO.`;
    const response = await callSimpleLlm(config.llm, systemPrompt, userMessage, {
      maxTokens: 10,
      temperature: 0,
    });

    if (!response.success) return false;
    return response.content.trim().toUpperCase() === 'YES';
  } catch (err) {
    logger.warn({ err, newLabel, existingLabel }, 'kg: llmJudgesSameEntity failed');
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// Main canonicalization
// ────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a batch of new entities against existing nodes.
 *
 * For each new entity:
 * 1. Compute an embedding vector
 * 2. Search for similar existing entities by type-aware threshold
 * 3. Use LLM judgment (or fallback) to decide if same entity
 * 4. Classify as new or merge
 *
 * When the embedding provider is unavailable, all entities are treated
 * as new (no canonicalization).
 */
export async function canonicalize(
  newEntities: NormalizedEntity[],
  _existingNodes: KgNode[],
): Promise<CanonicalizationResult> {
  const newNodes: NormalizedEntity[] = [];
  const merges: CanonicalizationResult['merges'] = [];

  for (const entity of newEntities) {
    try {
      const embedding = await computeEntityEmbedding(entity.label, entity.type);

      if (embedding === null) {
        // Embedding unavailable — treat as new
        newNodes.push(entity);
        continue;
      }

      // Search for similar entities
      const similarCandidates = await searchSimilarEntities(embedding, entity.type);

      if (similarCandidates.length === 0) {
        // No close matches — this is a new entity
        newNodes.push(entity);
        storeEntityEmbedding(entity.local_id, entity.label, entity.type, embedding);
        continue;
      }

      // Expand aliases from candidate nodes for alias-based matching
      const candidatesWithAliases = similarCandidates.map((node) => {
        let aliases: string[] = [];
        if (node.aliases) {
          try {
            aliases = JSON.parse(node.aliases) as string[];
          } catch {
            // ignore parse errors
          }
        }
        return { ...node, _aliasLabels: aliases };
      });

      // Check if the new entity label matches any candidate's alias (case-insensitive)
      let matched = false;
      for (const candidate of candidatesWithAliases) {
        if (candidate.type !== entity.type) continue;

        const aliasMatch = candidate._aliasLabels.some(
          (alias) => alias.toLowerCase() === entity.label.toLowerCase(),
        );

        if (aliasMatch) {
          merges.push({
            fromId: entity.local_id,
            intoId: candidate.id,
            reason: `alias match: "${entity.label}" (${entity.type}) matches alias of existing node "${candidate.label}"`,
          });
          matched = true;
          break;
        }
      }

      // Fall back to LLM judgment if no alias match
      if (!matched) {
        for (const candidate of candidatesWithAliases) {
          if (candidate.type !== entity.type) continue;

          const isSame = await llmJudgesSameEntity(
            entity.label,
            entity.type,
            candidate.label,
            candidate.type,
          );

          if (isSame) {
            merges.push({
              fromId: entity.local_id,
              intoId: candidate.id,
              reason: `LLM judgment: "${entity.label}" (${entity.type}) matches existing node "${candidate.label}"`,
            });
            matched = true;
            break; // Merge into first match
          }
        }
      }

      if (!matched) {
        newNodes.push(entity);
        storeEntityEmbedding(entity.local_id, entity.label, entity.type, embedding);
      }
    } catch (err) {
      logger.warn({ err, label: entity.label }, 'kg: canonicalize failed for entity');
      // On error, treat as new (safer to create a duplicate than to merge incorrectly)
      newNodes.push(entity);
    }
  }

  return { newNodes, merges };
}
