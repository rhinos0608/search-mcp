/**
 * ResearchSynthesizer — Phase 7: transforms structured research state into
 * a coherent, source-weighted, confidence-aware narrative answer.
 *
 * Operates on the structured state (findings, sources, contradictions, gaps),
 * never on raw crawl output.
 */

import type {
  ResearchState,
  Finding,
  SourceEntry,
  Contradiction,
  ConfidenceLabel,
  QueryClassification,
  ResearchDepth,
  ResearchReport,
  SubQuestion,
} from './types.js';

// ── Confidence prose prefixes ───────────────────────────────────────────────

const CONFIDENCE_PREFIX: Record<ConfidenceLabel, string> = {
  'well-corroborated': 'Well-corroborated evidence suggests',
  likely: 'Available evidence indicates',
  'plausible-but-thin': 'Several sources suggest, though evidence is limited, that',
  speculative: 'Some sources speculate that',
  'unsupported-or-disputed': 'Evidence is weak or contradictory on whether',
};

// ── Synthesizer ──────────────────────────────────────────────────────────────

export class ResearchSynthesizer {
  private state: ResearchState;

  constructor(state: ResearchState) {
    this.state = state;
  }

  synthesize(): ResearchReport {
    const findings = this.state.findings;
    const sources = this.state.sources;
    const contradictions = this.state.contradictions;
    const subQuestions = this.state.subQuestions;

    return {
      query: this.state.query,
      classification: this.inferClassification(),
      depth: this.inferDepth(),
      executiveSummary: this.buildExecutiveSummary(findings),
      themes: this.buildThemes(findings, subQuestions),
      contradictions: contradictions,
      uncertainties: this.buildUncertainties(findings, contradictions),
      sourceNotes: this.buildSourceNotes(sources),
      openQuestions: this.state.openQuestions,
      limitations: this.buildLimitations(sources, subQuestions),
      sourceCount: sources.length,
      findingCount: findings.length,
      confidenceDistribution: this.computeConfidenceDistribution(findings),
    };
  }

  // ── Internal builders ──────────────────────────────────────────────────

  private inferClassification(): QueryClassification {
    // Infer from sub-questions or default to explainer
    const counts: Record<string, number> = {};
    for (const sq of this.state.subQuestions) {
      counts[sq.classification] = (counts[sq.classification] ?? 0) + 1;
    }
    let maxCount = 0;
    let best: QueryClassification = 'explainer';
    for (const [key, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        best = key as QueryClassification;
      }
    }
    return best;
  }

  private inferDepth(): ResearchDepth {
    const srcCount = this.state.sources.length;
    if (srcCount <= 10) return 'quick';
    if (srcCount <= 25) return 'standard';
    if (srcCount <= 60) return 'deep';
    return 'exhaustive';
  }

  private buildExecutiveSummary(findings: Finding[]): string {
    if (findings.length === 0) {
      return 'No findings were extracted during this research run. The topic may be too narrow or no suitable sources were discovered.';
    }

    const highConf = findings.filter((f) => f.confidence >= 0.7);
    const resolvedSQs = this.state.subQuestions.filter(
      (sq) => sq.status === 'sufficient' || sq.status === 'low_confidence',
    );
    const contradictions = this.state.contradictions.filter(
      (c) => c.resolutionStatus !== 'resolved',
    );

    const parts: string[] = [];

    if (highConf.length > 0) {
      parts.push(
        `This research found ${String(highConf.length)} well-supported claims across ${String(resolvedSQs.length)} of ${String(this.state.subQuestions.length)} research questions.`,
      );
    }

    if (contradictions.length > 0) {
      parts.push(
        `${String(contradictions.length)} unresolved ${contradictions.length === 1 ? 'contradiction was' : 'contradictions were'} identified between sources.`,
      );
    }

    const lowConf = findings.filter((f) => f.confidence < 0.5);
    if (lowConf.length > 0) {
      parts.push(
        `${String(lowConf.length)} ${lowConf.length === 1 ? 'claim has' : 'claims have'} low confidence and may need further verification.`,
      );
    }

    return parts.join(' ');
  }

  private buildThemes(
    findings: Finding[],
    subQuestions: SubQuestion[],
  ): { title: string; findings: string[]; confidence: ConfidenceLabel }[] {
    // Group findings by sub-question to form themes
    const themeMap = new Map<
      string,
      { title: string; claims: string[]; confidences: ConfidenceLabel[] }
    >();

    for (const sq of subQuestions) {
      const sqFindings = findings.filter((f) => f.subQuestionIds.includes(sq.id));
      if (sqFindings.length === 0) continue;

      const claims: string[] = [];
      const confidences: ConfidenceLabel[] = [];

      for (const f of sqFindings) {
        const prefix = CONFIDENCE_PREFIX[f.confidenceLabel] || 'Sources indicate';
        claims.push(`${prefix} ${f.claim.toLowerCase()}.`);
        confidences.push(f.confidenceLabel);
      }

      themeMap.set(sq.id, {
        title: sq.text,
        claims,
        confidences,
      });
    }

    // Group any findings not associated with a sub-question into "Additional findings"
    const orphanFindings = findings.filter(
      (f) => !f.subQuestionIds.some((id) => subQuestions.some((sq) => sq.id === id)),
    );
    if (orphanFindings.length > 0) {
      themeMap.set('orphan', {
        title: 'Additional Findings',
        claims: orphanFindings.map(
          (f) =>
            `${CONFIDENCE_PREFIX[f.confidenceLabel] || 'Sources indicate'} ${f.claim.toLowerCase()}.`,
        ),
        confidences: orphanFindings.map((f) => f.confidenceLabel),
      });
    }

    return Array.from(themeMap.values()).map((t) => ({
      title: t.title,
      findings: t.claims,
      confidence: aggregateConfidence(t.confidences),
    }));
  }

  private buildUncertainties(findings: Finding[], contradictions: Contradiction[]): string[] {
    const uncertainties: string[] = [];

    // Low-confidence findings
    const lowConf = findings.filter((f) => f.confidence < 0.5);
    for (const f of lowConf.slice(0, 5)) {
      uncertainties.push(
        `${f.claim} — confidence is low (${f.confidenceLabel.replace(/-/g, ' ')}). ${f.caveats ? `Caveat: ${f.caveats}` : 'Further evidence needed.'}`,
      );
    }

    // Unresolved contradictions
    const unresolved = contradictions.filter((c) => c.resolutionStatus !== 'resolved');
    for (const c of unresolved.slice(0, 3)) {
      uncertainties.push(
        `Sources disagree: "${c.claimA}" vs "${c.claimB}". ${c.likelyExplanation ? `Possible explanation: ${c.likelyExplanation}` : 'The nature of this disagreement is unclear.'}`,
      );
    }

    return uncertainties;
  }

  private buildSourceNotes(sources: SourceEntry[]): string[] {
    if (sources.length === 0) return ['No sources were analyzed.'];

    const notes: string[] = [];
    const byType = new Map<string, number>();
    for (const s of sources) {
      byType.set(s.sourceType, (byType.get(s.sourceType) ?? 0) + 1);
    }

    notes.push(
      `Analysis based on ${String(sources.length)} sources across ${String(byType.size)} source types: ${Array.from(
        byType.entries(),
      )
        .map(([t, c]) => `${String(c)} ${t}`)
        .join(', ')}.`,
    );

    const primaryCount = sources.filter((s) => s.isPrimary).length;
    if (primaryCount > 0) {
      notes.push(
        `${String(primaryCount)} primary sources (academic papers, repositories) were included.`,
      );
    }

    return notes;
  }

  private buildLimitations(sources: SourceEntry[], _subQuestions: SubQuestion[]): string[] {
    const limitations: string[] = [];

    const byType = new Map<string, number>();
    for (const s of sources) {
      byType.set(s.sourceType, (byType.get(s.sourceType) ?? 0) + 1);
    }

    if (byType.size <= 2) {
      limitations.push(
        `Source diversity is limited — only ${String(byType.size)} source type${byType.size === 1 ? '' : 's'} were found. Results may favor certain perspectives.`,
      );
    }

    const noAcademic = !byType.has('academic');
    const noPractitioner = !byType.has('reddit') && !byType.has('hackernews');
    if (noAcademic && !noPractitioner) {
      limitations.push(
        'No academic sources were included. Technical claims may lack peer-reviewed backing.',
      );
    }
    if (noPractitioner && !noAcademic) {
      limitations.push(
        'No practitioner sources (discussions, forums) were included. Real-world usage signals may be missing.',
      );
    }

    return limitations;
  }

  private computeConfidenceDistribution(findings: Finding[]): Record<ConfidenceLabel, number> {
    const dist: Record<string, number> = {};
    for (const f of findings) {
      dist[f.confidenceLabel] = (dist[f.confidenceLabel] ?? 0) + 1;
    }
    return dist;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function aggregateConfidence(labels: ConfidenceLabel[]): ConfidenceLabel {
  const order: ConfidenceLabel[] = [
    'unsupported-or-disputed',
    'speculative',
    'plausible-but-thin',
    'likely',
    'well-corroborated',
  ];
  let maxIdx = 0;
  for (const l of labels) {
    const idx = order.indexOf(l);
    if (idx > maxIdx) maxIdx = idx;
  }
  return order[maxIdx] ?? 'plausible-but-thin';
}
