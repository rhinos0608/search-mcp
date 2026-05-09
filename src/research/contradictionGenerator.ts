/**
 * ContradictionGenerator — evidence-pool contradiction and uncertainty generation.
 *
 * Runs after extraction, dedup, and relevance classification. Adds contradictions
 * and uncertainties that the existing finding-to-finding comparison might miss.
 *
 * Sources of contradiction/uncertainty:
 * 1. Date/version conflicts — findings mentioning different years, versions for same topic
 * 2. Benchmark/numerical conflicts — findings with significantly different numbers for same metric
 * 3. Speculative claims — evidenceDirectness === 'speculative' → uncertainty
 * 4. Source quality tier conflicts — tier 1 vs tier 4 sources on the same claim
 * 5. Future/prediction claims — "will", "expected to", "projected" → uncertainty
 * 6. Release date conflicts — differing reported release dates for same product/version
 * 7. Source-count diversity warnings — single-source findings for key claims
 */

import { randomUUID } from 'node:crypto';
import type { Finding, Contradiction, SourceEntry } from './types.js';
import { logger } from '../logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
  return randomUUID().slice(0, 12);
}

/** Extract a claim's core topic for grouping. Uses first 3-5 content words. */
function extractClaimTopic(claim: string): string {
  const words = claim
    .toLowerCase()
    .split(/[^\w']+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          'this',
          'that',
          'these',
          'those',
          'with',
          'from',
          'which',
          'their',
          'have',
          'been',
          'were',
          'they',
          'what',
          'about',
          'would',
          'could',
          'should',
          'there',
          'being',
          'while',
          'where',
          'after',
          'before',
          'other',
          'such',
          'more',
          'very',
          'also',
          'than',
          'then',
          'when',
          'into',
          'over',
          'most',
          'some',
          'each',
          'both',
          'through',
        ].includes(w),
    );
  return words.slice(0, 4).join(' ');
}

// ── Date/version extraction ──────────────────────────────────────────────────

/** Extract year mentions from text. */
function extractYears(text: string): number[] {
  const yearPattern = /\b(20\d{2})\b/g;
  const years: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(text)) !== null) {
    const y = parseInt(match[1] ?? '0', 10);
    if (y >= 2020 && y <= 2040) years.push(y);
  }
  return [...new Set(years)];
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

/** Extract version-like patterns (e.g., "v3", "version 4", "GPT-4", "Claude 3.5"). */
function extractVersions(text: string): string[] {
  const versionPatterns = [
    /\bv(\d+(?:\.\d+)+)\b/gi,
    /\bversion\s+(\d+(?:\.\d+)*)\b/gi,
    /\b(GPT[-\s]?\d+(?:\.\d+)?)\b/gi,
    /\b(Claude\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Gemini\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Llama\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Stable\s+Diffusion\s+\d+(?:\.\d+)?)\b/gi,
    /\biOS\s+(\d+(?:\.\d+)*)\b/gi,
    /\bandroid\s+(\d+(?:\.\d+)*)\b/gi,
    /\bReact\s+(\d+(?:\.\d+)*)\b/gi,
    /\bNode\.?js\s+(\d+(?:\.\d+)*)\b/gi,
    /\bPython\s+(\d+(?:\.\d+)*)\b/gi,
    /\bTypeScript\s+(\d+(?:\.\d+)*)\b/gi,
    /\bKubernetes\s+(\d+(?:\.\d+)*)\b/gi,
    /\bDocker\s+(\d+(?:\.\d+)*)\b/gi,
  ];
  const versions: string[] = [];
  for (const pattern of versionPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Use capture group if present, otherwise use full match
      versions.push((match[1] ?? match[0]).toLowerCase());
    }
  }
  return [...new Set(versions)];
}

/** Extract numerical values with units. */
function extractMetrics(text: string): { value: number; unit: string; context: string }[] {
  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*(%|percent)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GB|gb|MB|mb|KB|kb|TB|tb)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GHz|ghz|MHz|mhz|Hz|hz)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GBps|gbps|MBps|mbps|Gbps|gbps)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(billion|million|trillion)\b/gi,
    /\baccuracy\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    /\b(?:achieved?|reached?|scored?)\s+(\d+(?:\.\d+)?)\s*%/gi,
    /\b(\d+(?:\.\d+)?)\s*(?:billion|B)\s+(?:parameters?|params?)\b/gi,
    /\bcontext\s+(?:window|length)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:K|k|tokens?)\b/gi,
  ];
  const metrics: { value: number; unit: string; context: string }[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const valMatch = match[1];
      if (!valMatch) continue;
      const value = parseFloat(valMatch);
      const unit = (match[2] ?? 'count').toLowerCase();
      // Find surrounding context
      const idx = text.toLowerCase().indexOf(match[0].toLowerCase());
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + match[0].length + 30);
      const context = text.slice(start, end).trim();
      metrics.push({ value, unit, context });
    }
  }
  return metrics;
}

// ── Future/speculative detection ─────────────────────────────────────────────

const FUTURE_PATTERNS =
  /\b(will\s+|expected\s+to\s+|projected\s+|predicted\s+|forecast(?:ed)?\s+|planned\s+|anticipated\s+|upcoming\s+|future\s+|roadmap\s+|in\s+the\s+(?:coming|next|future)\s+|by\s+20\d{2}\s+)\b/i;

// SPECULATIVE_PATTERNS reserved for future scoring
// const SPECULATIVE_PATTERNS = /\b(may\s+|might\s+|could\s+|potentially\s+|possibly\s+|presumably\s+|arguably\s+|in theory\b|theoretically\s+|it\s+remains\s+to\s+be\s+seen|it\s+is\s+unclear|remains\s+uncertain)\b/i;

// ── Release date patterns ───────────────────────────────────────────────────

const RELEASE_DATE_PATTERNS = [
  /\breleased?\s+(?:in\s+)?(20\d{2})\b/i,
  /\blaunche?d\s+(?:in\s+)?(20\d{2})\b/i,
  /\bship(ped|ping)\s+(?:in\s+)?(20\d{2})\b/i,
  /\bavailable\s+(?:in|from|since)\s+(20\d{2})\b/i,
  /\bexpected?\s+(?:in|by|for)\s+(20\d{2})\b/i,
];

function extractReleaseDates(text: string): { year: number; label: string }[] {
  const dates: { year: number; label: string }[] = [];
  for (const pattern of RELEASE_DATE_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const yearMatch = match[1];
      if (!yearMatch) continue;
      const year = parseInt(yearMatch, 10);
      if (year >= 2020 && year <= 2040) {
        const label = match[0].toLowerCase();
        dates.push({ year, label });
      }
    }
  }
  return dates;
}

// ── Generator ────────────────────────────────────────────────────────────────

export interface GeneratedContradictions {
  /** New contradictions to add to state. */
  contradictions: Contradiction[];
  /** New uncertainty strings for the synthesis report. */
  uncertainties: string[];
}

/**
 * Generate contradictions and uncertainties from the evidence pool.
 *
 * @param findings - All findings in the research state.
 * @param sources - All sources in the research state (for tier info).
 * @param query - The original research query.
 */
export function generateFromEvidencePool(
  findings: Finding[],
  sources: SourceEntry[],
  _query: string,
): GeneratedContradictions {
  const contradictions: Contradiction[] = [];
  const uncertainties: string[] = [];

  if (findings.length === 0) {
    return { contradictions, uncertainties };
  }

  // Build source tier lookup
  const sourceTiers = new Map<string, number>();
  for (const s of sources) {
    sourceTiers.set(s.id, s.qualityScore ?? 0.5);
  }

  // ── Check 1: Date/version conflicts ─────────────────────────────────
  // Group findings by topic, check for different years/versions
  const topicGroups = new Map<string, Finding[]>();
  for (const f of findings) {
    const topic = extractClaimTopic(f.claim);
    if (!topic) continue;
    const group = topicGroups.get(topic) ?? [];
    group.push(f);
    topicGroups.set(topic, group);
  }

  for (const [topic, group] of topicGroups) {
    if (group.length < 2) continue;

    // Check year conflicts
    const yearSets = group.map((f) => ({ finding: f, years: extractYears(f.claim) }));
    for (let i = 0; i < yearSets.length; i++) {
      for (let j = i + 1; j < yearSets.length; j++) {
        const a = yearSets[i];
        const b = yearSets[j];
        if (!a || !b) continue;
        if (a.years.length > 0 && b.years.length > 0 && !arraysEqual(a.years, b.years)) {
          // Same topic, different years → contradiction
          contradictions.push({
            id: makeId(),
            claimA: a.finding.claim,
            claimB: b.finding.claim,
            sourceIdsA: [...a.finding.sourceIds],
            sourceIdsB: [...b.finding.sourceIds],
            contradictionType: 'time_version_mismatch',
            resolutionStatus: 'unresolved',
            likelyExplanation: `Claims about "${topic}" mention different years (${a.years.join(', ')} vs ${b.years.join(', ')}). This may reflect changes over time or conflicting reports.`,
          });
        }
      }
    }

    // Check version conflicts
    const versionSets = group.map((f) => ({ finding: f, versions: extractVersions(f.claim) }));
    for (let i = 0; i < versionSets.length; i++) {
      for (let j = i + 1; j < versionSets.length; j++) {
        const a = versionSets[i];
        const b = versionSets[j];
        if (!a || !b) continue;
        if (
          a.versions.length > 0 &&
          b.versions.length > 0 &&
          !arraysEqual(a.versions, b.versions)
        ) {
          contradictions.push({
            id: makeId(),
            claimA: a.finding.claim,
            claimB: b.finding.claim,
            sourceIdsA: [...a.finding.sourceIds],
            sourceIdsB: [...b.finding.sourceIds],
            contradictionType: 'time_version_mismatch',
            resolutionStatus: 'unresolved',
            likelyExplanation: `Claims about "${topic}" reference different versions (${a.versions.join(', ')} vs ${b.versions.join(', ')}). These may describe different releases or iterations.`,
          });
        }
      }
    }

    // Check benchmark/numerical conflicts
    const metricSets = group.map((f) => ({ finding: f, metrics: extractMetrics(f.claim) }));
    for (let i = 0; i < metricSets.length; i++) {
      for (let j = i + 1; j < metricSets.length; j++) {
        const a = metricSets[i];
        const b = metricSets[j];
        if (!a || !b) continue;
        if (a.metrics.length === 0 || b.metrics.length === 0) continue;

        for (const m1 of a.metrics) {
          let foundForPair = false;
          for (const m2 of b.metrics) {
            if (m1.unit !== m2.unit) continue;
            if (m1.value === m2.value) continue;
            const ratio = Math.abs(m1.value - m2.value) / Math.max(m1.value, m2.value);
            if (ratio > 0.3) {
              contradictions.push({
                id: makeId(),
                claimA: a.finding.claim,
                claimB: b.finding.claim,
                sourceIdsA: [...a.finding.sourceIds],
                sourceIdsB: [...b.finding.sourceIds],
                contradictionType: 'benchmark_disagreement',
                resolutionStatus: 'unresolved',
                likelyExplanation: `Numerical values for "${topic}" differ significantly: ${String(m1.value)}${m1.unit} vs ${String(m2.value)}${m2.unit} (${String(Math.round(ratio * 100))}% difference). This may reflect different measurement methodologies, benchmarks, or versions.`,
              });
              foundForPair = true;
              break;
            }
          }
          if (foundForPair) break;
        }
      }
    }
  }

  // ── Check 2: Source quality tier conflicts ──────────────────────────
  // When two findings on the same topic draw from very different quality sources
  for (const [topic, group] of topicGroups) {
    if (group.length < 2) continue;

    // Find tier extremes
    const withTiers = group
      .map((f) => ({
        finding: f,
        maxTier: Math.max(...f.sourceIds.map((sid) => sourceTiers.get(sid) ?? 0.5)),
        minTier: Math.min(...f.sourceIds.map((sid) => sourceTiers.get(sid) ?? 0.5)),
      }))
      .filter((t) => t.maxTier > 0);

    for (let i = 0; i < withTiers.length; i++) {
      for (let j = i + 1; j < withTiers.length; j++) {
        const a = withTiers[i];
        const b = withTiers[j];
        if (!a || !b) continue;
        // Tier gap > 0.5 means one is high quality and one is low quality
        if (Math.abs(a.maxTier - b.maxTier) > 0.5 || Math.abs(a.minTier - b.minTier) > 0.5) {
          // Check if findings actually disagree (not just same claim from different tiers)
          const aWords = new Set(
            a.finding.claim
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 3),
          );
          const bWords = new Set(
            b.finding.claim
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 3),
          );
          let overlap = 0;
          for (const w of aWords) {
            if (bWords.has(w)) overlap++;
          }
          const maxSize = Math.max(aWords.size, bWords.size);
          const similarity = maxSize > 0 ? overlap / maxSize : 0;

          // Only flag if they're somewhat on the same topic but from different quality tiers
          if (similarity > 0.15 && similarity < 0.7) {
            contradictions.push({
              id: makeId(),
              claimA: a.finding.claim,
              claimB: b.finding.claim,
              sourceIdsA: [...a.finding.sourceIds],
              sourceIdsB: [...b.finding.sourceIds],
              contradictionType: 'vendor_vs_independent',
              resolutionStatus: 'unresolved',
              likelyExplanation: `Claims about "${topic}" come from sources with significantly different quality tiers (tier ${a.maxTier.toFixed(1)} vs tier ${b.maxTier.toFixed(1)}). Lower-tier sources may be less reliable.`,
            });
          }
        }
      }
    }
  }

  // ── Check 3: Speculative claims → uncertainties ─────────────────────
  const speculativeFindings = findings.filter((f) => f.evidenceDirectness === 'speculative');
  if (speculativeFindings.length > 0) {
    uncertainties.push(
      `${String(speculativeFindings.length)} finding(s) are marked as speculative (evidence is opinion, prediction, or hypothetical). Treat these as unconfirmed: "${speculativeFindings[0]?.claim.slice(0, 80) ?? ''}..."`,
    );
  }

  // ── Check 4: Future/prediction claims → uncertainties ───────────────
  const futureClaims: string[] = [];
  for (const f of findings) {
    if (FUTURE_PATTERNS.test(f.claim)) {
      futureClaims.push(f.claim.slice(0, 100));
    }
  }
  if (futureClaims.length > 0) {
    uncertainties.push(
      `${String(futureClaims.length)} finding(s) contain future projections or predictions. These are inherently uncertain and may not materialize as described.`,
    );
  }

  // ── Check 5: Release date conflicts → contradictions + uncertainties ─
  const releaseDates = findings.map((f) => ({
    finding: f,
    dates: extractReleaseDates(f.claim),
  }));
  const dateGroups = new Map<string, { year: number; finding: Finding }[]>();
  for (const { finding, dates } of releaseDates) {
    for (const d of dates) {
      const key = extractClaimTopic(finding.claim);
      if (!key) continue;
      const group = dateGroups.get(key) ?? [];
      group.push({ year: d.year, finding });
      dateGroups.set(key, group);
    }
  }

  for (const [product, dateInfos] of dateGroups) {
    if (dateInfos.length < 2) continue;
    const years = [...new Set(dateInfos.map((d) => d.year))];
    if (years.length >= 2) {
      contradictions.push({
        id: makeId(),
        claimA: dateInfos[0]?.finding.claim ?? '',
        claimB: dateInfos[1]?.finding.claim ?? '',
        sourceIdsA: [...(dateInfos[0]?.finding.sourceIds ?? [])],
        sourceIdsB: [...(dateInfos[1]?.finding.sourceIds ?? [])],
        contradictionType: 'time_version_mismatch',
        resolutionStatus: 'unresolved',
        likelyExplanation: `Release date reports for "${product}" conflict: ${years.join(' vs ')}. This may reflect different release phases, delayed launches, or inaccurate reporting.`,
      });
    }
  }

  // ── Check 6: Single-source critical claims → uncertainties ──────────
  const singleSourceFindings = findings.filter((f) => f.sourceIds.length === 1);
  if (singleSourceFindings.length > 5) {
    uncertainties.push(
      `${String(singleSourceFindings.length)} finding(s) rely on a single source. These should be treated as lower-confidence until corroborated by independent sources.`,
    );
  }

  // ── Check 7: Dedup contradictions from being too similar to existing ones ──
  // Simple dedup: skip if same pair of claims already detected
  const dedupedContradictions = dedupContradictions(contradictions);

  logger.info(
    {
      contradictions: dedupedContradictions.length,
      uncertainties: uncertainties.length,
      speculativeCount: speculativeFindings.length,
      futureCount: futureClaims.length,
      singleSourceCount: singleSourceFindings.length,
    },
    'contradictionGenerator: evidence-pool analysis complete',
  );

  return {
    contradictions: dedupedContradictions,
    uncertainties,
  };
}

/**
 * Deduplicate generated contradictions by claim pair.
 */
function dedupContradictions(contradictions: Contradiction[]): Contradiction[] {
  const seen = new Set<string>();
  const result: Contradiction[] = [];
  for (const c of contradictions) {
    const key = [c.claimA.slice(0, 80), c.claimB.slice(0, 80)].sort().join('||');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }
  return result;
}

/**
 * Merge generated contradictions into an existing contradictions array.
 * Deduplicates against existing contradictions.
 */
export function mergeContradictions(
  existing: Contradiction[],
  generated: Contradiction[],
): Contradiction[] {
  const existingKeys = new Set<string>();
  for (const c of existing) {
    const key = [c.claimA.slice(0, 80), c.claimB.slice(0, 80)].sort().join('||');
    existingKeys.add(key);
  }

  const merged = [...existing];
  for (const c of generated) {
    const key = [c.claimA.slice(0, 80), c.claimB.slice(0, 80)].sort().join('||');
    if (!existingKeys.has(key)) {
      merged.push(c);
      existingKeys.add(key);
    }
  }

  return merged;
}
