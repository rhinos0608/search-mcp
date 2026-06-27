/**
 * answerFindings — extract atomic, source-grounded findings from a ReAct agent's
 * final answer.
 *
 * The agent emits a cited narrative: claim sentences carrying [N] markers, usually
 * followed by a trailing references/sources list. Splitting that whole narrative on
 * sentence boundaries and keeping every [N]-bearing fragment turned reference-list
 * entries ("[1] Title — https://…") and mid-sentence fragments into junk findings.
 *
 * This module instead (1) drops the references section, (2) strips citation markers
 * out of the claim text, and (3) keeps only substantive claim sentences. When an LLM
 * is available it first asks for genuinely atomic claims, falling back to the
 * deterministic path on any failure.
 */

import type { Finding } from '../types.js';
import type { DeepResearchLlmClient } from '../llm/chat.js';
import { logger } from '../../logger.js';

type FindingDraft = Omit<Finding, 'id' | 'createdAt'>;

export interface AnswerFindingInput {
  /** The agent's final answer (raw, before any "Sources:" list is appended). */
  answer: string;
  /** Citation index ([N]) → state source id. */
  sourceMap: Map<number, string>;
  /** Sub-question IDs to attribute each finding to. */
  subQuestionIds: string[];
}

const CITATION_MARKER = /\[(\d+)\]/g;

const REFERENCES_HEADER = /^(?:sources?|references?|citations?|bibliography|works cited)\s*:?\s*$/i;

const ATOMIC_CLAIMS_SYSTEM = `You decompose a cited research answer into atomic factual claims.

Rules:
- Each claim is ONE standalone sentence asserting a SINGLE fact. Split compound sentences.
- Preserve the citation numbers: for each claim list the [N] numbers from the source text that support it.
- Do NOT invent citations. Only use numbers that appear next to the supporting text.
- Ignore any "Sources"/"References" list at the end — those are not claims.
- Skip filler, transitions, and meta-commentary; keep only substantive factual claims.

Output ONLY valid JSON:
{"claims":[{"claim":"<single factual sentence, no [N] markers>","citations":[1,2]}]}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Drop a trailing references/sources section so its "[N] Title — URL" entries are
 * never mistaken for claims. Cuts from the first standalone reference header line.
 */
export function stripReferencesSection(answer: string): string {
  const lines = answer.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const normalized = (lines[i] ?? '')
      .trim()
      .replace(/\*\*/g, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*]\s*/, '');
    if (REFERENCES_HEADER.test(normalized)) {
      return lines.slice(0, i).join('\n');
    }
  }
  return answer;
}

/** Remove inline citation markers ([1], [1][2]) and tidy resulting whitespace/punctuation. */
export function cleanCitationMarkers(text: string): string {
  return text
    .replace(/\s*\[(\d+)\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/** A claim must read like a sentence, not a heading, URL, or bracket fragment. */
function isSubstantiveClaim(text: string): boolean {
  if (text.length < 25) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (!/[a-z]/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 5;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toDraft(claim: string, sourceIds: string[], subQuestionIds: string[]): FindingDraft {
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    claim,
    normalizedClaim,
    sourceIds,
    subQuestionIds: [...subQuestionIds],
    evidenceSummary: claim,
    evidenceDirectness: 'direct',
    freshnessSensitive: false,
    lastUpdated: new Date().toISOString(),
    claimType: 'primary',
  };
}

function resolveSourceIds(citationNums: number[], sourceMap: Map<number, string>): string[] {
  return dedupeStrings(
    citationNums
      .map((n) => sourceMap.get(n))
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

/**
 * Deterministic extraction: drop the references section, then keep each substantive,
 * source-grounded claim sentence with citation markers removed. Never emits the
 * reference-list bracket fragments that the old splitter produced.
 */
export function extractFindingsFromAnswerRuleBased(input: AnswerFindingInput): FindingDraft[] {
  const { sourceMap, subQuestionIds } = input;
  const body = stripReferencesSection(input.answer);
  const out: FindingDraft[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(body)) {
    // A sentence that opens with a citation marker is a reference-list entry, not a claim.
    if (/^\[\d+\]/.test(sentence)) continue;

    const citations = [...sentence.matchAll(CITATION_MARKER)];
    if (citations.length === 0) continue;

    const sourceIds = resolveSourceIds(
      citations.map((m) => parseInt(m[1] ?? '0', 10)),
      sourceMap,
    );
    if (sourceIds.length === 0) continue;

    const claim = cleanCitationMarkers(sentence);
    if (!isSubstantiveClaim(claim)) continue;

    const key = claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140);
    if (seen.has(key)) {
      // Merge sourceIds into existing draft instead of skipping
      const existing = out.find(
        (d) => d.claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140) === key,
      );
      if (existing) {
        const existingIds = new Set(existing.sourceIds);
        for (const id of sourceIds) {
          if (!existingIds.has(id)) existing.sourceIds.push(id);
        }
      }
      continue;
    }
    seen.add(key);

    out.push(toDraft(claim, sourceIds, subQuestionIds));
  }

  return out;
}

/**
 * LLM-assisted extraction of genuinely atomic claims. Falls back to the rule-based
 * path on any LLM/parse failure or when the LLM yields nothing source-grounded.
 */
export async function extractFindingsFromAnswerLlm(
  llm: DeepResearchLlmClient,
  input: AnswerFindingInput,
): Promise<FindingDraft[]> {
  const body = stripReferencesSection(input.answer);
  if (body.trim().length < 40) return extractFindingsFromAnswerRuleBased(input);

  let parsed: { success: true; data: unknown } | { success: false };
  try {
    const result = await llm.callJSON<{ claims: unknown }>({
      model: 'worker',
      temperature: 0.2,
      maxTokens: 3000,
      messages: [
        { role: 'system', content: ATOMIC_CLAIMS_SYSTEM },
        { role: 'user', content: `Research answer:\n\n${body}` },
      ],
    });
    parsed = result.success ? { success: true, data: result.data } : { success: false };
  } catch (err) {
    logger.warn({ err }, 'answerFindings: LLM atomic extraction threw, using rule-based');
    return extractFindingsFromAnswerRuleBased(input);
  }

  if (!parsed.success || !isRecord(parsed.data) || !Array.isArray(parsed.data.claims)) {
    logger.warn('answerFindings: LLM atomic extraction unusable, using rule-based');
    return extractFindingsFromAnswerRuleBased(input);
  }

  const out: FindingDraft[] = [];
  const seen = new Set<string>();

  for (const entry of parsed.data.claims) {
    if (!isRecord(entry) || typeof entry.claim !== 'string') continue;

    const claim = cleanCitationMarkers(entry.claim);
    if (!isSubstantiveClaim(claim)) continue;

    const citationNums = Array.isArray(entry.citations)
      ? entry.citations
          .map((n) => (typeof n === 'number' ? n : parseInt(String(n), 10)))
          .filter((n) => Number.isFinite(n))
      : [];
    const sourceIds = resolveSourceIds(citationNums, input.sourceMap);
    if (sourceIds.length === 0) continue;

    const key = claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140);
    if (seen.has(key)) {
      // Merge sourceIds into existing draft instead of skipping
      const existing = out.find(
        (d) => d.claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140) === key,
      );
      if (existing) {
        const existingIds = new Set(existing.sourceIds);
        for (const id of sourceIds) {
          if (!existingIds.has(id)) existing.sourceIds.push(id);
        }
      }
      continue;
    }
    seen.add(key);

    out.push(toDraft(claim, sourceIds, input.subQuestionIds));
  }

  return out.length > 0 ? out : extractFindingsFromAnswerRuleBased(input);
}
