/**
 * ResearchSynthesizer — Phase 7: transforms structured research state into
 * a coherent, source-weighted, confidence-aware narrative answer.
 *
 * Operates on the structured state (findings, sources, contradictions, gaps),
 * never on raw crawl output.
 */

import { rankSource } from './sourceRanking.js';
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
         narrativeMarkdown: this.buildNarrativeMarkdown(findings, subQuestions, sources, contradictions),
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
   ): { title: string; narrative: string; confidence: ConfidenceLabel }[] {
      const themeMap = new Map<
         string,
         { title: string; claims: string[]; confidences: ConfidenceLabel[]; sourceIds: string[] }
      >();

      for (const sq of subQuestions) {
         const sqFindings = findings.filter((f) => f.subQuestionIds.includes(sq.id));
         if (sqFindings.length === 0) continue;

         const claims: string[] = [];
         const confidences: ConfidenceLabel[] = [];
         const sourceIds: string[] = [];

         for (const f of sqFindings) {
            claims.push(f.claim);
            confidences.push(f.confidenceLabel);
            sourceIds.push(...f.sourceIds);
         }

         themeMap.set(sq.id, {
            title: sq.text,
            claims,
            confidences,
            sourceIds: [...new Set(sourceIds)],
         });
      }

      // Group any findings not associated with a sub-question into "Additional findings"
      const orphanFindings = findings.filter(
         (f) => !f.subQuestionIds.some((id) => subQuestions.some((sq) => sq.id === id)),
      );
      if (orphanFindings.length > 0) {
         const orphanClaims = orphanFindings.map((f) => f.claim);
         themeMap.set('orphan', {
            title: 'Additional Findings',
            claims: orphanClaims,
            confidences: orphanFindings.map((f) => f.confidenceLabel),
            sourceIds: [...new Set(orphanFindings.flatMap((f) => f.sourceIds))],
         });
      }

      return Array.from(themeMap.values()).map((t) => {
         const sourceEntries = t.sourceIds
            .map((id) => this.state.sources.find((s) => s.id === id))
            .filter((s): s is SourceEntry => s !== undefined);

         const avgEvidenceWeight = sourceEntries.length > 0
            ? sourceEntries.reduce((acc, s) => acc + rankSource(s).evidenceWeight, 0) / sourceEntries.length
            : 0.5;

         const baseConfidence = aggregateConfidence(t.confidences);
         const weightedConfidence = avgEvidenceWeight >= 0.7
            ? baseConfidence
            : avgEvidenceWeight >= 0.5
               ? this.downgradeConfidence(baseConfidence, 1)
               : this.downgradeConfidence(baseConfidence, 2);

         return {
            title: t.title,
            narrative: this.buildThemeNarrative(t.claims, t.confidences, t.sourceIds),
            confidence: weightedConfidence,
         };
      });
   }

   /** Build a short prose narrative paragraph from claims and sources. */
   private buildThemeNarrative(
      claims: string[],
      confidences: ConfidenceLabel[],
      sourceIds: string[],
   ): string {
      if (claims.length === 0) return 'No findings were available for this theme.';

      const parts: string[] = [];
      const highConf = claims.filter((_, i) => confidences[i] === 'well-corroborated' || confidences[i] === 'likely');
      const lowConf = claims.filter((_, i) => confidences[i] === 'speculative' || confidences[i] === 'unsupported-or-disputed');

      if (highConf.length > 0) {
         parts.push(`Based on ${String(highConf.length)} well-supported finding${highConf.length === 1 ? '' : 's'} with corroborating evidence across ${String(sourceIds.length)} source${sourceIds.length === 1 ? '' : 's'}.`);
      }

      // Add the most confident claim as the lead
      const bestIdx = confidences.indexOf('well-corroborated');
      const leadClaim = bestIdx >= 0 ? claims[bestIdx] : claims[0];
      if (leadClaim) {
         parts.push(leadClaim);
      }

      // Add secondary claims
      for (let i = 0; i < Math.min(claims.length, 5); i++) {
         if (i === (bestIdx >= 0 ? bestIdx : 0)) continue; // skip the lead (already included)
         const label = confidences[i];
         const claim = claims[i];
         const prefix = label !== undefined ? CONFIDENCE_PREFIX[label] : 'Sources indicate';
         parts.push(prefix + ' ' + (claim ?? '').toLowerCase() + '.');
      }

      if (lowConf.length > 0) {
         parts.push(`However, ${String(lowConf.length)} claim${lowConf.length === 1 ? '' : 's'} ${lowConf.length === 1 ? 'has' : 'have'} limited or contradictory evidence and should be treated cautiously.`);
      }

      return parts.join(' ');
   }

   private buildUncertainties(findings: Finding[], contradictions: Contradiction[]): string[] {
      const uncertainties: string[] = [];

      // Low-confidence findings
      const lowConf = findings.filter((f) => f.confidence < 0.5);
      for (const f of lowConf.slice(0, 5)) {
         uncertainties.push(
            `${f.claim} — confidence is low (${f.confidenceLabel.replace(/-/g, ' ')}).${f.caveats ? `Caveat: ${f.caveats}` : 'Further evidence needed.'} `,
         );
      }

      // Unresolved contradictions
      const unresolved = contradictions.filter((c) => c.resolutionStatus !== 'resolved');
      for (const c of unresolved.slice(0, 3)) {
         uncertainties.push(
            `Sources disagree: "${c.claimA}" vs "${c.claimB}".${c.likelyExplanation ? `Possible explanation: ${c.likelyExplanation}` : 'The nature of this disagreement is unclear.'} `,
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
            .join(', ')
         }.`,
      );

      const primaryCount = sources.filter((s) => s.isPrimary).length;
      if (primaryCount > 0) {
         notes.push(
            `${String(primaryCount)} primary sources(academic papers, repositories) were included.`,
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

   private downgradeConfidence(label: ConfidenceLabel, steps: number): ConfidenceLabel {
      const order: ConfidenceLabel[] = [
         'well-corroborated',
         'likely',
         'plausible-but-thin',
         'speculative',
         'unsupported-or-disputed',
      ];
      const idx = order.indexOf(label);
      if (idx < 0) return label;
      const newIdx = Math.min(order.length - 1, idx + steps);
      return order[newIdx] ?? 'unsupported-or-disputed';
   }

   /**
    * Build a flowing narrative markdown report from the research state.
    * This is the primary output — a report a human can read.
    */
   private buildNarrativeMarkdown(
      findings: Finding[],
      subQuestions: SubQuestion[],
      sources: SourceEntry[],
      contradictions: Contradiction[],
   ): string {
      const parts: string[] = [];
      parts.push(`# Research Report: ${this.state.query}\n`);
      parts.push(`## Executive Summary\n${this.buildExecutiveSummary(findings)}\n`);

      // Build source index for inline citations
      const sourceIndex = new Map(sources.map((s, i) => [s.id, i + 1]));

      // Themes grouped by sub-question
      for (const sq of subQuestions) {
         const sqFindings = findings.filter((f) => f.subQuestionIds.includes(sq.id));
         if (sqFindings.length === 0) {
            parts.push(`## ${sq.text}\n`);
            parts.push(`*No findings were discovered for this sub-question.*\n`);
            continue;
         }

         const sqSources = sources.filter((s) => s.relevantSubQuestions.includes(sq.id));
         const domainCount = new Set(sqSources.map((s) => s.domain)).size;

         parts.push(`## ${sq.text}\n`);

         // Coverage note
         if (sqSources.length < 2 || domainCount < 2) {
            parts.push(`*Note: This sub-question has thin coverage — only ${sqSources.length} source(s) from ${domainCount} domain(s).*\n`);
         }

         for (const f of sqFindings) {
            const sourceRefs = f.sourceIds
               .map((sid) => sourceIndex.get(sid))
               .filter((n): n is number => n !== undefined)
               .map((n) => `[Source ${String(n)}]`)
               .join(', ');

            const confidenceNote = f.confidence < 0.5 ? ' *(low confidence)*' : '';
            const sourceNote = f.sourceIds.length === 1 ? ' *(single source)*' : '';

            parts.push(`- ${f.claim}${confidenceNote}${sourceNote} ${sourceRefs}`);

            if (f.caveats) {
               parts.push(`  - Caveat: ${f.caveats}`);
            }
         }
         parts.push('');
      }

      // Orphan findings
      const orphanFindings = findings.filter(
         (f) => !f.subQuestionIds.some((id) => subQuestions.some((sq) => sq.id === id)),
      );
      if (orphanFindings.length > 0) {
         parts.push('## Additional Findings\n');
         for (const f of orphanFindings) {
            parts.push(`- ${f.claim} *(confidence: ${(f.confidence * 100).toFixed(0)}%)*\n`);
         }
         parts.push('');
      }

      // Contradictions
      if (contradictions.length > 0) {
         parts.push('## Contradictions & Debates\n');
         for (const c of contradictions) {
            parts.push(`- **${c.claimA}** vs **${c.claimB}**`);
            if (c.likelyExplanation) parts.push(`  - ${c.likelyExplanation}`);
            parts.push(`  - Status: ${c.resolutionStatus}\n`);
         }
      }

      // Source list
      parts.push('## Sources\n');
      for (const [i, s] of sources.entries()) {
         parts.push(`${String(i + 1)}. [${s.title}](${s.url}) (${s.sourceType}, domain: ${s.domain})\n`);
      }

      // Uncertainties
      const uncertainties = this.buildUncertainties(findings, contradictions);
      if (uncertainties.length > 0) {
         parts.push('\n## Uncertainties & Limitations\n');
         for (const u of uncertainties) {
            parts.push(`- ${u}\n`);
         }
      }

      // Limitations
      const limitations = this.buildLimitations(sources, subQuestions);
      if (limitations.length > 0) {
         parts.push('\n## Research Limitations\n');
         for (const l of limitations) {
            parts.push(`- ${l}\n`);
         }
      }

      return parts.join('\n');
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
