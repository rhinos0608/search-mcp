/**
 * Phase 6: State Audit & Citation Integrity
 *
 * Inspects the research state before synthesis to catch issues:
 * unsourced claims, confidence-evidence mismatches, duplicate claims,
 * missing caveats, low source diversity, and taxonomy drift.
 */

import type { ResearchStateEngine } from './state.js';
import type { AuditReport, AuditIssue } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Jaccard similarity over word sets.
 * Returns a value in [0, 1] where 1 = identical word composition.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  const setB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Truncate a string for display in issue descriptions. */
function truncate(s: string, max = 60): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

// ── Severity sort order ──────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ── StateAuditor ─────────────────────────────────────────────────────────────

export class StateAuditor {
  constructor(private readonly state: ResearchStateEngine) {}

  /**
   * Run all audit checks and return a consolidated report.
   *
   * Checks performed:
   * 1. Source support — every finding has at least one sourceId
   * 2. Confidence calibration — high confidence + weak evidence = overconfidence
   * 3. Duplicate claims — near-duplicate normalized claims (Jaccard > 0.8)
   * 4. Contradiction integrity — contradiction sourceIds exist in source registry
   * 5. Caveat preservation — low confidence findings should have caveats
   * 6a. Source diversity — warn when ≤ 2 source types
   * 6b. YouTube transcript health — warn when > 30% failure rate
   * 6c. YouTube over-reliance — info when claim relies only on YouTube
   * 7. Taxonomy drift — findings reference defunct or revised sub-questions
   */
  audit(): AuditReport {
    const issues: AuditIssue[] = [];

    const findings = this.state.getFindings();
    const sources = this.state.getSources();
    const sourceIdSet = new Set(sources.map((s) => s.id));

    // ── 1. Source support ──────────────────────────────────────────────
    const unsourcedClaimFindings = new Set<string>();
    for (const f of findings) {
      if (f.sourceIds.length === 0) {
        unsourcedClaimFindings.add(f.id);
        issues.push({
          type: 'unsourced_claim',
          severity: 'error',
          description: `Finding "${truncate(f.claim)}" has no source IDs`,
          findingId: f.id,
        });
      }
    }

    // ── 2. Confidence calibration ──────────────────────────────────────
    for (const f of findings) {
      if (
        f.confidence >= 0.7 &&
        (f.evidenceDirectness === 'anecdotal' || f.evidenceDirectness === 'speculative')
      ) {
        issues.push({
          type: 'overconfidence',
          severity: 'warning',
          description: `Finding "${truncate(f.claim)}" has confidence ${String(f.confidence)} but evidence directness is '${f.evidenceDirectness}'`,
          findingId: f.id,
        });
      }

      if (
        f.confidence < 0.3 &&
        (f.evidenceDirectness === 'direct' || f.evidenceDirectness === 'near-direct')
      ) {
        issues.push({
          type: 'underconfidence',
          severity: 'info',
          description: `Finding "${truncate(f.claim)}" has confidence ${String(f.confidence)} but evidence directness is '${f.evidenceDirectness}'`,
          findingId: f.id,
        });
      }
    }

    // ── 3. Duplicate claims ────────────────────────────────────────────
    const duplicatePairs: [string, string][] = [];
    // Track which findings have already been grouped into a duplicate cluster
    const grouped = new Set<string>();
    const n = findings.length;

    for (let i = 0; i < n; i++) {
      const fi = findings[i];
      if (!fi || grouped.has(fi.id)) continue;

      for (let j = i + 1; j < n; j++) {
        const fj = findings[j];
        if (!fj || grouped.has(fj.id)) continue;

        const sim = jaccardSimilarity(fi.normalizedClaim, fj.normalizedClaim);
        if (sim > 0.8) {
          duplicatePairs.push([fi.id, fj.id]);
          grouped.add(fj.id);
          issues.push({
            type: 'duplicate_claim',
            severity: 'warning',
            description: `Findings "${truncate(fi.claim)}" and "${truncate(fj.claim)}" are near-duplicates (word-overlap similarity: ${sim.toFixed(2)})`,
            findingId: fj.id,
          });
        }
      }
      grouped.add(fi.id);
    }

    // ── 4. Contradiction integrity ─────────────────────────────────────
    const contradictions = this.state.getUnresolvedContradictions();
    for (const c of contradictions) {
      const missingA = c.sourceIdsA.filter((sid) => !sourceIdSet.has(sid));
      const missingB = c.sourceIdsB.filter((sid) => !sourceIdSet.has(sid));
      if (missingA.length > 0) {
        issues.push({
          type: 'contradiction_source_mismatch',
          severity: 'error',
          description: `Contradiction ${c.id} references source IDs not present in the source registry (claim A): ${missingA.join(', ')}`,
        });
      }
      if (missingB.length > 0) {
        issues.push({
          type: 'contradiction_source_mismatch',
          severity: 'error',
          description: `Contradiction ${c.id} references source IDs not present in the source registry (claim B): ${missingB.join(', ')}`,
        });
      }
    }

    // ── 5. Caveat preservation ─────────────────────────────────────────
    for (const f of findings) {
      if (f.confidence < 0.7 && !f.caveats) {
        issues.push({
          type: 'missing_caveat',
          severity: 'info',
          description: `Finding "${truncate(f.claim)}" has confidence ${String(f.confidence)} but no caveats`,
          findingId: f.id,
        });
      }
    }

    // ── 6a. Source diversity ──────────────────────────────────────────
    const typeCounts = new Map<string, number>();
    for (const s of sources) {
      typeCounts.set(s.sourceType, (typeCounts.get(s.sourceType) ?? 0) + 1);
    }
    const diversity = [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    if (diversity.length <= 2) {
      issues.push({
        type: 'low_source_diversity',
        severity: 'warning',
        description: `Only ${String(diversity.length)} source type(s) present: ${diversity.map((d) => d.type).join(', ')}`,
      });
    }

    // ── 6b. YouTube transcript health ──────────────────────────────
    const youtubeSources = sources.filter((s) => s.sourceType === 'youtube');
    const failedYouTubeSources = youtubeSources.filter((s) => s.extractionStatus === 'failed');
    if (youtubeSources.length > 0) {
      const failureRate = failedYouTubeSources.length / youtubeSources.length;
      if (failureRate > 0.3) {
        issues.push({
          type: 'youtube_transcript_failures',
          severity: 'warning',
          description: `YouTube transcript extraction failure rate is ${String(Math.round(failureRate * 100))}% (${String(failedYouTubeSources.length)}/${String(youtubeSources.length)} sources failed)`,
        });
      }
    }

    // ── 6c. YouTube over-reliance without corroboration ────────────
    const youtubeFindingIds = new Set(
      sources
        .filter((s) => s.sourceType === 'youtube' && s.extractionStatus === 'extracted')
        .map((s) => s.id),
    );
    if (youtubeFindingIds.size > 0) {
      for (const f of findings) {
        const hasYoutubeOnly = f.sourceIds.length > 0 &&
          f.sourceIds.every((sid) => youtubeFindingIds.has(sid));
        if (hasYoutubeOnly) {
          issues.push({
            type: 'youtube_only_claim',
            severity: 'info',
            description: `Finding "${truncate(f.claim)}" relies solely on YouTube sources without corroboration from other source types`,
            findingId: f.id,
          });
        }
      }
    }

    // ── 7. Taxonomy drift ──────────────────────────────────────────────
    const subQuestions = this.state.getSubQuestions();
    const subQIds = new Set(subQuestions.map((sq) => sq.id));

    let drift = false;
    for (const f of findings) {
      if (f.subQuestionIds.length === 0) {
        // Finding not linked to any sub-question — likely drift
        drift = true;
        issues.push({
          type: 'taxonomy_drift',
          severity: 'warning',
          description: `Finding "${truncate(f.claim)}" is not linked to any current sub-question`,
          findingId: f.id,
        });
        continue;
      }

      // Check if every referenced sub-question still exists
      const orphanRefs = f.subQuestionIds.filter((sqId) => !subQIds.has(sqId));
      if (orphanRefs.length > 0) {
        drift = true;
        issues.push({
          type: 'taxonomy_drift',
          severity: 'warning',
          description: `Finding "${truncate(f.claim)}" references sub-questions that no longer exist: ${orphanRefs.join(', ')}`,
          findingId: f.id,
        });
      }
    }

    // ── Assemble report ────────────────────────────────────────────────

    // Sort: errors first, then warnings, then info; stable by type within tier
    issues.sort((a, b) => {
      const sev = (SEVERITY_ORDER[a.severity] ?? 0) - (SEVERITY_ORDER[b.severity] ?? 0);
      if (sev !== 0) return sev;
      return a.type.localeCompare(b.type);
    });

    const lowConfidenceClaims = findings.filter((f) => f.confidence < 0.3).length;

    const report: AuditReport = {
      passed: issues.every((i) => i.severity !== 'error'),
      issues,
      stats: {
        totalClaims: findings.length,
        unsourcedClaims: unsourcedClaimFindings.size,
        lowConfidenceClaims,
        unresolvedContradictions: contradictions.length,
        mergedDuplicates: duplicatePairs.length,
        sourceDiversity: diversity,
        taxonomyDrift: drift,
      },
      timestamp: new Date().toISOString(),
    };

    return report;
  }
}
