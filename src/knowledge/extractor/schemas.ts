/**
 * V7.0.0 — Zod schemas for LLM extraction, validation, and normalisation.
 *
 * Two schema levels: the LLM output schema (what the model returns) and
 * the internal normalised schema (what is committed to events).
 * `evidence_verbatim` is never in the LLM output — it is set post-extraction
 * after substring validation.
 */

import { z } from 'zod/v4';
// ────────────────────────────────────────────────────────────────────
// LLM output schemas (what the model returns)
// ────────────────────────────────────────────────────────────────────

/**
 * Entity extracted from source text by the LLM.
 *
 * `local_id` is pass-scoped (e.g. "e1", "e2") — used only to wire
 * relationships within a single extraction pass.
 */
export const LLMEntityZ = z.object({
  local_id: z.string(),
  label: z.string(),
  type: z.enum(['concept', 'claim', 'source', 'person', 'org', 'method', 'dataset', 'work']),
  extraction_confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

/**
 * Relationship between two entities.
 *
 * `from_id` and `to_id` reference LLMEntityZ.local_id values within the
 * same extraction pass.
 */
export const LLMRelationshipZ = z.object({
  from_id: z.string(),
  to_id: z.string(),
  type: z.enum(['supports', 'contradicts', 'explains', 'implements']),
  evidence_strength: z.number().min(0).max(1),
  evidence: z.string(),
});

/** Full LLM extraction result: entities + relationships. */
export const LLMExtractionResultZ = z.object({
  entities: z.array(LLMEntityZ),
  relationships: z.array(LLMRelationshipZ),
});

// ────────────────────────────────────────────────────────────────────
// Inferred types
// ────────────────────────────────────────────────────────────────────

/** Raw LLM entity (before post-extraction validation). */
export type LLMEntity = z.infer<typeof LLMEntityZ>;

/** Raw LLM relationship (before post-extraction validation). */
export type LLMRelationship = z.infer<typeof LLMRelationshipZ>;

/** Raw LLM extraction result. */
export type LLMExtractionResult = z.infer<typeof LLMExtractionResultZ>;

// ────────────────────────────────────────────────────────────────────
// Normalised types (post-validation)
// ────────────────────────────────────────────────────────────────────

/**
 * Entity after post-extraction validation.
 *
 * `evidence_verbatim` is set by substring-checking the evidence field
 * against the source text. It is never supplied by the LLM.
 */
export interface NormalizedEntity extends LLMEntity {
  evidence_verbatim: boolean;
}

/**
 * Relationship after post-extraction validation.
 *
 * `evidence_verbatim` is set by substring-checking the evidence field
 * against the source text.
 */
export interface NormalizedRelationship extends LLMRelationship {
  evidence_verbatim: boolean;
}

/**
 * Full normalised extraction result.
 */
export interface NormalizedExtraction {
  entities: NormalizedEntity[];
  relationships: NormalizedRelationship[];
}

// ────────────────────────────────────────────────────────────────────
// Relationship type-pair constraints
// ────────────────────────────────────────────────────────────────────

/**
 * Allowed edge types per (from_type, to_type) pair.
 *
 * Key format: `${fromType}->${toType}`. Absent keys allow any edge type.
 */
export const RELATIONSHIP_TYPE_CONSTRAINTS: Record<string, string[]> = {
  'source->claim': ['supports', 'contradicts'],
  'claim->claim': ['supports', 'contradicts', 'explains'],
  'work->method': ['implements'],
  'method->concept': ['implements', 'explains'],
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Lightly normalise a string for substring matching.
 *
 * Collapses whitespace, trims, and lowercases. Does NOT strip
 * punctuation — verbatim matching should be reasonably strict.
 */
function normaliseForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Check whether `evidence` appears as a substring of `sourceText`.
 *
 * Comparison is done after whitespace normalisation. Returns true
 * if the evidence is found verbatim (modulo whitespace).
 */
function isEvidenceVerbatim(evidence: string, sourceText: string): boolean {
  const normalisedEvidence = normaliseForMatch(evidence);
  const normalisedSource = normaliseForMatch(sourceText);
  return normalisedSource.includes(normalisedEvidence);
}

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validate raw LLM output and produce a normalised extraction result.
 *
 * Steps:
 * 1. Zod-validate against LLMExtractionResultZ
 * 2. Resolve all from_id / to_id references against entities
 * 3. Substring-check each evidence field against sourceText
 * 4. Apply confidence penalties for non-verbatim evidence
 * 5. Return normalised result or errors
 */
export function validateExtraction(
  raw: unknown,
  sourceText: string,
): { valid: boolean; result?: NormalizedExtraction; errors: string[] } {
  const errors: string[] = [];

  // ── Step 1: Zod validation ──
  let parsed: LLMExtractionResult;
  try {
    const result = LLMExtractionResultZ.safeParse(raw);
    if (!result.success) {
      const zodIssues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .slice(0, 10);
      errors.push(`Zod validation failed: ${zodIssues.join('; ')}`);
      return { valid: false, errors };
    }
    parsed = result.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Unexpected error during Zod validation: ${msg}`);
    return { valid: false, errors };
  }

  if (parsed.entities.length === 0) {
    errors.push('Extraction result contains no entities');
    return { valid: false, errors };
  }

  // ── Step 2: Validate relationship references ──
  const validLocalIds = new Set(parsed.entities.map((e) => e.local_id));
  const orphanRelationships: number[] = [];

  for (let i = 0; i < parsed.relationships.length; i++) {
    const rel = parsed.relationships[i];
    if (rel === undefined) {
      orphanRelationships.push(i);
      errors.push(`Relationship #${String(i)} is undefined`);
      continue;
    }
    if (!rel.from_id || !rel.to_id) {
      orphanRelationships.push(i);
      errors.push(
        `Relationship #${String(i)} has empty from_id or to_id ('${rel.from_id}' -> '${rel.to_id}')`,
      );
      continue;
    }
    if (!validLocalIds.has(rel.from_id)) {
      orphanRelationships.push(i);
      errors.push(
        `Relationship #${String(i)} references unknown from_id '${rel.from_id}' (local_id not found in entities)`,
      );
    }
    if (!validLocalIds.has(rel.to_id)) {
      orphanRelationships.push(i);
      errors.push(
        `Relationship #${String(i)} references unknown to_id '${rel.to_id}' (local_id not found in entities)`,
      );
    }
  }

  // ── Step 3–5: Normalise entities and relationships ──
  const normalisedEntities: NormalizedEntity[] = parsed.entities.map((entity) => {
    const verbatim = isEvidenceVerbatim(entity.evidence, sourceText);
    const adjustedConfidence = verbatim
      ? entity.extraction_confidence
      : entity.extraction_confidence * 0.6;

    return {
      ...entity,
      extraction_confidence: adjustedConfidence,
      evidence_verbatim: verbatim,
    };
  });

  const validRelationships: LLMRelationship[] = [];
  for (let i = 0; i < parsed.relationships.length; i++) {
    const rel = parsed.relationships[i];
    if (rel !== undefined && !orphanRelationships.includes(i)) {
      validRelationships.push(rel);
    }
  }

  const normalisedRelationships: NormalizedRelationship[] = validRelationships.map((rel) => {
    const verbatim = isEvidenceVerbatim(rel.evidence, sourceText);
    const adjustedStrength = verbatim ? rel.evidence_strength : rel.evidence_strength * 0.6;

    return {
      ...rel,
      evidence_strength: adjustedStrength,
      evidence_verbatim: verbatim,
    };
  });

  // ── Apply edge-level all-non-verbatim cap ──
  // If ALL evidence for a relationship is non-verbatim, cap at 0.4
  for (const rel of normalisedRelationships) {
    if (!rel.evidence_verbatim) {
      // Check if there are multiple evidence entries — but we only have one
      // evidence string per relationship in the current schema.
      // If the single evidence is non-verbatim, cap at 0.4.
      rel.evidence_strength = Math.min(rel.evidence_strength, 0.4);
    }
  }

  // ── Validate type-pair constraints ──
  const constraintViolations = validateRelationshipTypes(
    normalisedEntities,
    normalisedRelationships,
  );
  for (const violation of constraintViolations) {
    errors.push(violation);
  }

  // Filter out relationship rows that violate type-pair constraints
  // Rebuild the violation lookup: map relationship index -> violation message
  const violationByRelIdx = new Map<number, string>();
  for (const violation of constraintViolations) {
    const idxMatch = /Relationship #(\d+):/.exec(violation);
    if (idxMatch) {
      violationByRelIdx.set(Number(idxMatch[1]), violation);
    }
  }

  const filteredRelationships = normalisedRelationships.filter((_, i) => !violationByRelIdx.has(i));

  const result: NormalizedExtraction = {
    entities: normalisedEntities,
    relationships: filteredRelationships,
  };

  return {
    valid: errors.length === 0,
    result,
    errors,
  };
}

/**
 * Validate relationship type-pair constraints.
 *
 * Returns an array of error messages for invalid (from_type, to_type, edge_type)
 * combinations. Invalid relationships should be dropped, not failed — only
 * the violating relationship is removed, the extraction continues.
 */
export function validateRelationshipTypes(
  entities: NormalizedEntity[],
  relationships: NormalizedRelationship[],
): string[] {
  const entityMap = new Map<string, NormalizedEntity>();
  for (const entity of entities) {
    entityMap.set(entity.local_id, entity);
  }

  const violations: string[] = [];

  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i];
    if (rel === undefined) continue;
    const fromEntity = entityMap.get(rel.from_id);
    const toEntity = entityMap.get(rel.to_id);

    if (!fromEntity || !toEntity) {
      continue; // Already caught by reference validation
    }

    const key = `${fromEntity.type}->${toEntity.type}`;
    const allowedTypes = RELATIONSHIP_TYPE_CONSTRAINTS[key];

    if (allowedTypes !== undefined && !allowedTypes.includes(rel.type)) {
      violations.push(
        `Relationship #${String(i)}: type '${rel.type}' is not allowed for ` +
          `(${fromEntity.type} -> ${toEntity.type}). ` +
          `Allowed types: [${allowedTypes.join(', ')}]. Dropping this edge.`,
      );
    }
  }

  return violations;
}
