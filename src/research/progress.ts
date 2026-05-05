/**
 * ProgressTracker — progressive rendering for deep research.
 *
 * Accumulates a timeline of structured progress updates during a research run.
 * Delivered as `timeline` in the tool response metadata.
 */

import type {
  ResearchProgress,
  QueryClassification,
  SubQuestion,
  ResearchTaxonomy,
  Finding,
  Contradiction,
  GapRecord,
} from './types.js';

export class ProgressTracker {
  private timeline: ResearchProgress[] = [];

  getTimeline(): ResearchProgress[] {
    return [...this.timeline];
  }

  getLastUpdate(): ResearchProgress | undefined {
    return this.timeline[this.timeline.length - 1];
  }

  decompositionComplete(classification: QueryClassification, subQuestions: SubQuestion[]): void {
    this.timeline.push({ phase: 'decomposition', plan: { classification, subQuestions } });
  }

  sourcesDiscovered(subQuestionSources: { subQuestionId: string; count: number }[]): void {
    this.timeline.push({ phase: 'discovery', sources: subQuestionSources });
  }

  extractionProgress(completed: number, total: number): void {
    this.timeline.push({ phase: 'extraction', completed, total });
  }

  findingsExtracted(findings: Finding[]): void {
    this.timeline.push({ phase: 'findings', findings });
  }

  taxonomyRevised(taxonomy: ResearchTaxonomy): void {
    this.timeline.push({ phase: 'taxonomy_revision', taxonomy });
  }

  contradictionsFound(contradictions: Contradiction[]): void {
    this.timeline.push({ phase: 'contradictions', contradictions });
  }

  gapsIdentified(gaps: GapRecord[]): void {
    this.timeline.push({ phase: 'gap_analysis', gaps });
  }

  synthesisOutlined(outline: string): void {
    this.timeline.push({ phase: 'synthesis', outline });
  }

  limitationsIdentified(limitations: string[]): void {
    this.timeline.push({ phase: 'limitations', limitations });
  }

  researchComplete(): void {
    this.timeline.push({ phase: 'complete' });
  }
}
