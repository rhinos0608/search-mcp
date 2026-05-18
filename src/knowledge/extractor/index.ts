/**
 * V7.0.0 — Knowledge Graph Extractor.
 *
 * Orchestrates the end-to-end extraction pipeline:
 * 1. LLM-based entity and relationship extraction from source text
 * 2. Post-extraction validation (Zod, reference integrity, evidence verbatim)
 * 3. Canonicalization (embedding + LLM judgment for dedup)
 * 4. Event emission (CLAIM_EXTRACTED, NODE_ADDED, ENTITY_MERGED, EDGE_ADDED, SOURCE_ADDED)
 *
 * Uses a lightweight fetch-based LLM client (not DeepResearchLlmClient,
 * which is coupled to budget tracking).
 */

import { logger } from '../../logger.js';
import { appendEvents, generateUlid } from '../store/events.js';
import type { SearchConfig, LlmConfig } from '../../config.js';
import type { KgEvent, KgEventType } from '../types.js';
import { validateExtraction } from './schemas.js';
import type { NormalizedEntity, NormalizedRelationship, NormalizedExtraction } from './schemas.js';
import { canonicalize } from './canonicalise.js';
import { callSimpleLlm, type SimpleLlmCallOptions } from './llm.js';
import type { NormalizedExtractionInput } from './normalise.js';
import { parseJsonFromText } from '../../utils/jsonFromText.js';

// ────────────────────────────────────────────────────────────────────
// Extraction result types
// ────────────────────────────────────────────────────────────────────

/**
 * Result of a single extraction pass.
 */
export interface ExtractionResult {
  entities: NormalizedEntity[];
  edges: NormalizedRelationship[];
  claimEvents: KgEvent[];
  nodeEvents: KgEvent[];
  edgeEvents: KgEvent[];
  sourceEvents: KgEvent[];
  failureEvents: KgEvent[];
}

type JsonRecord = Record<string, unknown>;

interface KgEntityDraft {
  local_id: string;
  label: string;
  type: 'concept' | 'claim' | 'source' | 'person' | 'org' | 'method' | 'dataset' | 'work';
  extraction_confidence: number;
  evidence: string;
}

interface KgRelationshipDraft {
  from_id: string;
  to_id: string;
  type: 'supports' | 'contradicts' | 'explains' | 'implements';
  evidence_strength: number;
  evidence: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function claimConfidence(claim: JsonRecord): number {
  const hedge = stringValue(claim.hedge)?.toLowerCase();
  const evidenceType = stringValue(claim.evidenceType)?.toLowerCase();
  const hedgeScore: Record<string, number> = {
    certain: 0.9,
    likely: 0.75,
    possible: 0.6,
    speculative: 0.45,
  };
  const evidenceBoost: Record<string, number> = {
    study: 0.05,
    benchmark: 0.05,
    claim: 0,
    opinion: -0.1,
    anecdote: -0.15,
  };

  return clamp01((hedgeScore[hedge ?? ''] ?? 0.65) + (evidenceBoost[evidenceType ?? ''] ?? 0));
}

function normalizeLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function extractionFromStructuredClaims(
  claims: unknown[],
): { entities: KgEntityDraft[]; relationships: KgRelationshipDraft[] } | null {
  const entities: KgEntityDraft[] = [];
  const relationships: KgRelationshipDraft[] = [];

  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (!isRecord(claim)) continue;

    const subject = stringValue(claim.subject);
    const predicate = stringValue(claim.predicate);
    const evidence = stringValue(claim.sourceSpan);
    if (!subject || !predicate || !evidence) continue;

    const object = stringValue(claim.object);
    const confidence = claimConfidence(claim);
    const number = String(index + 1);
    const subjectId = `s${number}`;
    const claimId = `c${number}`;
    const polarity = stringValue(claim.polarity)?.toLowerCase();
    const relationshipType = polarity === 'negated' ? 'contradicts' : 'supports';
    const claimLabel = normalizeLabel([subject, predicate, object].filter(Boolean).join(' '));

    entities.push({
      local_id: subjectId,
      label: normalizeLabel(subject),
      type: 'concept',
      extraction_confidence: confidence,
      evidence,
    });
    entities.push({
      local_id: claimId,
      label: claimLabel,
      type: 'claim',
      extraction_confidence: confidence,
      evidence,
    });
    relationships.push({
      from_id: subjectId,
      to_id: claimId,
      type: relationshipType,
      evidence_strength: confidence,
      evidence,
    });

    if (object) {
      const objectId = `o${number}`;
      entities.push({
        local_id: objectId,
        label: normalizeLabel(object),
        type: 'concept',
        extraction_confidence: confidence,
        evidence,
      });
      relationships.push({
        from_id: claimId,
        to_id: objectId,
        type: polarity === 'negated' ? 'contradicts' : 'explains',
        evidence_strength: confidence,
        evidence,
      });
    }
  }

  return entities.length > 0 ? { entities, relationships } : null;
}

function extractionFromFindings(
  findings: unknown[],
): { entities: KgEntityDraft[]; relationships: KgRelationshipDraft[] } | null {
  const entities: KgEntityDraft[] = [];

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (!isRecord(finding)) continue;
    const claim = stringValue(finding.claim);
    const evidence = stringValue(finding.evidenceExcerpt) ?? claim;
    if (!claim || !evidence) continue;
    entities.push({
      local_id: `f${String(index + 1)}`,
      label: normalizeLabel(claim),
      type: 'claim',
      extraction_confidence: 0.65,
      evidence,
    });
  }

  return entities.length > 0 ? { entities, relationships: [] } : null;
}

function plainTextClaims(raw: string): string[] {
  const prepared = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+[•*-]\s+/g, '\n')
    .replace(/\r/g, '\n');
  const seen = new Set<string>();
  const claims: string[] = [];

  for (const line of prepared.split('\n')) {
    const cleanedLine = line
      .replace(/^\s*(?:[•*-]|\d+[.)])\s*/u, '')
      .replace(/^\s*(?:finding|claim)\s*\d*\s*[:.-]\s*/iu, '')
      .trim();
    if (cleanedLine.length < 20) continue;
    // Drop only true section headings: lines starting with trigger words
    // that are very short (≤4 words) OR end with punctuation (colon, period).
    if (
      /^(?:here|sure|json|findings?|claims?|entities?|relationships?)\b.*:?$/iu.test(cleanedLine) &&
      (cleanedLine.split(/\s+/).length <= 4 || /[:.]$/.test(cleanedLine))
    ) {
      continue;
    }
    // Skip lines that are almost-pure JSON/code: multiple braces or a brace + key:value pattern.
    if (/(?:\{[^{}]*:[^{}]*\}|\[.*\].*\[.*\]|\{[^{}]*\}[^{}]*\{[^{}]*\})/.test(cleanedLine)) {
      continue;
    }

    // Split on punctuation + whitespace (any case after the separator).
    const sentences = cleanedLine.split(/(?<=[.!?])\s+/u);
    for (const sentence of sentences) {
      const claim = sentence.replace(/^['"]|['"]$/g, '').trim();
      if (claim.length < 20) continue;
      const key = claim.toLowerCase().replace(/\s+/g, ' ').slice(0, 140);
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(claim.length > 500 ? `${claim.slice(0, 497)}...` : claim);
    }
  }

  return claims.slice(0, 50);
}

function extractionFromPlainText(
  raw: string,
): { entities: KgEntityDraft[]; relationships: KgRelationshipDraft[] } | null {
  const claims = plainTextClaims(raw);
  if (claims.length === 0) return null;

  return {
    entities: claims.map((claim, index) => ({
      local_id: `t${String(index + 1)}`,
      label: normalizeLabel(claim),
      type: 'claim',
      extraction_confidence: 0.55,
      evidence: claim,
    })),
    relationships: [],
  };
}

function normalizeParsedExtraction(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    const structuredClaims = extractionFromStructuredClaims(parsed);
    return structuredClaims ?? { entities: parsed, relationships: [] };
  }

  if (!isRecord(parsed)) return parsed;

  if (Array.isArray(parsed.entities)) {
    return {
      ...parsed,
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    };
  }

  if (Array.isArray(parsed.claims)) {
    return extractionFromStructuredClaims(parsed.claims) ?? parsed;
  }

  if (Array.isArray(parsed.findings)) {
    return extractionFromFindings(parsed.findings) ?? parsed;
  }

  return parsed;
}

export function parseKnowledgeGraphLlmResponse(raw: string): unknown {
  const parsed = parseJsonFromText(raw);
  if (parsed !== undefined) return normalizeParsedExtraction(parsed);
  return extractionFromPlainText(raw);
}

// ────────────────────────────────────────────────────────────────────
// KnowledgeGraphExtractor
// ────────────────────────────────────────────────────────────────────

/**
 * Main extractor class for the knowledge graph pipeline.
 *
 * Usage:
 * ```typescript
 * const extractor = new KnowledgeGraphExtractor(config);
 * const result = await extractor.extract(input, runId);
 * ```
 */
export class KnowledgeGraphExtractor {
  private readonly llm: LlmConfig;

  constructor(config: SearchConfig) {
    this.llm = config.llm;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Run the full extraction pipeline on a normalised input.
   *
   * Steps:
   * 1. Build LLM extraction prompt from input
   * 2. Call LLM and parse response
   * 3. Validate and normalise the extraction result
   * 4. Emit CLAIM_EXTRACTED events for each entity
   * 5. Canonicalize entities against existing graph
   * 6. Emit NODE_ADDED / ENTITY_MERGED events
   * 7. Emit EDGE_ADDED events
   * 8. Emit SOURCE_ADDED event
   * 9. Return structured result
   *
   * @param options - Configuration for the LLM call (type {@link SimpleLlmCallOptions}).
   *                  Common keys include:
   *                  - `totalTimeoutMs`: max duration in ms for the LLM request.
   *                  Defaults to an empty object (no overrides).
   *                  Example: `{ totalTimeoutMs: 15000 }` bounds the request to 15s.
   */
  async extract(
    input: NormalizedExtractionInput,
    runId: string,
    options: SimpleLlmCallOptions = {},
  ): Promise<ExtractionResult> {
    const emptyResult: ExtractionResult = {
      entities: [],
      edges: [],
      claimEvents: [],
      nodeEvents: [],
      edgeEvents: [],
      sourceEvents: [],
      failureEvents: [],
    };

    // ── Step 0: Guard — LLM must be configured ──
    if (!this.llm.baseUrl || !this.llm.provider) {
      logger.warn('kg: extraction skipped — LLM not configured');
      return emptyResult;
    }

    // ── Step 1: Build prompt and call LLM ──
    const systemPrompt = this.buildExtractionPrompt(input);
    const userMessage = `Extract entities and relationships from the following source text:\n\n${input.text}`;

    logger.info({ runId, textLength: input.text.length }, 'kg: calling LLM for extraction');

    const llmResponse = await callSimpleLlm(this.llm, systemPrompt, userMessage, options);

    if (!llmResponse.success) {
      logger.warn({ runId, error: llmResponse.error }, 'kg: LLM extraction failed');
      const failureEvent = this.buildFailureEvent(runId, llmResponse.error ?? 'Unknown LLM error');
      this.emitEvents([failureEvent]);
      return { ...emptyResult, failureEvents: [failureEvent] };
    }

    // ── Step 2: Parse LLM response ──
    const parsed = this.parseLlmResponse(llmResponse.content);

    if (parsed === null) {
      logger.warn({ runId }, 'kg: failed to parse LLM response as JSON');
      const failureEvent = this.buildFailureEvent(runId, 'Failed to parse LLM response as JSON');
      this.emitEvents([failureEvent]);
      return { ...emptyResult, failureEvents: [failureEvent] };
    }

    // ── Step 3: Validate and normalise ──
    const validation = validateExtraction(parsed, input.text);

    if (!validation.valid || validation.result === undefined) {
      logger.warn({ runId, errors: validation.errors }, 'kg: extraction validation failed');
      const failureEvent = this.buildFailureEvent(
        runId,
        `Extraction validation failed: ${validation.errors.join('; ')}`,
      );
      this.emitEvents([failureEvent]);
      return { ...emptyResult, failureEvents: [failureEvent] };
    }

    const result = validation.result;

    // ── Step 4: Emit CLAIM_EXTRACTED events ──
    const claimEvents = this.buildClaimExtractedEvents(result, runId, input);

    // ── Step 5: Canonicalize ──
    const canonicalization = await canonicalize(result.entities);

    // ── Build local_id → canonical node ID map ──
    const localToCanonical = new Map<string, string>();
    for (const merge of canonicalization.merges) {
      localToCanonical.set(merge.fromId, merge.intoId);
    }
    for (const entity of result.entities) {
      if (!localToCanonical.has(entity.local_id)) {
        localToCanonical.set(entity.local_id, entity.local_id);
      }
    }

    // ── Step 6: Emit NODE_ADDED / ENTITY_MERGED events ──
    const nodeEvents: KgEvent[] = [];

    for (const newNode of canonicalization.newNodes) {
      nodeEvents.push({
        id: generateUlid(),
        timestamp: new Date().toISOString(),
        eventType: 'NODE_ADDED',
        eventVersion: 1,
        runId,
        batchId: null,
        actor: 'system',
        entityId: newNode.local_id,
        entityType: newNode.type,
        payload: JSON.stringify({
          node_id: newNode.local_id,
          label: newNode.label,
          type: newNode.type,
          extraction_confidence: newNode.extraction_confidence,
          evidence_verbatim: newNode.evidence_verbatim ? 1 : 0,
        }),
        payloadHash: null,
      });
    }

    for (const merge of canonicalization.merges) {
      nodeEvents.push({
        id: generateUlid(),
        timestamp: new Date().toISOString(),
        eventType: 'ENTITY_MERGED',
        eventVersion: 1,
        runId,
        batchId: null,
        actor: 'system',
        entityId: merge.intoId,
        entityType: 'entity',
        payload: JSON.stringify({
          from_id: merge.fromId,
          into_id: merge.intoId,
          reason: merge.reason,
        }),
        payloadHash: null,
      });
    }

    // ── Step 7: Emit EDGE_ADDED events ──
    const edgeEvents: KgEvent[] = [];
    const edgeEntityIds: string[] = [];

    for (const rel of result.relationships) {
      const fromCanonical = localToCanonical.get(rel.from_id) ?? rel.from_id;
      const toCanonical = localToCanonical.get(rel.to_id) ?? rel.to_id;
      const edgeId = `${fromCanonical}->${toCanonical}`;
      edgeEntityIds.push(fromCanonical, toCanonical);
      edgeEvents.push({
        id: generateUlid(),
        timestamp: new Date().toISOString(),
        eventType: 'EDGE_ADDED',
        eventVersion: 1,
        runId,
        batchId: null,
        actor: 'system',
        entityId: edgeId,
        entityType: 'relationship',
        payload: JSON.stringify({
          edge_id: edgeId,
          from_id: fromCanonical,
          to_id: toCanonical,
          type: rel.type,
          evidence_strength: rel.evidence_strength,
          evidence_verbatim: rel.evidence_verbatim ? 1 : 0,
        }),
        payloadHash: null,
      });
    }

    // ── Step 8: Emit SOURCE_ADDED event ──
    const sourceEvent = this.buildSourceAddedEvent(runId, input);
    const sourceEvents: KgEvent[] = sourceEvent ? [sourceEvent] : [];

    // ── Emit all events in a single transaction ──
    const allEvents = [...claimEvents, ...nodeEvents, ...edgeEvents, ...sourceEvents];
    const emitted = this.emitEvents(allEvents);

    return {
      entities: result.entities,
      edges: result.relationships,
      claimEvents: emitted.filter((e) => e.eventType === 'CLAIM_EXTRACTED'),
      nodeEvents: emitted.filter(
        (e) => e.eventType === 'NODE_ADDED' || e.eventType === 'ENTITY_MERGED',
      ),
      edgeEvents: emitted.filter((e) => e.eventType === 'EDGE_ADDED'),
      sourceEvents: emitted.filter((e) => e.eventType === 'SOURCE_ADDED'),
      failureEvents: [],
    };
  }

  // ── Prompt building ─────────────────────────────────────────────

  /**
   * Build the system prompt for the LLM extraction call.
   *
   * Instructs the model to return entities and relationships in a
   * structured JSON format matching LLMExtractionResultZ.
   */
  buildExtractionPrompt(_input: NormalizedExtractionInput): string {
    const jsonSchema = JSON.stringify(
      {
        type: 'object',
        properties: {
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                local_id: {
                  type: 'string',
                  description: 'Pass-scoped unique identifier (e.g. "e1", "e2")',
                },
                label: { type: 'string', description: 'Short descriptive label for the entity' },
                type: {
                  type: 'string',
                  enum: [
                    'concept',
                    'claim',
                    'source',
                    'person',
                    'org',
                    'method',
                    'dataset',
                    'work',
                  ],
                  description: 'Entity type classification',
                },
                extraction_confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description:
                    'Confidence that the entity is correctly identified from the source text',
                },
                evidence: {
                  type: 'string',
                  description: 'Verbatim quote from the source text supporting this entity',
                },
              },
              required: ['local_id', 'label', 'type', 'extraction_confidence', 'evidence'],
            },
          },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from_id: { type: 'string', description: 'local_id of the source entity' },
                to_id: { type: 'string', description: 'local_id of the target entity' },
                type: {
                  type: 'string',
                  enum: ['supports', 'contradicts', 'explains', 'implements'],
                  description: 'Relationship type',
                },
                evidence_strength: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Confidence in the relationship claim',
                },
                evidence: {
                  type: 'string',
                  description: 'Verbatim quote from the source text supporting this relationship',
                },
              },
              required: ['from_id', 'to_id', 'type', 'evidence_strength', 'evidence'],
            },
          },
        },
        required: ['entities', 'relationships'],
      },
      null,
      2,
    );

    return `You are a knowledge graph extraction assistant. Extract entities and their relationships from the provided source text.

Rules:
- Return ONLY valid JSON matching the schema below. No explanations, no markdown formatting.
- Use short, descriptive labels for entities.
- local_id values must be unique within this extraction (e.g. "e1", "e2", "e3").
- extraction_confidence: 0.0–1.0, how confident are you the entity is correctly identified.
- evidence: a verbatim quote from the source text. Must be as close to the original wording as possible.
- evidence_strength: 0.0–1.0, how strongly does the evidence support the relationship claim.
- Only extract what is explicitly stated or clearly implied by the source text.
- Do NOT fabricate entities or relationships.

Output schema:
${jsonSchema}`;
  }

  // ── Response parsing ────────────────────────────────────────────

  parseLlmResponse(raw: string): unknown {
    return parseKnowledgeGraphLlmResponse(raw);
  }

  // ── Event building ──────────────────────────────────────────────

  /**
   * Build CLAIM_EXTRACTED events for each extracted entity.
   */
  private buildClaimExtractedEvents(
    result: NormalizedExtraction,
    runId: string,
    input: NormalizedExtractionInput,
  ): KgEvent[] {
    return result.entities.map((entity) => ({
      id: generateUlid(),
      timestamp: new Date().toISOString(),
      eventType: 'CLAIM_EXTRACTED',
      eventVersion: 1,
      runId,
      batchId: null,
      actor: 'system',
      entityId: entity.local_id,
      entityType: entity.type,
      payload: JSON.stringify({
        label: entity.label,
        type: entity.type,
        extraction_confidence: entity.extraction_confidence,
        evidence: entity.evidence,
        evidence_verbatim: entity.evidence_verbatim ? 1 : 0,
        source_url: input.url ?? null,
        source_title: input.title ?? null,
        source_kind: input.sourceKind,
      }),
      payloadHash: null,
    }));
  }

  /**
   * Build a SOURCE_ADDED event for the extraction input.
   */
  private buildSourceAddedEvent(runId: string, input: NormalizedExtractionInput): KgEvent | null {
    if (!input.url && !input.title) return null;

    const sourceId = generateUlid();

    return {
      id: generateUlid(),
      timestamp: new Date().toISOString(),
      eventType: 'SOURCE_ADDED' as KgEventType,
      eventVersion: 1,
      runId,
      batchId: null,
      actor: 'system',
      entityId: sourceId,
      entityType: 'source',
      payload: JSON.stringify({
        source_id: sourceId,
        url: input.url ?? null,
        title: input.title ?? null,
        source_kind: input.sourceKind,
        retrieved_at: input.retrievedAt,
        content_preview: input.text.slice(0, 200),
      }),
      payloadHash: null,
    };
  }

  /**
   * Build an EXTRACTION_FAILED event.
   */
  private buildFailureEvent(runId: string, error: string): KgEvent {
    return {
      id: generateUlid(),
      timestamp: new Date().toISOString(),
      eventType: 'EXTRACTION_FAILED',
      eventVersion: 1,
      runId,
      batchId: null,
      actor: 'system',
      entityId: null,
      entityType: null,
      payload: JSON.stringify({
        error: error.slice(0, 500), // Sanitised — never raw LLM output
      }),
      payloadHash: null,
    };
  }

  // ── Event emission ──────────────────────────────────────────────

  /**
   * Emit events to the event store.
   *
   * All events are committed in a single transaction. Returns the
   * emitted events (with generated IDs). If the DB is not initialised,
   * returns the original events without IDs.
   */
  private emitEvents(events: KgEvent[]): KgEvent[] {
    if (events.length === 0) return [];

    try {
      return appendEvents(events);
    } catch (err) {
      logger.warn({ err, count: events.length }, 'kg: emitEvents failed');
      return [];
    }
  }
}
