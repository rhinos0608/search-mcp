import { embedTexts } from '../rag/embedding.js';
import { logger } from '../logger.js';
import {
  type AuthorityClass,
  type ClaimAuthorityRequirement,
  type ClaimRisk,
  type EvidenceAlignment,
  type EvidenceGraph,
  type EvidenceGraphEdge,
  type EvidenceGraphFindingNode,
  type EvidenceItem,
  type Finding,
  type FindingCluster,
  type FindingClusterEdge,
  type GroundedClaim,
  type GroundingResult,
  type LatestOfficialVersion,
  type ReleaseEntity,
  type ReportAuditIssue,
  type ReportAuditResult,
  type ResearchClaim,
  type ResearchReport,
  type SourceEntry,
  type SourceRecord,
  type SourceType,
  type SynthesisClaimNode,
  type TemporalClaim,
  type TemporalEventType,
} from './types.js';
import type { EmbedRequest, EmbedResponse } from '../rag/embedding.js';
import {
  type ProjectContext,
  buildDefaultProjectContext,
  domainMatches,
  matchDomainRule,
} from './projectContext.js';

// ── General-purpose regexes (project-agnostic) ─────────────────────────────

const PROTOCOL_RELEASE_RE =
  /\b(released|release|launched|introduced|deprecated|stable|beta|major redesign|latest|now supports|no longer|version|v\d+(?:\.\d+)*(?:-[\w.]+)?)\b/i;
const VERSION_RE =
  /(?:\bv\d+(?:\.\d+)*(?:-[\w.]+)?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+\.\d+\.\d+(?:-[\w.]+)?\b)/i;
const PACKAGE_RE = /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/i;
const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'but',
  'can',
  'could',
  'does',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'may',
  'more',
  'not',
  'now',
  'of',
  'official',
  'on',
  'or',
  'released',
  'release',
  'says',
  'since',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'which',
  'with',
]);
const OFFICIAL_AUTHORITY = new Set<AuthorityClass>([
  'official_spec',
  'official_changelog',
  'official_repo',
  'official_vendor',
]);

// ── Default context (lazy-built, no hardcoded projects) ────────────────────

let _defaultCtx: ProjectContext | undefined;
function defaultCtx(): ProjectContext {
  return (_defaultCtx ??= buildDefaultProjectContext());
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

export function classifySourceAuthority(
  source: Pick<SourceEntry, 'url' | 'domain' | 'sourceType'>,
  projectContext?: ProjectContext,
): AuthorityClass {
  const domain = (source.domain || hostname(source.url)).toLowerCase();
  const path = pathname(source.url);
  const ctx = projectContext ?? defaultCtx();

  // 1. Check project-specific domain authority rules (highest priority, checked in order)
  for (const rule of ctx.domainAuthorityRules) {
    if (matchDomainRule(rule, domain, path)) {
      return rule.authority;
    }
  }

  // 2. Check project-specific GitHub repo patterns
  if (domain === 'github.com') {
    const pathParts = path.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      const owner = pathParts[0] ?? '';
      const repo = pathParts[1] ?? '';
      for (const rule of ctx.repoAuthorityRules) {
        if (rule.owner.toLowerCase() === owner.toLowerCase()) {
          const repoPattern = rule.repoPattern;
          try {
            const escapedPattern = repoPattern
              .replace(/[[\]\\*.+?^${}()|]/g, '\\$&')
              .replace(/\\\*/g, '[^/]*');
            if (new RegExp(`^${escapedPattern}$`, 'i').test(repo)) {
              return rule.authority;
            }
          } catch {
            // Invalid pattern, skip this rule
          }
        }
      }
    }
  }

  // 3. Check vendor SDK domains
  for (const rule of ctx.vendorSdkDomains) {
    if (matchDomainRule(rule, domain, path)) {
      return rule.authority;
    }
  }

  // 4. Check package registries
  if (ctx.registries.some((r) => domainMatches(r.domain, domain))) {
    return 'package_registry';
  }

  // 5. Source-type-based fallback
  if (source.sourceType === 'official_docs') return 'official_spec';
  if (source.sourceType === 'documentation') return 'vendor_sdk_docs';
  if (source.sourceType === 'wikipedia') return 'encyclopedia';
  if (
    source.sourceType === 'reddit' ||
    source.sourceType === 'hackernews' ||
    source.sourceType === 'youtube' ||
    source.sourceType === 'forum' ||
    source.sourceType === 'social'
  ) {
    return 'forum_social';
  }
  if (source.sourceType === 'news' || source.sourceType === 'gdelt') return 'news';
  if (source.sourceType === 'vendor_docs') return 'vendor_sdk_docs';
  if (source.sourceType === 'package_registry') return 'package_registry';
  return 'third_party_analysis';
}

export function inferSourceTypeFromUrl(
  url: string,
  fallback: SourceType,
  projectContext?: ProjectContext,
): SourceType {
  const domain = hostname(url);
  const path = pathname(url);
  const ctx = projectContext ?? defaultCtx();

  // 1. Check project-specific sourceType rules first
  for (const rule of ctx.sourceTypeRules) {
    if (!domainMatches(rule.domain, domain)) continue;
    if (rule.pathPrefix !== undefined && !path.startsWith(rule.pathPrefix)) continue;
    return rule.sourceType as SourceType;
  }

  // 2. Common well-known domains (project-agnostic)
  if (domain === 'github.com') return 'github';
  if (ctx.registries.some((r) => domainMatches(r.domain, domain))) {
    return 'package_registry';
  }
  if (domain === 'wikipedia.org' || domain.endsWith('.wikipedia.org')) return 'wikipedia';
  if (domain === 'reddit.com' || domain.endsWith('.reddit.com')) return 'reddit';
  if (domain === 'news.ycombinator.com' || domain === 'ycombinator.com') return 'hackernews';
  if (domain === 'stackoverflow.com') return 'stackoverflow';

  // 3. Heuristic: domains containing docs/learn/developer are likely vendor docs
  if (domain.includes('docs.') || domain.includes('learn.') || domain.includes('developer.')) {
    return 'vendor_docs';
  }

  return fallback;
}

export function isPrimaryAuthority(authorityClass: AuthorityClass): boolean {
  return OFFICIAL_AUTHORITY.has(authorityClass);
}

function bestAuthority(sources: SourceEntry[], projectContext?: ProjectContext): AuthorityClass {
  const ctx = projectContext ?? defaultCtx();
  const order: AuthorityClass[] = [
    'official_spec',
    'official_changelog',
    'official_repo',
    'official_vendor',
    'package_registry',
    'vendor_sdk_docs',
    'news',
    'third_party_analysis',
    'encyclopedia',
    'forum_social',
    'unknown',
  ];
  let best: AuthorityClass = 'unknown';
  let bestIdx: number = order.length;
  for (const source of sources) {
    const cls: AuthorityClass = source.authorityClass ?? classifySourceAuthority(source, ctx);
    const idx: number = order.indexOf(cls);
    if (idx !== -1 && idx < bestIdx) {
      best = cls;
      bestIdx = idx;
    }
  }
  return best;
}

function extractVersion(text: string): string | undefined {
  const match: RegExpExecArray | null = VERSION_RE.exec(text);
  return match?.[0];
}

function extractEventDate(text: string): string | undefined {
  const iso: string | undefined = /\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0];
  if (iso) return iso;
  const named: string | undefined =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i.exec(
      text,
    )?.[0];
  if (!named) return undefined;
  const parts: RegExpExecArray | null = /^(\w+)\s+(\d{1,2}),\s+(\d{4})$/i.exec(named);
  if (!parts) return undefined;
  const monthNames: string[] = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const month: number = monthNames.findIndex((m: string) =>
    (parts[1] ?? '').toLowerCase().startsWith(m),
  );
  const day = Number(parts[2]);
  const year = Number(parts[3]);
  if (month < 0 || Number.isNaN(day) || Number.isNaN(year)) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function contentTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9@._/-]+/)
      .map((token: string) => token.replace(/^[._/-]+|[._/-]+$/g, ''))
      .filter((token: string) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function anchorTerms(text: string): string[] {
  const anchors = new Set<string>();
  for (const match of text.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi))
    anchors.add(match[0].toLowerCase());
  for (const match of text.matchAll(/\bv?\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi))
    anchors.add(match[0].toLowerCase());
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) anchors.add(match[0]);
  const namedDate =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/gi;
  for (const match of text.matchAll(namedDate)) anchors.add(match[0].toLowerCase());
  return [...anchors];
}

export function assessEvidenceAlignment(
  finding: Pick<Finding, 'claim' | 'evidenceSummary' | 'evidenceExcerpt'>,
): EvidenceAlignment {
  const evidenceText: string = [finding.evidenceExcerpt, finding.evidenceSummary]
    .filter(Boolean)
    .join(' ');
  const claimTerms: Set<string> = contentTerms(finding.claim);
  const evidenceTerms: Set<string> = contentTerms(evidenceText);
  const matchedTerms: string[] = [...claimTerms]
    .filter((term: string) => evidenceTerms.has(term))
    .sort();
  const lexicalScore: number =
    claimTerms.size === 0 || evidenceTerms.size === 0
      ? 0
      : matchedTerms.length / Math.min(claimTerms.size, evidenceTerms.size);
  const anchors: string[] = anchorTerms(finding.claim);
  const missingAnchorTerms: string[] = anchors.filter(
    (anchor: string) => !evidenceText.toLowerCase().includes(anchor),
  );
  const anchorScore: number =
    anchors.length === 0
      ? lexicalScore
      : (anchors.length - missingAnchorTerms.length) / anchors.length;
  const score: number = Math.max(
    0,
    Math.min(1, anchors.length > 0 ? Math.min(lexicalScore, anchorScore) : lexicalScore),
  );
  const snippet: string = evidenceText.trim().slice(0, 240);
  return {
    score,
    method: 'lexical_anchor_overlap',
    matchedTerms: matchedTerms.slice(0, 12),
    missingAnchorTerms,
    ...(snippet ? { evidenceSnippet: snippet } : {}),
    explanation:
      missingAnchorTerms.length > 0
        ? `Evidence does not contain anchor term(s): ${missingAnchorTerms.join(', ')}.`
        : `Evidence shares ${String(matchedTerms.length)} content term(s) with the claim.`,
  };
}

type AlignmentEmbeddingClient = (request: EmbedRequest) => Promise<EmbedResponse>;

function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function mergeSemanticAlignment(
  lexical: EvidenceAlignment,
  semanticScore: number,
  semanticMatches: NonNullable<EvidenceAlignment['semanticMatches']>,
): EvidenceAlignment {
  const semanticLift = semanticScore >= 0.72 ? semanticScore : 0;
  const scoreBeforeAnchorCap = Math.max(lexical.score, semanticLift);
  const score =
    lexical.missingAnchorTerms.length > 0
      ? Math.min(scoreBeforeAnchorCap, 0.65)
      : scoreBeforeAnchorCap;
  return {
    ...lexical,
    score: Math.max(0, Math.min(1, score)),
    method: semanticMatches.length > 0 ? 'hybrid_lexical_semantic' : lexical.method,
    semanticScore,
    ...(semanticMatches.length > 0 ? { semanticMatches } : {}),
    explanation:
      `${lexical.explanation} Semantic evidence similarity=${semanticScore.toFixed(2)}` +
      (lexical.missingAnchorTerms.length > 0
        ? '; anchor guardrail capped the alignment score.'
        : '.'),
  };
}

export async function enrichFindingsWithSemanticEvidenceAlignment(
  findings: Finding[],
  embedder: AlignmentEmbeddingClient = embedTexts,
): Promise<Finding[]> {
  if (findings.length === 0) return findings;
  const candidates = findings
    .map((finding: Finding, index: number) => ({ finding, index }))
    .filter(({ finding }) =>
      [finding.evidenceSummary, finding.evidenceExcerpt].some(
        (part) => part && part.trim().length > 0,
      ),
    )
    .slice(0, 80);
  if (candidates.length === 0) return findings;

  const texts: string[] = candidates.flatMap(({ finding }) => [
    finding.claim,
    [finding.evidenceSummary, finding.evidenceExcerpt].filter(Boolean).join('\n'),
  ]);

  try {
    const response: EmbedResponse = await embedder({
      texts,
      mode: 'document',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
    });
    const enriched: Finding[] = [...findings];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      if (!candidate) continue;
      const claimEmbedding: number[] | undefined = response.embeddings[candidateIndex * 2];
      const evidenceEmbedding: number[] | undefined = response.embeddings[candidateIndex * 2 + 1];
      const semanticScore: number = cosineSimilarity(claimEmbedding, evidenceEmbedding);
      const lexical: EvidenceAlignment = assessEvidenceAlignment(candidate.finding);
      const evidenceText: string = [
        candidate.finding.evidenceSummary,
        candidate.finding.evidenceExcerpt,
      ]
        .filter(Boolean)
        .join(' ');
      const semanticMatches: NonNullable<EvidenceAlignment['semanticMatches']> =
        semanticScore >= 0.72
          ? [
              {
                field: candidate.finding.evidenceExcerpt
                  ? ('evidenceExcerpt' as const)
                  : ('evidenceSummary' as const),
                score: semanticScore,
                snippet: evidenceText.trim().slice(0, 240),
              },
            ]
          : [];
      enriched[candidate.index] = {
        ...candidate.finding,
        evidenceAlignment: mergeSemanticAlignment(lexical, semanticScore, semanticMatches),
      };
    }
    return enriched;
  } catch (err: unknown) {
    logger.debug({ err }, 'Semantic evidence alignment unavailable; using lexical anchor overlap');
    return findings.map((finding: Finding) => ({
      ...finding,
      evidenceAlignment: finding.evidenceAlignment ?? assessEvidenceAlignment(finding),
    }));
  }
}

// ── Phase 1: Synthesis claim grounding ────────────────────────────────────

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NAMED_DATE_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/gi;
const NUMBER_RE = /\b\d{3,}\b/g;
const MULTI_WORD_PROPER_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const SINGLE_PROPER_RE = /\b[A-Z][a-z]{2,}\b/g;

// Words that are commonly capitalized by grammar, not by proper-noun status.
const SENTENCE_INITIAL_BLACKLIST = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'It',
  'They',
  'We',
  'You',
  'He',
  'She',
  'His',
  'Her',
  'Our',
  'Their',
  'Its',
  'If',
  'When',
  'Where',
  'While',
  'Since',
  'Because',
  'Although',
  'However',
  'But',
  'And',
  'For',
  'With',
  'From',
  'Into',
  'After',
  'Before',
  'During',
  'In',
  'On',
  'At',
  'To',
  'By',
  'As',
  'Or',
  'Not',
  'No',
  'Yes',
  'Each',
  'Every',
  'Any',
  'Some',
  'All',
  'Both',
  'Many',
  'Much',
  'Few',
  'More',
  'Most',
  'Other',
  'Such',
  'Only',
  'Just',
  'Also',
  'Then',
  'Now',
  'Yet',
  'So',
  'Thus',
  'Therefore',
  'There',
  'Here',
  'An',
  'Is',
  'Was',
  'Are',
  'Were',
  'Be',
  'Been',
  'Has',
  'Have',
  'Had',
  'Do',
  'Does',
  'Did',
  'Can',
  'Could',
  'Will',
  'Would',
  'Should',
  'May',
  'Might',
  'Must',
  'Shall',
  'Being',
  'Having',
]);

/** Extract dates (ISO + named), numbers, and proper-noun entities from text. */
function extractClaimEntities(text: string): {
  dates: string[];
  numbers: string[];
  entities: string[];
} {
  const dates: string[] = [];
  for (const m of text.matchAll(ISO_DATE_RE)) dates.push(m[0]);
  for (const m of text.matchAll(NAMED_DATE_RE)) dates.push(m[0].toLowerCase());
  const numbers = [...new Set(text.match(NUMBER_RE) ?? [])];
  const multiWordEntities = new Set(text.match(MULTI_WORD_PROPER_RE) ?? []);
  const singleWordEntities = [...text.matchAll(SINGLE_PROPER_RE)]
    .map((m) => m[0])
    .filter((w) => !SENTENCE_INITIAL_BLACKLIST.has(w) && w.length > 2);
  for (const w of singleWordEntities) multiWordEntities.add(w);
  const entities = [...multiWordEntities];
  return { dates: [...new Set(dates)], numbers, entities };
}

/**
 * Ground synthesis claim sentences against source chunk embeddings.
 *
 * Splits the narrative into sentences, embeds them, computes cosine similarity
 * against each source chunk's embedding, and flags ungrounded claims whose
 * entities (dates, numbers, proper nouns) cannot be found in any source text.
 */
export async function groundSynthesisClaims(
  narrativeMarkdown: string,
  sourceChunks: { id: string; text: string; embedding: number[] }[],
  embedder: AlignmentEmbeddingClient = embedTexts,
  options?: { groundingThreshold?: number },
): Promise<GroundingResult> {
  const threshold = options?.groundingThreshold ?? 0.72;

  // Short-circuit: no chunks to ground against
  if (sourceChunks.length === 0) {
    const sentences = splitSentences(narrativeMarkdown)
      .filter((s: string) => s.length > 24)
      .slice(0, 80);
    const claims: GroundedClaim[] = sentences.map((text: string) => ({
      text,
      nearestSourceScore: 0,
      grounded: false,
    }));
    return {
      claims,
      groundedCount: 0,
      ungroundedCount: claims.length,
      warnings: [
        'No source chunks available — synthesis claims could not be grounded against evidence.',
      ],
    };
  }

  const sentences: string[] = splitSentences(narrativeMarkdown)
    .filter((s: string) => s.length > 24)
    .slice(0, 80);

  if (sentences.length === 0) {
    return { claims: [], groundedCount: 0, ungroundedCount: 0, warnings: [] };
  }

  let embeddings: number[][];
  try {
    const response = await embedder({
      texts: sentences,
      mode: 'document',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
    });
    embeddings = response.embeddings;
  } catch (err) {
    logger.debug({ err }, 'Synthesis claim grounding embedding failed; skipping grounding');
    const claims: GroundedClaim[] = sentences.map((text: string) => ({
      text,
      nearestSourceScore: 0,
      grounded: false,
    }));
    return {
      claims,
      groundedCount: 0,
      ungroundedCount: claims.length,
      warnings: [
        'Embedding failed during claim grounding — claims could not be verified against source evidence.',
      ],
    };
  }

  const claims: GroundedClaim[] = [];
  let groundedCount = 0;

  // Build combined source text once for entity validation (hoisted outside loop)
  const sourceTexts = sourceChunks
    .map((c) => c.text)
    .join('\n')
    .toLowerCase();

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i] ?? '';
    const sentenceEmbedding = embeddings[i];

    // Find nearest source chunk
    let bestScore = 0;
    let bestChunkId: string | undefined;

    for (const chunk of sourceChunks) {
      const score = cosineSimilarity(sentenceEmbedding, chunk.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestChunkId = chunk.id;
      }
    }

    const grounded = bestScore >= threshold;
    if (grounded) groundedCount++;

    // Entity validation: check dates, numbers, and proper nouns against source text
    const { dates, numbers, entities } = extractClaimEntities(sentence);
    const unverifiedDates: string[] = [];
    const unverifiedNumbers: string[] = [];
    const unverifiedEntities: string[] = [];

    for (const d of dates) {
      if (!sourceTexts.includes(d.toLowerCase())) unverifiedDates.push(d);
    }
    for (const n of numbers) {
      if (!sourceTexts.includes(n)) unverifiedNumbers.push(n);
    }
    for (const e of entities) {
      if (!sourceTexts.includes(e.toLowerCase())) unverifiedEntities.push(e);
    }

    const claim: GroundedClaim = {
      text: sentence,
      nearestSourceScore: bestScore,
      ...(bestChunkId ? { nearestSourceChunkId: bestChunkId } : {}),
      grounded,
      ...(unverifiedDates.length > 0 ? { unverifiedDates } : {}),
      ...(unverifiedNumbers.length > 0 ? { unverifiedNumbers } : {}),
      ...(unverifiedEntities.length > 0 ? { unverifiedEntities } : {}),
    };
    claims.push(claim);
  }

  // Build warnings for ungrounded claims
  const warnings: string[] = [];
  const ungroundedCount = claims.length - groundedCount;

  if (ungroundedCount > 0) {
    const ungroundedTexts = claims
      .filter((c) => !c.grounded)
      .slice(0, 5)
      .map((c) => `"${c.text.slice(0, 100)}"`);
    warnings.push(
      `${String(ungroundedCount)} of ${String(claims.length)} synthesis claim(s) fall below the grounding threshold ` +
        `(${String(threshold)}). First ungrounded: ${ungroundedTexts.join('; ')}.`,
    );

    // Check entity-level issues
    const claimsWithUnverifiedEntities = claims.filter(
      (c) =>
        !c.grounded &&
        ((c.unverifiedEntities?.length ?? 0) > 0 || (c.unverifiedDates?.length ?? 0) > 0),
    );
    if (claimsWithUnverifiedEntities.length > 0) {
      warnings.push(
        `${String(claimsWithUnverifiedEntities.length)} ungrounded claim(s) contain entities (dates, numbers, proper nouns) ` +
          `not found in any source chunk. These should be treated as uncertainties.`,
      );
    }

    if (ungroundedCount / claims.length > 0.3) {
      warnings.push(
        'More than 30% of synthesis claims are ungrounded. The narrative may contain significant unsupported content.',
      );
    }
  }

  return { claims, groundedCount, ungroundedCount, warnings };
}

function eventTypeFor(text: string): TemporalEventType {
  if (/\breleased?\b/i.test(text)) return 'released';
  if (/\bannounced?\b/i.test(text)) return 'announced';
  if (/\bpropos(?:ed|al)\b/i.test(text)) return 'proposed';
  if (/\bdeprecated?\b/i.test(text)) return 'deprecated';
  if (/\bupdated?\b/i.test(text)) return 'updated';
  if (/\bdocumented?\b/i.test(text)) return 'documented';
  if (/\bdiscuss(?:ed|es|ion)\b/i.test(text)) return 'discussed';
  return 'unknown';
}

export function normalizeReleaseEntity(
  text: string,
  sources: SourceEntry[] = [],
  projectContext?: ProjectContext,
): ReleaseEntity {
  const sourceText: string = sources.map((s: SourceEntry) => `${s.title} ${s.url}`).join(' ');
  const combined = `${text} ${sourceText}`;
  const pkg: string | undefined = PACKAGE_RE.exec(combined)?.[0];
  const version: string | undefined = extractVersion(combined);
  const sourceIds: string[] = sources.map((s: SourceEntry) => s.id);
  const ctx = projectContext ?? defaultCtx();
  const projectPattern = ctx.projectTextPattern;

  // 1. Known package match
  if (pkg) {
    const known = ctx.knownPackages[pkg.toLowerCase()];
    if (known) {
      return {
        canonicalName: known.projectCanonicalName ?? known.packageName,
        entityType: known.entityType ?? 'package',
        ...(known.owner ? { owner: known.owner } : {}),
        ...(known.ecosystem ? { ecosystem: known.ecosystem } : {}),
        packageName: known.packageName,
        ...(version ? { version } : {}),
        sourceIds,
        confidence: 0.92,
      };
    }
    // Unknown package — still treat as package entity
    return {
      canonicalName: pkg,
      entityType: 'package',
      packageName: pkg,
      ...(version ? { version } : {}),
      sourceIds,
      confidence: 0.78,
    };
  }

  // 2. Project match (if the text mentions the research subject and we have official sources)
  if (projectPattern?.test(combined)) {
    const officialSpec: boolean = sources.some((s: SourceEntry) => {
      const cls: AuthorityClass = s.authorityClass ?? classifySourceAuthority(s, ctx);
      return cls === 'official_spec' || cls === 'official_changelog';
    });

    if (officialSpec || /\b\d{4}-\d{2}-\d{2}\b/.test(combined)) {
      return {
        canonicalName: ctx.canonicalName,
        entityType: officialSpec ? 'specification' : 'protocol',
        owner: ctx.canonicalName,
        ...(version ? { version } : {}),
        sourceIds,
        confidence: officialSpec ? 0.9 : 0.72,
      };
    }

    return {
      canonicalName: ctx.canonicalName,
      entityType: 'protocol',
      ...(version ? { version } : {}),
      sourceIds,
      confidence: 0.62,
    };
  }

  return {
    canonicalName: 'unknown',
    entityType: 'unknown',
    ...(version ? { version } : {}),
    sourceIds,
    confidence: 0.35,
  };
}

export function authorityRequirementForClaim(
  text: string,
  entity: ReleaseEntity,
  projectContext?: ProjectContext,
): ClaimAuthorityRequirement {
  const ctx = projectContext ?? defaultCtx();
  const isProjectMentioned = ctx.projectTextPattern?.test(text) === true;

  // Protocol/specification release claims require primary authority
  if (entity.entityType === 'protocol' || entity.entityType === 'specification') {
    if (PROTOCOL_RELEASE_RE.test(text)) return 'primary_required';
    if (VERSION_RE.test(text)) return 'primary_preferred';
  }

  // Package entity framed as a protocol-level release also demands primary authority.
  // Catches: "Project X released v2 beta as a protocol release" backed by package sources.
  if (
    entity.entityType === 'package' &&
    isProjectMentioned &&
    /\b(?:released?|introduced?|protocol release|spec release)\b/i.test(text)
  ) {
    return 'primary_required';
  }

  if (VERSION_RE.test(text) || /\b(latest|first|stable|production-ready)\b/i.test(text)) {
    return 'primary_preferred';
  }
  if (ctx.marketingPhrases.some((p) => p.test(text))) return 'secondary_ok';
  return 'any_ok';
}

function supportLevelFor(
  requirement: ClaimAuthorityRequirement,
  authorityClass: AuthorityClass,
): ResearchClaim['supportLevel'] {
  if (requirement === 'primary_required')
    return isPrimaryAuthority(authorityClass) ? 'primary' : 'weak';
  if (requirement === 'primary_preferred') {
    if (isPrimaryAuthority(authorityClass)) return 'primary';
    if (authorityClass === 'package_registry' || authorityClass === 'vendor_sdk_docs')
      return 'secondary';
    return 'weak';
  }
  if (isPrimaryAuthority(authorityClass)) return 'primary';
  if (authorityClass === 'unknown' || authorityClass === 'forum_social') return 'weak';
  return 'secondary';
}

function riskForClaim(
  text: string,
  entity: ReleaseEntity,
  authorityClass: AuthorityClass,
  requirement: ClaimAuthorityRequirement,
  sources: SourceEntry[],
  projectContext?: ProjectContext,
): ClaimRisk[] {
  const risks = new Set<ClaimRisk>();
  const lower: string = text.toLowerCase();
  const ctx = projectContext ?? defaultCtx();

  if (ctx.marketingPhrases.some((p) => p.test(text))) risks.add('marketing_language');
  if (requirement === 'primary_required' && !isPrimaryAuthority(authorityClass))
    risks.add('weak_authority');

  const packageSource: boolean = sources.some((s: SourceEntry) => {
    const cls: AuthorityClass = s.authorityClass ?? classifySourceAuthority(s, ctx);
    return (
      cls === 'package_registry' ||
      cls === 'vendor_sdk_docs' ||
      PACKAGE_RE.test(`${s.title} ${s.url}`)
    );
  });

  // Entity mismatch: package-backed sources claiming protocol/spec release.
  // Detects when a package source is used to make claims about the project
  // as a whole (protocol/spec) rather than the package itself.
  const projectPattern = ctx.projectTextPattern;
  const isProjectMentioned = projectPattern?.test(text) === true;
  // Framing signals: "protocol", "specification", or versioned project references
  const protocolFraming: boolean =
    isProjectMentioned &&
    (/\b(?:protocol|spec(?:ification)?)\b/i.test(text) || PROTOCOL_RELEASE_RE.test(text));
  if (packageSource && protocolFraming && entity.entityType !== 'package') {
    risks.add('entity_mismatch');
  }
  // Also flag when entity is a package but the claim frames it as a protocol/spec release
  const packageNameMentioned: boolean = entity.packageName
    ? lower.includes(entity.packageName.toLowerCase())
    : false;
  if (
    entity.entityType === 'package' &&
    !packageNameMentioned &&
    isProjectMentioned &&
    /\b(?:released?|introduced?|launched?)\b/i.test(lower)
  ) {
    risks.add('entity_mismatch');
  }

  const eventDate: string | undefined = extractEventDate(text);
  if (eventDate && sources.length > 0) {
    const onlyPublicationMatch: boolean = sources.some(
      (s: SourceEntry) => s.publishedDate?.slice(0, 10) === eventDate,
    );
    const hasOfficialReleaseSource: boolean = sources.some((s: SourceEntry) =>
      isPrimaryAuthority(s.authorityClass ?? classifySourceAuthority(s, ctx)),
    );
    if (onlyPublicationMatch && !hasOfficialReleaseSource && /\breleased?\b/i.test(text)) {
      risks.add('temporal_misattribution');
    }
  }

  return [...risks];
}

export function toTemporalClaim(
  text: string,
  entity: ReleaseEntity,
  sources: SourceEntry[],
): TemporalClaim {
  const eventDate = extractEventDate(text);
  const publicationDate = sources.find((s) => s.publishedDate)?.publishedDate?.slice(0, 10);
  const version = entity.version ?? extractVersion(text);
  return {
    claim: text,
    eventType: eventTypeFor(text),
    ...(eventDate ? { eventDate } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(version ? { version } : {}),
    entity,
    sourceIds: sources.map((s) => s.id),
    confidence: eventDate ? 0.75 : publicationDate ? 0.45 : 0.3,
    dateConfidence: eventDate ? 'exact' : publicationDate ? 'publication_only' : 'unknown',
  };
}

export function buildClaimLedger(
  findings: Finding[],
  sources: SourceEntry[],
  query = '',
  projectContext?: ProjectContext,
): ResearchClaim[] {
  const ctx = projectContext ?? defaultCtx();
  const sourceById = new Map<string, SourceEntry>(sources.map((s: SourceEntry) => [s.id, s]));
  return findings.map((finding: Finding): ResearchClaim => {
    const claimSources: SourceEntry[] = finding.sourceIds
      .map((sid: string) => sourceById.get(sid))
      .filter((s): s is SourceEntry => Boolean(s));
    const entity: ReleaseEntity =
      finding.subjectEntity ?? normalizeReleaseEntity(finding.claim, claimSources, ctx);
    const authorityClass: AuthorityClass =
      finding.authorityClass ?? bestAuthority(claimSources, ctx);
    const authorityRequirement: ClaimAuthorityRequirement =
      finding.authorityRequirement ??
      authorityRequirementForClaim(`${query} ${finding.claim}`, entity, ctx);
    const risks = new Set<ClaimRisk>(finding.provenanceRisks ?? []);
    for (const risk of riskForClaim(
      finding.claim,
      entity,
      authorityClass,
      authorityRequirement,
      claimSources,
      ctx,
    )) {
      risks.add(risk);
    }
    const temporal: TemporalClaim =
      finding.temporalClaim ?? toTemporalClaim(finding.claim, entity, claimSources);
    const evidenceAlignment: EvidenceAlignment =
      finding.evidenceAlignment ?? assessEvidenceAlignment(finding);
    const directEvidence: boolean =
      finding.evidenceDirectness === 'direct' || finding.evidenceDirectness === 'near-direct';
    if (
      (directEvidence && evidenceAlignment.score < 0.18) ||
      evidenceAlignment.missingAnchorTerms.length > 0
    ) {
      risks.add('weak_evidence_alignment');
    }
    return {
      id: finding.id,
      text: finding.claim,
      subjectEntity: entity,
      predicate: eventTypeFor(finding.claim),
      ...(temporal.version ? { version: temporal.version } : {}),
      ...(temporal.eventDate ? { eventDate: temporal.eventDate } : {}),
      ...(temporal.publicationDate ? { publicationDate: temporal.publicationDate } : {}),
      sourceIds: finding.sourceIds,
      authorityClass,
      authorityRequirement,
      supportLevel: supportLevelFor(authorityRequirement, authorityClass),
      evidenceAlignment,
      confidence: Math.max(0.05, Math.min(1, (finding.relevanceScore ?? 0.7) - risks.size * 0.15)),
      risks: [...risks],
    };
  });
}

export function buildSourceRegistry(
  sources: SourceEntry[],
  findings: Finding[],
  projectContext?: ProjectContext,
): SourceRecord[] {
  const ctx = projectContext ?? defaultCtx();
  return sources.map((source: SourceEntry, index: number): SourceRecord => {
    const cited: Finding[] = findings.filter((finding: Finding) =>
      finding.sourceIds.includes(source.id),
    );
    const authorityClass: AuthorityClass =
      source.authorityClass ?? classifySourceAuthority(source, ctx);
    return {
      id: source.id,
      index: index + 1,
      title: source.title,
      url: source.url,
      domain: source.domain,
      sourceType: inferSourceTypeFromUrl(source.url, source.sourceType, ctx),
      authorityClass,
      usedInReport: cited.length > 0 || source.usageStatus === 'used',
      citedClaimIds: cited.map((finding: Finding) => finding.id),
      extractedFindingIds: cited.map((finding: Finding) => finding.id),
    };
  });
}

export function detectLatestOfficialVersion(
  sources: SourceEntry[],
  query = '',
  projectContext?: ProjectContext,
): LatestOfficialVersion | undefined {
  const ctx = projectContext ?? defaultCtx();
  const projectPattern = ctx.projectTextPattern;

  // Only detect versions when the query/sources are about the research subject
  if (!projectPattern?.test(query + ' ' + sources.map((s: SourceEntry) => s.url).join(' '))) {
    return undefined;
  }

  const candidates: LatestOfficialVersion[] = [];
  for (const source of sources) {
    const cls: AuthorityClass = source.authorityClass ?? classifySourceAuthority(source, ctx);
    if (cls !== 'official_spec' && cls !== 'official_changelog') continue;
    const text = `${source.title} ${source.url}`;
    const versions: string[] = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
    for (const version of versions) {
      candidates.push({
        entity: ctx.canonicalName,
        version,
        sourceId: source.id,
        changelogUrl: source.url,
        confidence: cls === 'official_changelog' ? 0.95 : 0.9,
      });
    }
  }
  candidates.sort((a: LatestOfficialVersion, b: LatestOfficialVersion) =>
    b.version.localeCompare(a.version),
  );
  return candidates[0];
}

function splitSentences(markdown: string): string[] {
  return markdown
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

function issueSeverity(
  risks: ClaimRisk[],
  supportLevel: ResearchClaim['supportLevel'],
): 'low' | 'medium' | 'high' | 'critical' {
  if (risks.includes('entity_mismatch')) return 'critical';
  if (risks.includes('temporal_misattribution')) return 'critical';
  if (supportLevel === 'weak' && risks.includes('weak_authority')) return 'high';
  if (risks.includes('weak_evidence_alignment')) return 'high';
  if (risks.includes('cluster_bridge')) return 'medium';
  if (risks.includes('marketing_language')) return 'medium';
  return 'low';
}

function enforcementForIssue(
  issue: ReportAuditIssue,
): NonNullable<ReportAuditIssue['enforcement']> {
  if (issue.severity === 'critical') return 'block';
  if (issue.type === 'cluster_integrity')
    return issue.severity === 'high' ? 'quarantine' : 'caveat_required';
  if (issue.severity === 'high') return 'quarantine';
  if (issue.severity === 'medium') return 'caveat_required';
  return 'none';
}

function normalizeAuditIssues(issues: ReportAuditIssue[]): ReportAuditIssue[] {
  return issues.map(
    (issue: ReportAuditIssue, index: number): ReportAuditIssue => ({
      ...issue,
      id: issue.id ?? `rai-${String(index + 1).padStart(3, '0')}`,
      enforcement: issue.enforcement ?? enforcementForIssue(issue),
    }),
  );
}

function sourcesForNarrativeSentence(
  sentence: string,
  report: ResearchReport,
  sources: SourceEntry[],
  projectContext?: ProjectContext,
): SourceEntry[] {
  const ctx = projectContext ?? defaultCtx();
  const refRegex = /\[Source (\d+)\]/g;
  const matchedByCitation: SourceEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(sentence)) !== null) {
    const idx = Number(match[1]);
    const evidenceSource: ResearchReport['evidenceSources'][number] | undefined =
      report.evidenceSources.find((source) => source.index === idx);
    const source: SourceEntry | undefined = evidenceSource
      ? sources.find((candidate: SourceEntry) => candidate.url === evidenceSource.url)
      : sources[idx - 1];
    if (source) matchedByCitation.push(source);
  }
  if (matchedByCitation.length > 0) return [...new Set(matchedByCitation)];

  // Try to find sources that mention a package reference in the sentence
  const pkg: string | undefined = PACKAGE_RE.exec(sentence)?.[0]?.toLowerCase();
  if (pkg) {
    const packageSources: SourceEntry[] = sources.filter((source: SourceEntry) =>
      `${source.title} ${source.url}`.toLowerCase().includes(pkg),
    );
    if (packageSources.length > 0) return packageSources;
  }

  // If the sentence mentions any known package owner or ecosystem, prefer SDK/doc sources
  const lower = sentence.toLowerCase();
  for (const known of Object.values(ctx.knownPackages)) {
    const hints = [known.owner, known.ecosystem].filter(Boolean) as string[];
    if (hints.some((hint) => lower.includes(hint.toLowerCase()))) {
      const sdkSources: SourceEntry[] = sources.filter((source: SourceEntry) => {
        const cls: AuthorityClass = source.authorityClass ?? classifySourceAuthority(source, ctx);
        return cls === 'package_registry' || cls === 'vendor_sdk_docs';
      });
      if (sdkSources.length > 0) return sdkSources;
      break;
    }
  }

  return sources;
}

export function validateResearchReport(
  report: ResearchReport,
  sources: SourceEntry[],
  findings: Finding[],
  projectContext?: ProjectContext,
): ReportAuditResult {
  const ctx = projectContext ?? defaultCtx();
  const issues: ReportAuditIssue[] = [];
  const requiredRevisions: string[] = [];
  const ledger: ResearchClaim[] =
    report.claimLedger ?? buildClaimLedger(findings, sources, report.query, ctx);

  for (const claim of ledger) {
    for (const risk of claim.risks) {
      const severity: ReportAuditIssue['severity'] = issueSeverity(claim.risks, claim.supportLevel);
      issues.push({
        type:
          risk === 'entity_mismatch'
            ? 'entity_mismatch'
            : risk === 'temporal_misattribution'
              ? 'temporal_misattribution'
              : risk === 'weak_evidence_alignment'
                ? 'evidence_alignment'
                : risk === 'cluster_bridge'
                  ? 'cluster_integrity'
                  : risk === 'marketing_language'
                    ? 'marketing_language'
                    : 'source_authority',
        severity,
        claim: claim.text,
        sourceIds: claim.sourceIds,
        explanation: explainRisk(risk, claim),
        suggestedFix: suggestedFixForRisk(risk),
      });
      if (severity === 'critical' || severity === 'high')
        requiredRevisions.push(suggestedFixForRisk(risk));
    }
    if (claim.authorityRequirement === 'primary_required' && claim.supportLevel === 'weak') {
      issues.push({
        type: 'unsupported_claim',
        severity: 'high',
        claim: claim.text,
        sourceIds: claim.sourceIds,
        explanation:
          'Protocol/spec release claims require primary official evidence, but this claim is not backed by official specification, changelog, official repo, or official vendor evidence.',
        suggestedFix:
          'Anchor the claim to official protocol/spec sources, or narrow it to the ecosystem/package that the evidence actually covers.',
      });
      requiredRevisions.push(
        'Replace weakly sourced protocol release claims with primary-source-backed wording.',
      );
    }
  }

  for (const edge of report.findingClusterEdges ?? []) {
    if (edge.method !== 'vector' || (edge.strength !== 'weak' && !edge.bridge)) continue;
    const matchingClusters: FindingCluster[] = (report.findingClusters ?? []).filter(
      (candidate: FindingCluster) =>
        candidate.findingIds.includes(edge.leftFindingId) ||
        candidate.findingIds.includes(edge.rightFindingId),
    );
    const relatedClusterId: string | undefined =
      matchingClusters.length === 1 ? matchingClusters[0]?.id : undefined;
    const clusterContext: string =
      matchingClusters.length > 0
        ? ` Matching cluster(s): ${matchingClusters.map((cluster: FindingCluster) => cluster.id).join(', ')}.`
        : '';
    issues.push({
      type: 'cluster_integrity',
      severity: edge.bridge ? 'high' : 'medium',
      ...(relatedClusterId ? { relatedClusterId } : {}),
      relatedFindingIds: [edge.leftFindingId, edge.rightFindingId],
      explanation: `Finding linkage produced a weak semantic ${edge.bridge ? 'bridge' : 'support'} edge between ${edge.leftFindingId} and ${edge.rightFindingId}. Treat it as related context, not duplicate/corroborating agreement.${clusterContext}`,
      suggestedFix:
        'Split or caveat this relationship before using it as agreement/corroboration evidence.',
    });
    requiredRevisions.push(
      `Do not present ${edge.leftFindingId} and ${edge.rightFindingId} as equivalent claims unless the semantic bridge is resolved.`,
    );
  }

  for (const sentence of splitSentences(report.narrativeMarkdown)) {
    if (ctx.marketingPhrases.some((p) => p.test(sentence))) {
      issues.push({
        type: 'marketing_language',
        severity: 'medium',
        claim: sentence,
        explanation: 'Marketing rhetoric appears in the report as if it were analytical evidence.',
        suggestedFix: 'Omit the phrase or attribute it explicitly as rhetoric from commentators.',
      });
    }
    const sentenceSources: SourceEntry[] = sourcesForNarrativeSentence(
      sentence,
      report,
      sources,
      ctx,
    );
    const entity: ReleaseEntity = normalizeReleaseEntity(sentence, sentenceSources, ctx);
    const requirement: ClaimAuthorityRequirement = authorityRequirementForClaim(
      sentence,
      entity,
      ctx,
    );
    const authorityClass: AuthorityClass = bestAuthority(sentenceSources, ctx);
    const risks: ClaimRisk[] = riskForClaim(
      sentence,
      entity,
      authorityClass,
      requirement,
      sentenceSources,
      ctx,
    );
    for (const risk of risks.filter(
      (r: ClaimRisk) => r === 'entity_mismatch' || r === 'temporal_misattribution',
    )) {
      issues.push({
        type: risk === 'entity_mismatch' ? 'entity_mismatch' : 'temporal_misattribution',
        severity: 'critical',
        claim: sentence,
        explanation: explainRisk(risk, {
          id: 'narrative',
          text: sentence,
          subjectEntity: entity,
          predicate: eventTypeFor(sentence),
          sourceIds: sentenceSources.map((s: SourceEntry) => s.id),
          authorityClass,
          authorityRequirement: requirement,
          supportLevel: supportLevelFor(requirement, authorityClass),
          confidence: 0.2,
          risks,
        }),
        suggestedFix: suggestedFixForRisk(risk),
      });
      requiredRevisions.push(suggestedFixForRisk(risk));
    }
  }

  const citedEvidence = report.evidenceSources.length;
  const registry = report.sourceRegistry ?? buildSourceRegistry(sources, findings, ctx);
  const usedSources = registry.filter((s) => s.usedInReport).length;
  if (report.sourceCount !== sources.length || citedEvidence !== usedSources) {
    issues.push({
      type: 'internal_count_mismatch',
      severity: 'medium',
      explanation: `Source accounting differs: report.sourceCount=${String(report.sourceCount)}, sources.length=${String(sources.length)}, evidenceSources.length=${String(citedEvidence)}, usedInReport=${String(usedSources)}.`,
      suggestedFix:
        'Derive all source counts from the canonical source registry at finalization time.',
    });
  }
  if (report.findingCount !== findings.length) {
    issues.push({
      type: 'internal_count_mismatch',
      severity: 'medium',
      explanation: `Finding accounting differs: report.findingCount=${String(report.findingCount)}, findings.length=${String(findings.length)}.`,
      suggestedFix: 'Derive finding counts from the canonical findings list at finalization time.',
    });
  }

  const hasCritical = issues.some((i) => i.severity === 'critical');
  const hasHigh = issues.some((i) => i.severity === 'high');
  const normalizedIssues = normalizeAuditIssues(issues);
  return {
    pass: !hasCritical && !hasHigh,
    severity: hasCritical ? 'fail' : normalizedIssues.length > 0 ? 'warning' : 'ok',
    issues: normalizedIssues,
    requiredRevisions: [...new Set(requiredRevisions)],
  };
}

function overlapRatio(left: string, right: string): number {
  const leftTerms: Set<string> = contentTerms(left);
  const rightTerms: Set<string> = contentTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap++;
  return overlap / Math.min(leftTerms.size, rightTerms.size);
}

function buildEvidenceGraph(
  report: ResearchReport,
  findings: Finding[],
  clusters: FindingCluster[],
  findingClusterEdges: FindingClusterEdge[],
  audit: ReportAuditResult,
  sourceRegistry: EvidenceGraph['sources'],
): EvidenceGraph {
  const edges: EvidenceGraphEdge[] = [];
  const clusterByFinding = new Map<string, string>();
  for (const cluster of clusters) {
    for (const findingId of cluster.findingIds) clusterByFinding.set(findingId, cluster.id);
  }

  const evidence: EvidenceItem[] = findings.map(
    (finding: Finding): EvidenceItem => ({
      id: `ev-${finding.id}`,
      sourceIds: [...finding.sourceIds],
      findingId: finding.id,
      summary: finding.evidenceSummary,
      ...(finding.evidenceExcerpt ? { excerpt: finding.evidenceExcerpt } : {}),
      ...(finding.evidenceAlignment ? { alignment: finding.evidenceAlignment } : {}),
    }),
  );

  for (const item of evidence) {
    for (const sourceId of item.sourceIds) {
      edges.push({
        fromId: sourceId,
        toId: item.id,
        relation: 'source_provides_evidence',
        reason: 'Extraction recorded this source as evidence for the finding.',
      });
    }
    if (item.findingId) {
      const confidence: number | undefined = item.alignment?.score;
      edges.push({
        fromId: item.id,
        toId: item.findingId,
        relation: 'evidence_supports_finding',
        reason:
          item.alignment?.explanation ?? 'Evidence summary/excerpt supports the extracted finding.',
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }
  }

  const graphFindings: EvidenceGraphFindingNode[] = findings.map(
    (finding: Finding): EvidenceGraphFindingNode => {
      const clusterId: string | undefined = finding.clusterId ?? clusterByFinding.get(finding.id);
      const confidenceCapReason: string | undefined = finding.evidenceAlignment?.missingAnchorTerms
        .length
        ? `Missing anchor terms: ${finding.evidenceAlignment.missingAnchorTerms.join(', ')}`
        : undefined;
      return {
        id: finding.id,
        claim: finding.claim,
        sourceIds: [...finding.sourceIds],
        evidenceItemIds: [`ev-${finding.id}`],
        ...(clusterId ? { clusterId } : {}),
        ...(finding.relevanceScore !== undefined ? { confidence: finding.relevanceScore } : {}),
        ...(confidenceCapReason ? { confidenceCapReason } : {}),
      };
    },
  );

  for (const finding of graphFindings) {
    if (finding.clusterId) {
      edges.push({
        fromId: finding.id,
        toId: finding.clusterId,
        relation: 'finding_member_of_cluster',
        reason: 'Finding linkage assigned this finding to the cluster.',
      });
    }
  }

  const synthesisClaims: SynthesisClaimNode[] = splitSentences(report.narrativeMarkdown)
    .filter((sentence: string) => sentence.length > 24)
    .slice(0, 80)
    .map((sentence: string, index: number): SynthesisClaimNode => {
      const matchedFindingIds: string[] = findings
        .filter(
          (finding: Finding) =>
            sentence.includes(finding.claim) || overlapRatio(sentence, finding.claim) >= 0.55,
        )
        .map((finding: Finding) => finding.id);
      const matchedClusterIds: string[] = [
        ...new Set(
          matchedFindingIds
            .map((findingId: string) => clusterByFinding.get(findingId))
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const matchedAuditIssueIds: string[] = audit.issues
        .filter(
          (issue: ReportAuditIssue) =>
            (issue.claim !== undefined && sentence.includes(issue.claim)) ||
            (issue.relatedFindingIds?.some((findingId: string) =>
              matchedFindingIds.includes(findingId),
            ) ??
              false) ||
            (issue.relatedClusterId !== undefined &&
              matchedClusterIds.includes(issue.relatedClusterId)),
        )
        .map((issue: ReportAuditIssue) => issue.id)
        .filter((id): id is string => Boolean(id));
      return {
        id: `sc-${String(index + 1).padStart(3, '0')}`,
        text: sentence,
        findingIds: matchedFindingIds,
        clusterIds: matchedClusterIds,
        auditIssueIds: matchedAuditIssueIds,
      };
    });

  for (const issue of audit.issues) {
    if (!issue.id) continue;
    if (issue.relatedClusterId) {
      edges.push({
        fromId: issue.relatedClusterId,
        toId: issue.id,
        relation: 'cluster_has_audit_issue',
        reason: issue.explanation,
      });
    }
    for (const findingId of issue.relatedFindingIds ?? []) {
      edges.push({
        fromId: findingId,
        toId: issue.id,
        relation: 'finding_has_audit_issue',
        reason: issue.explanation,
      });
    }
    const claimFinding: Finding | undefined = findings.find(
      (finding: Finding) => issue.claim && finding.claim === issue.claim,
    );
    if (claimFinding) {
      edges.push({
        fromId: claimFinding.id,
        toId: issue.id,
        relation: 'finding_has_audit_issue',
        reason: issue.explanation,
      });
    }
  }

  for (const claim of synthesisClaims) {
    for (const findingId of claim.findingIds) {
      edges.push({
        fromId: claim.id,
        toId: findingId,
        relation: 'synthesis_renders_finding',
        reason: 'Synthesis sentence overlaps a normalized finding claim.',
      });
    }
    for (const clusterId of claim.clusterIds) {
      edges.push({
        fromId: claim.id,
        toId: clusterId,
        relation: 'synthesis_renders_cluster',
        reason: 'Synthesis sentence renders one or more findings from this cluster.',
      });
    }
    for (const issueId of claim.auditIssueIds) {
      edges.push({
        fromId: claim.id,
        toId: issueId,
        relation: 'synthesis_has_audit_issue',
        reason: 'Audit issue constrains this synthesis sentence.',
      });
    }
  }

  return {
    sources: sourceRegistry,
    evidence,
    findings: graphFindings,
    clusters,
    findingClusterEdges,
    auditIssues: audit.issues,
    synthesisClaims,
    edges,
  };
}

export function applyReportValidation(
  report: ResearchReport,
  sources: SourceEntry[],
  findings: Finding[],
  projectContext?: ProjectContext,
): ResearchReport {
  const ctx = projectContext ?? defaultCtx();
  const sourceRegistry: SourceRecord[] = buildSourceRegistry(sources, findings, ctx);
  const claimLedger: ResearchClaim[] = buildClaimLedger(findings, sources, report.query, ctx);
  const latestOfficialVersion: LatestOfficialVersion | undefined = detectLatestOfficialVersion(
    sources,
    report.query,
    ctx,
  );
  const sourceDiversity: { type: string; count: number }[] = [
    ...new Set(sourceRegistry.map((s: SourceRecord) => s.sourceType)),
  ].map((type: SourceType) => ({
    type,
    count: sourceRegistry.filter((s: SourceRecord) => s.sourceType === type).length,
  }));
  const usedIds = new Set<string>(
    sourceRegistry.filter((s: SourceRecord) => s.usedInReport).map((s: SourceRecord) => s.id),
  );
  const normalizedReport: ResearchReport = {
    ...report,
    sourceCount: sources.length,
    findingCount: findings.length,
    sourceTypeCount: sourceDiversity.length,
    sourceDiversity,
    evidenceSources: report.evidenceSources
      .filter((source: ResearchReport['evidenceSources'][number]) => {
        const matched: SourceEntry | undefined = sources.find(
          (s: SourceEntry) => s.url === source.url || s.title === source.title,
        );
        return matched ? usedIds.has(matched.id) : true;
      })
      .map((source: ResearchReport['evidenceSources'][number], index: number) => ({
        ...source,
        index: index + 1,
      })),
    sourceRegistry,
    claimLedger,
    ...(latestOfficialVersion ? { latestOfficialVersion } : {}),
  };
  if (normalizedReport.evidenceSources.length === 0 && sourceRegistry.length > 0) {
    normalizedReport.evidenceSources = sourceRegistry
      .filter((source: SourceRecord) => source.usedInReport)
      .map((source: SourceRecord, index: number) => ({
        index: index + 1,
        title: source.title,
        url: source.url,
        sourceType: source.sourceType,
        authorityClass: source.authorityClass,
        tier: isPrimaryAuthority(source.authorityClass)
          ? 1
          : source.authorityClass === 'forum_social'
            ? 3
            : 2,
        domain: source.domain,
      }));
  }

  const audit: ReportAuditResult = validateResearchReport(normalizedReport, sources, findings, ctx);
  const blockedClaims = new Set<string>(
    audit.issues
      .filter(
        (i): i is typeof i & { claim: string } =>
          i.enforcement === 'block' && i.claim !== undefined,
      )
      .map((i) => i.claim),
  );
  if (blockedClaims.size > 0) {
    normalizedReport.narrativeMarkdown = removeBlockedSentences(
      normalizedReport.narrativeMarkdown,
      blockedClaims,
    );
    normalizedReport.uncertainties = [
      ...normalizedReport.uncertainties,
      ...[...blockedClaims].map(
        (claim: string) =>
          `Validation removed an unsafe claim pending primary-source verification: ${claim}`,
      ),
    ];
  }
  const finalAudit: ReportAuditResult =
    blockedClaims.size > 0
      ? validateResearchReport(normalizedReport, sources, findings, ctx)
      : audit;
  const enforcedCaveats: string[] = finalAudit.issues
    .filter(
      (issue: ReportAuditIssue) =>
        issue.enforcement === 'quarantine' || issue.enforcement === 'caveat_required',
    )
    .map(
      (issue: ReportAuditIssue) =>
        `Audit constraint (${issue.enforcement ?? 'none'}): ${issue.explanation}`,
    );
  if (enforcedCaveats.length > 0) {
    normalizedReport.uncertainties = [
      ...new Set([...normalizedReport.uncertainties, ...enforcedCaveats]),
    ];
  }
  normalizedReport.reportAudit = finalAudit;
  normalizedReport.evidenceGraph = buildEvidenceGraph(
    normalizedReport,
    findings,
    normalizedReport.findingClusters ?? [],
    normalizedReport.findingClusterEdges ?? [],
    finalAudit,
    sourceRegistry,
  );
  return normalizedReport;
}

function removeBlockedSentences(markdown: string, blockedClaims: Set<string>): string {
  let result = markdown;
  for (const claim of blockedClaims) {
    if (result.includes(claim)) {
      result = result.replace(claim, '').replace(/\n{3,}/g, '\n\n');
    }
  }
  return result;
}

function explainRisk(risk: ClaimRisk, claim: ResearchClaim): string {
  switch (risk) {
    case 'entity_mismatch':
      return `The claim appears to collapse ${claim.subjectEntity.entityType} evidence for ${claim.subjectEntity.canonicalName} into a different protocol/spec entity.`;
    case 'temporal_misattribution':
      return 'The claim appears to use a publication/article date as if it were the event or release date.';
    case 'weak_authority':
      return `The claim requires ${claim.authorityRequirement} authority but best support is ${claim.authorityClass}.`;
    case 'weak_evidence_alignment':
      return (
        claim.evidenceAlignment?.explanation ??
        'The finding evidence does not align closely enough with the claim text or anchor terms.'
      );
    case 'marketing_language':
      return 'The claim contains rhetoric/marketing language that should be attributed or omitted.';
    case 'cluster_bridge':
      return 'The claim is part of a cluster connected by a weak semantic bridge and should not be treated as equivalent evidence.';
  }
}

function suggestedFixForRisk(risk: ClaimRisk): string {
  switch (risk) {
    case 'entity_mismatch':
      return 'Rewrite the claim with the exact owning entity (protocol/spec vs package/SDK/client), or drop it.';
    case 'temporal_misattribution':
      return 'Separate publicationDate from eventDate and attribute features to the official changelog/spec version.';
    case 'weak_authority':
      return 'Require official specification/changelog/repo/vendor evidence for protocol release claims.';
    case 'weak_evidence_alignment':
      return 'Revise or drop the claim unless the cited evidence explicitly supports its entity, version, and date anchors.';
    case 'marketing_language':
      return 'Omit marketing phrasing or attribute it explicitly as third-party rhetoric.';
    case 'cluster_bridge':
      return 'Split the cluster or present the relationship as contextual support rather than agreement.';
  }
}
