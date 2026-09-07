import { createHash, randomUUID } from 'node:crypto';
import type { Instant } from '../domain/ids.js';
import type { SearchIntent } from '../domain/intent.js';
import {
  REASONING_BOUNDS,
  ReasoningPacketSchema,
  type AmbiguousQuestion,
  type PacketEvidenceExcerpt,
  type RankedCandidateView,
  type ReasoningPacket,
} from './contracts.js';
import { PacketHashSchema, ReasoningPacketIdSchema } from './ids.js';
import type { PacketHash } from './ids.js';

// ─── Regex patterns for redaction checks ──────────────────────────────

const RAW_PROFILE_KEYWORDS = /resume|cv|rawText|fullText/i;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
const STREET_ADDRESS_RE =
  /\d{1,5}\s+\w+(?:\s+\w+)*\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl|way|terrace|ter)/i;

// ─── questionsFromFlags (pure, stock strings only) ────────────────────

export function questionsFromFlags(
  candidates: readonly RankedCandidateView[],
): AmbiguousQuestion[] {
  const questions: AmbiguousQuestion[] = [];
  let qId = 0;

  for (const c of candidates) {
    for (const flag of c.flags) {
      if (questions.length >= REASONING_BOUNDS.maxQuestions) break;

      let kind: AmbiguousQuestion['kind'] | null = null;
      let text = '';

      switch (flag) {
        case 'eligibility_unknown':
          kind = 'eligibility';
          text = 'Eligibility unknown; candidate may have constraints not captured in evidence.';
          break;
        case 'conflicting_source_evidence':
          kind = 'conflict';
          text = 'Conflicting source evidence detected; resolution requires clarification.';
          break;
        case 'identified_position_requirement':
          kind = 'eligibility';
          text = 'Identified-position requirement present; eligibility unknown.';
          break;
        case 'registration_not_evidenced':
          kind = 'missing_evidence';
          text = 'Registration required but not evidenced in available sources.';
          break;
        default:
          continue;
      }

      qId += 1;
      questions.push({
        questionId: `q-${String(qId)}`,
        kind,
        text,
        postingId: c.postingId,
        evidenceRefs: [],
      });
    }
    if (questions.length >= REASONING_BOUNDS.maxQuestions) break;
  }

  return questions;
}

// ─── canonical hash ───────────────────────────────────────────────────

export function hashReasoningPacket(packet: Omit<ReasoningPacket, 'packetHash'>): PacketHash {
  const keys = Object.keys(packet).sort();
  const sorted = Object.fromEntries(keys.map((k) => [k, (packet as Record<string, unknown>)[k]]));
  const canonical = JSON.stringify(sorted);
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return PacketHashSchema.parse(hex);
}

// ─── assertPacketRedacted ─────────────────────────────────────────────

const SAFE_STRUCTURAL_KEYS = new Set([
  'schemaVersion',
  'packetId',
  'packetHash',
  'producedAt',
  'runId',
  'rankingRevision',
  'profileRevision',
  'intentStrictness',
  'unknownPolicy',
  'redacted',
  'allowedResponseSchema',
  'packetRevision',
  'versions',
]);

function collectStrings(obj: unknown, out: string[]): void {
  if (typeof obj === 'string') {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectStrings(item, out);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!SAFE_STRUCTURAL_KEYS.has(k)) collectStrings(v, out);
    }
  }
}

export function assertPacketRedacted(packet: ReasoningPacket): void {
  const textFields: string[] = [];
  collectStrings(packet.candidates, textFields);
  collectStrings(packet.evidenceExcerpts, textFields);
  collectStrings(packet.questions, textFields);

  for (const field of textFields) {
    if (RAW_PROFILE_KEYWORDS.test(field)) throwObject('RAW_PROFILE_EXPOSURE');
    if (EMAIL_RE.test(field)) throwObject('RAW_PROFILE_EXPOSURE');
    if (PHONE_RE.test(field)) throwObject('RAW_PROFILE_EXPOSURE');
    if (STREET_ADDRESS_RE.test(field)) throwObject('RAW_PROFILE_EXPOSURE');
  }

  for (const ex of packet.evidenceExcerpts) {
    if (ex.excerpt.length > REASONING_BOUNDS.maxExcerptChars) {
      throwObject('RAW_PROFILE_EXPOSURE');
    }
  }
}

function throwObject(code: string): never {
  const err = new Error(code);
  (err as unknown as { reasoningCode: string }).reasoningCode = code;
  throw err;
}

// ─── buildReasoningPacket ─────────────────────────────────────────────

interface BuildPacketInput {
  runId: string;
  rankingRevision: string;
  rankingVersion: string;
  packVersions: string[];
  extractorVersion?: string;
  profileRevision?: string;
  intent: Pick<SearchIntent, 'strictness' | 'unknownPolicy' | 'topK' | 'budgets'>;
  candidates: RankedCandidateView[];
  questions: AmbiguousQuestion[];
  excerpts: PacketEvidenceExcerpt[];
  now: Instant;
}

export function buildReasoningPacket(input: BuildPacketInput): ReasoningPacket {
  // 1. Slice candidates in rank order (already ranked by W9)
  let candidates = input.candidates.slice(0, REASONING_BOUNDS.maxCandidates);

  // 2. Slice questions and excerpts
  const questions = input.questions.slice(0, REASONING_BOUNDS.maxQuestions);
  const excerpts = input.excerpts.slice(0, REASONING_BOUNDS.maxEvidenceExcerpts);

  // 3. Compute allowedEvidenceIds = sorted unique union
  const evidenceIdSet = new Set<string>();
  for (const c of candidates) {
    for (const ref of c.evidenceRefs) evidenceIdSet.add(ref);
  }
  for (const q of questions) {
    for (const ref of q.evidenceRefs) evidenceIdSet.add(ref);
  }
  for (const e of excerpts) {
    evidenceIdSet.add(e.evidenceId);
  }

  const packetId = ReasoningPacketIdSchema.parse(`reasoning-packet:${randomUUID()}`);

  let packetWithoutHash: Omit<ReasoningPacket, 'packetHash'> = {
    schemaVersion: '1.0.0',
    packetId,
    packetRevision: 0,
    producedAt: input.now,
    runId: input.runId,
    versions: {
      contractVersion: '1.0.0',
      rankingVersion: input.rankingVersion,
      packVersions: input.packVersions,
      extractorVersion: input.extractorVersion,
      promptVersion: 'jobs.reasoning.prompt.v1',
    },
    rankingRevision: input.rankingRevision,
    profileRevision: input.profileRevision,
    intentStrictness: input.intent.strictness,
    unknownPolicy: input.intent.unknownPolicy,
    candidates,
    questions,
    evidenceExcerpts: excerpts,
    allowedEvidenceIds: [...evidenceIdSet].sort() as ReasoningPacket['allowedEvidenceIds'],
    allowedResponseSchema: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
    },
    redacted: true,
  };

  // 4. Check byte budget — drop lowest-rank candidates until fits
  if (
    Buffer.byteLength(JSON.stringify(packetWithoutHash), 'utf8') > REASONING_BOUNDS.maxPacketBytes
  ) {
    while (candidates.length > 0) {
      candidates = candidates.slice(0, -1);
      packetWithoutHash = { ...packetWithoutHash, candidates };
      if (
        Buffer.byteLength(JSON.stringify(packetWithoutHash), 'utf8') <=
        REASONING_BOUNDS.maxPacketBytes
      )
        break;
    }
    if (
      Buffer.byteLength(JSON.stringify(packetWithoutHash), 'utf8') > REASONING_BOUNDS.maxPacketBytes
    ) {
      throwObject('PACKET_BUDGET_EXCEEDED');
    }
  }

  // 5. Assert redacted
  assertPacketRedacted(packetWithoutHash as ReasoningPacket);

  // 6–7. Set hash
  const packetHash = hashReasoningPacket(packetWithoutHash);

  const packet = ReasoningPacketSchema.parse({ ...packetWithoutHash, packetHash });
  return packet;
}
