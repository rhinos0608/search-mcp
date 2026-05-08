/**
 * FindingSplitter — detects and splits multi-claim findings into atomic ones.
 *
 * A finding should express one claim, backed by one source or source cluster.
 * This module identifies findings that contain multiple distinct claims
 * (detected via conjunction patterns, topic shifts, or multi-sentence structure)
 * and splits them into separate, atomic findings.
 *
 * Design:
 * - GUIDING, not enforcing: the original finding is preserved (marked with atomicity hint).
 * - Split findings reference the parent via splitFromId.
 * - Nothing is dropped — all content is preserved.
 * - Splits are conservative: only split when there's high confidence of multiple claims.
 */

import type { Finding } from './types.js';
import { logger } from '../logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

// ── Multi-claim detection ────────────────────────────────────────────────────

/**
 * Patterns that suggest a finding contains multiple distinct claims.
 * Conservative by design — only split when there's clear multi-claim structure.
 */

/** Conjunction patterns that join distinct claims rather than amplify one claim. */
const MULTI_CLAIM_CONJUNCTIONS = /\b(additionally|furthermore|moreover|in addition|separately|meanwhile|on the other hand|conversely|in contrast|alternatively|another (key|important|major|significant|notable))\b/i;

/** Patterns that introduce new topics within a single finding. */
// const TOPIC_SHIFT_PATTERNS = /\b(regarding|turning to|with respect to|as for|in terms of)\b/i;

/** Patterns for "and" connecting distinct subjects (not just attributes of same subject). */
// Heuristic: if "and" connects two distinct noun phrases about different things
const DISTINCT_AND_PATTERN = /(\w+(?:\s+\w+){0,3})\s+(?:is|are|was|were|has|have|does|do)\s+.+?\s+and\s+(\w+(?:\s+\w+){0,3})\s+(?:is|are|was|were|has|have|does|do)\s+/i;

/**
 * Check if a finding has a sentence that acts as a distinct, separable claim.
 * A sentence is a separable claim if it:
 * 1. Starts with a topic-shift marker
 * 2. Introduces a new entity/subject not mentioned earlier in the finding
 * 3. Has independent factive structure
 */
function hasMultiSentenceClaims(claim: string): { isMulti: boolean; sentences: string[] } {
  // Split into sentences (conservative: only split on period+space+capital)
  const sentenceEndings = claim.split(/(?<=\.)\s+(?=[A-Z"])/);
  if (sentenceEndings.length <= 1) return { isMulti: false, sentences: [claim] };

  // Check if sentences are about distinct topics
  const sentences = sentenceEndings.map((s) => s.trim()).filter((s) => s.length > 0);
  if (sentences.length < 2) return { isMulti: false, sentences };

  // Extract key nouns from each sentence
  const nounSets = sentences.map((s) => {
    const words = s
      .toLowerCase()
      .split(/[^\w']+/)
      .filter((w) => w.length > 3);
    return new Set(words);
  });

  // Check if sentences have low noun overlap (different topics)
  let distinctTopics = 0;
  for (let i = 1; i < nounSets.length; i++) {
    const prev = nounSets[i - 1];
    const curr = nounSets[i];
    if (!prev || !curr) continue;
    let overlap = 0;
    for (const w of prev) {
      if (curr.has(w)) overlap++;
    }
    const maxSize = Math.max(prev.size, curr.size);
    if (maxSize > 0 && overlap / maxSize < 0.2) {
      distinctTopics++;
    }
  }

  return {
    isMulti: distinctTopics > 0,
    sentences,
  };
}

// ── Split strategies ─────────────────────────────────────────────────────────

interface SplitResult {
  original: Omit<Finding, 'id' | 'createdAt'>;
  splits: Omit<Finding, 'id' | 'createdAt'>[];
}

/**
 * Attempt to split a multi-claim finding into atomic findings.
 * Returns the original finding (with atomicity noted) and any splits.
 * If no split is needed, splits is empty.
 */
export function splitFinding(finding: Finding): SplitResult {
  const { claim, evidenceSummary, evidenceExcerpt, sourceIds, subQuestionIds } = finding;
  const splits: Omit<Finding, 'id' | 'createdAt'>[] = [];

  // Strategy 1: Check for topic-shift multi-sentence structure
  const multiSentence = hasMultiSentenceClaims(claim);
  if (multiSentence.isMulti && multiSentence.sentences.length >= 2) {
    logger.debug(
      { findingId: finding.id, sentences: multiSentence.sentences.length },
      'findingSplitter: detected multi-sentence multi-claim finding',
    );

    // The first sentence stays as the original claim (modified)
    // Additional sentences become separate findings
    for (let i = 1; i < multiSentence.sentences.length; i++) {
      const splitClaim = multiSentence.sentences[i];
      if (!splitClaim || splitClaim.length < 20) continue;

      const normalized = splitClaim.toLowerCase().replace(/[^\w\s]/g, '').trim();

      splits.push({
        claim: splitClaim,
        normalizedClaim: normalized,
        subQuestionIds: [...subQuestionIds],
        sourceIds: [...sourceIds],
        evidenceSummary: evidenceSummary,
        ...(evidenceExcerpt !== undefined ? { evidenceExcerpt } : {}),
        evidenceDirectness: finding.evidenceDirectness,
        ...(finding.caveats !== undefined ? { caveats: finding.caveats } : {}),
        ...(finding.scope !== undefined ? { scope: finding.scope } : {}),
        freshnessSensitive: finding.freshnessSensitive,
        lastUpdated: nowISO(),
        claimType: finding.claimType,
        splitFromId: finding.id,
      });
    }
  }

  // Strategy 2: Check for conjunction-based multi-claim structure
  // (only if we haven't already split)
  if (splits.length === 0 && MULTI_CLAIM_CONJUNCTIONS.test(claim)) {
    logger.debug(
      { findingId: finding.id },
      'findingSplitter: detected conjunction-based multi-claim finding',
    );

    // Split on conjunction markers
    const rawSegments = claim.split(MULTI_CLAIM_CONJUNCTIONS);
    // Filter out any segments that are just the conjunction markers themselves
    const segments = rawSegments.filter((s) => !MULTI_CLAIM_CONJUNCTIONS.test(s.trim()));
    if (segments.length >= 2) {
      const firstSegment = segments[0]?.trim();
      // Only create splits if the first segment is a complete clause
      if (firstSegment && firstSegment.length > 30) {
        for (let i = 1; i < segments.length; i++) {
          const seg = segments[i]?.trim();
          if (!seg || seg.length < 20) continue;
          const normalized = seg.toLowerCase().replace(/[^\w\s]/g, '').trim();

          splits.push({
            claim: seg,
            normalizedClaim: normalized,
            subQuestionIds: [...subQuestionIds],
            sourceIds: [...sourceIds],
            evidenceSummary: evidenceSummary,
            ...(evidenceExcerpt !== undefined ? { evidenceExcerpt } : {}),
            evidenceDirectness: finding.evidenceDirectness,
            ...(finding.caveats !== undefined ? { caveats: finding.caveats } : {}),
            ...(finding.scope !== undefined ? { scope: finding.scope } : {}),
            freshnessSensitive: finding.freshnessSensitive,
            lastUpdated: nowISO(),
            claimType: finding.claimType,
            splitFromId: finding.id,
          });
        }
      }
    }
  }

  // Strategy 3: Check for "and" connecting distinct subjects
  if (splits.length === 0) {
    const andMatch = DISTINCT_AND_PATTERN.exec(claim);
    if (andMatch && DISTINCT_AND_PATTERN.test(claim)) {
      // Verify the two sides represent distinct propositions by checking
      // they contain different named entities or main verbs
      const firstEntity = andMatch[1];
      const secondEntity = andMatch[2];
      const entityTokens1 = new Set(firstEntity?.toLowerCase().split(/\s+/) ?? []);
      const entityTokens2 = new Set(secondEntity?.toLowerCase().split(/\s+/) ?? []);
      // Count distinct tokens between the two sides
      let sharedTokens = 0;
      for (const t of entityTokens1) {
        if (entityTokens2.has(t)) sharedTokens++;
      }
      const totalTokens = Math.max(entityTokens1.size, entityTokens2.size);
      const distinctEntities = totalTokens > 0 && sharedTokens / totalTokens < 0.3;

      if (distinctEntities) {
        logger.debug(
          { findingId: finding.id },
          'findingSplitter: detected distinct-subject "and" pattern',
        );
        const beforeAnd = claim.split(/\s+and\s+/)[0];
        const afterAnd = claim.split(/\s+and\s+/).slice(1).join(' and ');
        if (beforeAnd && afterAnd && beforeAnd.length > 30 && afterAnd.length > 20) {
          splits.push({
            claim: afterAnd,
            normalizedClaim: afterAnd.toLowerCase().replace(/[^\w\s]/g, '').trim(),
            subQuestionIds: [...subQuestionIds],
            sourceIds: [...sourceIds],
            evidenceSummary: evidenceSummary,
            ...(evidenceExcerpt !== undefined ? { evidenceExcerpt } : {}),
            evidenceDirectness: finding.evidenceDirectness,
            ...(finding.caveats !== undefined ? { caveats: finding.caveats } : {}),
            ...(finding.scope !== undefined ? { scope: finding.scope } : {}),
            freshnessSensitive: finding.freshnessSensitive,
            lastUpdated: nowISO(),
            claimType: finding.claimType,
            splitFromId: finding.id,
          });
        }
      }
    }
  }

  // The original finding gets updated to note it was a source for splits if any were created
  const originalModified = {
    ...finding,
    ...(splits.length > 0 ? { caveats: (finding.caveats ? finding.caveats + ' ' : '') + '[Multi-claim: split into ' + String(splits.length) + ' atomic finding(s)]' } : {}),
  };

  // Remove id/createdAt for the return type
  const { id: _id, createdAt: _createdAt, ...originalRest } = originalModified;

  return {
    original: originalRest,
    splits,
  };
}

/**
 * Process all findings and split multi-claim ones.
 * Returns the new findings that should be added to state.
 * The original findings are replaced with their split versions.
 * Returns a map: original finding ID → replacement finding data (or updated original).
 * Plus an array of new split findings to add.
 */
export function processAndSplitFindings(
  findings: Finding[],
): {
  /** Updated findings: map of original finding ID → new finding data (with any modifications). */
  updated: Map<string, Omit<Finding, 'id' | 'createdAt'>>;
  /** New split findings to add to state, with their splitFromId set. */
  newSplits: Omit<Finding, 'id' | 'createdAt'>[];
} {
  const updated = new Map<string, Omit<Finding, 'id' | 'createdAt'>>();
  const newSplits: Omit<Finding, 'id' | 'createdAt'>[] = [];

  let splitCount = 0;
  for (const f of findings) {
    const result = splitFinding(f);
    updated.set(f.id, result.original);
    if (result.splits.length > 0) {
      splitCount++;
      for (const split of result.splits) {
        newSplits.push(split);
      }
    }
  }

  logger.info(
    { totalFindings: findings.length, splitFindings: splitCount, newSplits: newSplits.length },
    'findingSplitter: processing complete',
  );

  return { updated, newSplits };
}
