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
   QueryClassification,
   ResearchDepth,
   ResearchReport,
   SubQuestion,
} from './types.js';

// ── Utilities ───────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
   if (s.length === 0) return s;
   return s.charAt(0).toUpperCase() + s.slice(1);
}

function decapitalize(s: string): string {
   if (s.length === 0) return s;
   return s.charAt(0).toLowerCase() + s.slice(1);
}

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

      // Compute source type breakdown once for reuse
      const byType = new Map<string, number>();
      for (const s of sources) {
         byType.set(s.sourceType, (byType.get(s.sourceType) ?? 0) + 1);
      }
      const sourceDiversity = [...byType.entries()]
         .map(([type, count]) => ({ type, count }))
         .sort((a, b) => b.count - a.count);

      return {
         query: this.state.query,
         classification: this.inferClassification(),
         depth: this.inferDepth(),
         executiveSummary: this.buildExecutiveSummary(findings),
         narrativeMarkdown: this.buildNarrativeMarkdown(findings, subQuestions, sources, contradictions),
         themes: this.buildThemes(findings, subQuestions),
         contradictions: contradictions,
         uncertainties: this.buildUncertainties(contradictions),
         sourceNotes: this.buildSourceNotes(sources, byType),
         openQuestions: this.state.openQuestions,
         limitations: this.buildLimitations(sources, subQuestions, byType),
         sourceCount: sources.length,
         sourceTypeCount: byType.size,
         sourceDiversity,
         findingCount: findings.length,
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

      // Count sub-questions that actually have findings (not by status, which may be stale)
      const sqIdsWithFindings = new Set<string>();
      for (const f of findings) {
         for (const sqId of f.subQuestionIds) {
            sqIdsWithFindings.add(sqId);
         }
      }
      const coveredCount = sqIdsWithFindings.size;
      const totalSQs = this.state.subQuestions.length;

      const contradictions = this.state.contradictions.filter(
         (c) => c.resolutionStatus !== 'resolved',
      );

      const parts: string[] = [];

      parts.push(
         `This research found ${String(findings.length)} claims covering ${String(coveredCount)} of ${String(totalSQs)} research questions.`,
      );

      if (contradictions.length > 0) {
         parts.push(
            `${String(contradictions.length)} unresolved ${contradictions.length === 1 ? 'contradiction was' : 'contradictions were'} identified between sources.`,
         );
      }

      return parts.join(' ');
   }

   private buildThemes(
      findings: Finding[],
      subQuestions: SubQuestion[],
   ): { title: string; narrative: string }[] {
      const themeMap = new Map<
         string,
         { title: string; claims: string[]; sourceIds: string[] }
      >();

      for (const sq of subQuestions) {
         const sqFindings = findings.filter((f) => f.subQuestionIds.includes(sq.id));
         if (sqFindings.length === 0) continue;

         const claims: string[] = [];
         const sourceIds: string[] = [];

         for (const f of sqFindings) {
            claims.push(f.claim);
            sourceIds.push(...f.sourceIds);
         }

         themeMap.set(sq.id, {
            title: sq.text,
            claims,
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
            sourceIds: [...new Set(orphanFindings.flatMap((f) => f.sourceIds))],
         });
      }

      return Array.from(themeMap.values()).map((t) => ({
         title: t.title,
         narrative: this.buildThemeNarrative(t.claims),
      }));
   }

   private formatSourceRefs(
      sourceIds: string[],
      sourceIndex: Map<string, number>,
   ): string {
      const refs = sourceIds
         .map((sid) => sourceIndex.get(sid))
         .filter((n): n is number => n !== undefined)
         .map((n) => `[Source ${String(n)}]`)
         .join(', ');
      return refs ? `(${refs})` : '';
   }

   private buildProseParagraph(
      findings: Finding[],
      _sqSources: SourceEntry[],
      sourceIndex: Map<string, number>,
   ): string {
      const firstFinding = findings[0];
      if (!firstFinding) return '';

      const sentences: string[] = [];

      // Opening sentence
      const firstRefs = this.formatSourceRefs(firstFinding.sourceIds, sourceIndex);
      sentences.push(`${capitalize(firstFinding.claim)}${firstRefs ? ` ${firstRefs}` : ''}.`);

      // Supporting sentences
      for (let i = 1; i < Math.min(findings.length, 6); i++) {
         const f = findings[i];
         if (!f) continue;
         const refs = this.formatSourceRefs(f.sourceIds, sourceIndex);
         const starter = i % 3 === 0 ? 'Additionally, ' : i % 3 === 1 ? 'Evidence also suggests that ' : 'Sources indicate that ';
         const refSuffix = refs ? ` ${refs}` : '';
         sentences.push(`${starter}${decapitalize(f.claim)}${refSuffix}.`);
      }

      return sentences.join(' ');
   }

   /** Build a short prose narrative paragraph from claims and sources. */
   private buildThemeNarrative(
      claims: string[],
   ): string {
      if (claims.length === 0) return 'No findings were available for this theme.';

      const parts: string[] = [];

      // Lead claim
      if (claims[0]) {
         parts.push(claims[0] + '.');
      }

      // Secondary claims
      for (let i = 1; i < Math.min(claims.length, 5); i++) {
         const claim = claims[i];
         if (claim) {
            parts.push('Sources indicate ' + claim.toLowerCase() + '.');
         }
      }

      return parts.join(' ');
   }

   private buildUncertainties(contradictions: Contradiction[]): string[] {
      const uncertainties: string[] = [];

      // Unresolved contradictions
      const unresolved = contradictions.filter((c) => c.resolutionStatus !== 'resolved');
      for (const c of unresolved.slice(0, 3)) {
         uncertainties.push(
            `Sources disagree: "${c.claimA}" vs "${c.claimB}".${c.likelyExplanation ? `Possible explanation: ${c.likelyExplanation}` : 'The nature of this disagreement is unclear.'} `,
         );
      }

      return uncertainties;
   }

   private buildSourceNotes(sources: SourceEntry[], byType?: Map<string, number>): string[] {
      if (sources.length === 0) return ['No sources were analyzed.'];

      const notes: string[] = [];
      const typeMap = byType ?? this.buildTypeMap(sources);

      const totalSources = sources.length;
      const totalTypes = typeMap.size;
      const breakdown = Array.from(typeMap.entries())
         .map(([t, c]) => `${String(c)} ${t}`)
         .join(', ');

      notes.push(
         `Analysis based on ${String(totalSources)} individual sources across ${String(totalTypes)} source types (${breakdown}).`,
      );

      const primaryCount = sources.filter((s) => s.isPrimary).length;
      if (primaryCount > 0) {
         notes.push(
            `${String(primaryCount)} primary sources(academic papers, repositories) were included.`,
         );
      }

      return notes;
   }

   private buildLimitations(sources: SourceEntry[], _subQuestions: SubQuestion[], byType?: Map<string, number>): string[] {
      const limitations: string[] = [];

      const typeMap = byType ?? this.buildTypeMap(sources);

      if (typeMap.size <= 2) {
         limitations.push(
            `Source diversity is limited — only ${String(typeMap.size)} source type${typeMap.size === 1 ? '' : 's'} (corpuses) were found across ${String(sources.length)} total sources. Results may favor certain perspectives.`,
         );
      }

      const noAcademic = !typeMap.has('academic');
      const noPractitioner = !typeMap.has('reddit') && !typeMap.has('hackernews');
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



   /**
    * Build a flowing narrative markdown report from the research state.
    * This is the primary output — a report a human can read.
    */
   /** Build a Map<sourceType, count> from sources. */
   private buildTypeMap(sources: SourceEntry[]): Map<string, number> {
      const m = new Map<string, number>();
      for (const s of sources) {
         m.set(s.sourceType, (m.get(s.sourceType) ?? 0) + 1);
      }
      return m;
   }

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
            parts.push(`*Note: This sub-question has thin coverage — only ${String(sqSources.length)} source(s) from ${String(domainCount)} domain(s).*\n`);
         }

         // Build prose paragraph from all findings in this sub-question
         const proseParagraph = this.buildProseParagraph(sqFindings, sqSources, sourceIndex);
         if (proseParagraph) {
            parts.push(proseParagraph);
         }
         parts.push('');
      }

      // Orphan findings
      const orphanFindings = findings.filter(
         (f) => !f.subQuestionIds.some((id) => subQuestions.some((sq) => sq.id === id)),
      );
      if (orphanFindings.length > 0) {
         parts.push('## Additional Findings\n');
         const orphanParagraph = this.buildProseParagraph(orphanFindings, [], sourceIndex);
         if (orphanParagraph) {
            parts.push(orphanParagraph);
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

      // Source list — split into used vs discarded/failed
      const usedSources = sources.filter(
         (s) => s.usageStatus !== 'discarded' && s.usageStatus !== 'failed',
      );
      const discardedSources = sources.filter(
         (s) => s.usageStatus === 'discarded' || s.usageStatus === 'failed',
      );

      parts.push('## Sources\n');
      if (usedSources.length === 0) {
         parts.push('*No cited sources.*\n');
      } else {
         for (const [i, s] of usedSources.entries()) {
            parts.push(`${String(i + 1)}. [${s.title}](${s.url}) (${s.sourceType}, domain: ${s.domain})\n`);
         }
      }

      if (discardedSources.length > 0) {
         parts.push('\n## Sources Examined\n');
         parts.push('The following sources were examined during research but did not contribute findings to this report:\n\n');
         for (const [i, s] of discardedSources.entries()) {
            const reason = s.discardReason ?? 'unknown';
            parts.push(`${String(i + 1)}. [${s.title}](${s.url}) (${s.sourceType}, domain: ${s.domain}) — Discarded: ${reason}\n`);
         }
      }

      // Uncertainties
      const uncertainties = this.buildUncertainties(contradictions);
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
