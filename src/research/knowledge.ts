import { randomUUID } from 'node:crypto';
import type { KnowledgeItem, Finding, GapTarget } from './types.js';

function makeId(): string {
  return randomUUID().slice(0, 12);
}

export class KnowledgeBase {
  private items: KnowledgeItem[] = [];

  /** Add a knowledge item (deduplicates by id when provided, otherwise by question+type).
   *  On collision, merges sourceFindingIds into the existing item. */
  add(item: Omit<KnowledgeItem, 'id'>, id?: string): KnowledgeItem {
    for (const existing of this.items) {
      let matched = false;
      if (id !== undefined) {
        matched = existing.id === id;
      } else {
        matched = existing.question === item.question && existing.type === item.type;
      }
      if (matched) {
        // Merge sourceFindingIds instead of silently discarding (P2)
        for (const sfId of item.sourceFindingIds) {
          if (!existing.sourceFindingIds.includes(sfId)) {
            existing.sourceFindingIds.push(sfId);
          }
        }
        return existing;
      }
    }
    const newItem: KnowledgeItem = {
      id: id ?? makeId(),
      ...item,
    };
    this.items.push(newItem);
    return newItem;
  }

  /** Convert findings to knowledge items (deduplicates by finding id). */
  ingestFindings(findings: Finding[], step: number): KnowledgeItem[] {
    const created: KnowledgeItem[] = [];
    for (const f of findings) {
      const item = this.add(
        {
          question:
            f.subQuestionIds.length > 0
              ? `Finding for sub-question ${f.subQuestionIds[0] ?? ''}`
              : 'General finding',
          answer: f.claim,
          references: f.sourceIds,
          type: 'finding',
          sourceFindingIds: [f.id],
          createdAtStep: step,
        },
        f.id,
      );
      created.push(item);
    }
    return created;
  }

  /** Ingest a SERP cluster hypothesis as a low-confidence knowledge item. */
  ingestSerpHypothesis(
    insight: string,
    question: string,
    sourceUrls: string[],
    step: number,
  ): KnowledgeItem {
    return this.add({
      question,
      answer: insight,
      references: sourceUrls,
      type: 'serp_hypothesis',
      sourceFindingIds: [],
      createdAtStep: step,
    });
  }

  /** Ingest a resolved gap target as knowledge. */
  ingestGapResolution(
    target: GapTarget,
    step: number,
    sourceIds: string[] = [],
  ): KnowledgeItem | undefined {
    if (!target.resolution) return undefined;
    return this.add({
      question: target.question,
      answer: target.resolution.answer,
      references: sourceIds,
      type: 'gap_resolution',
      sourceFindingIds: [],
      createdAtStep: step,
    });
  }

  /** Select top-K items (findings and gap resolutions) bounded by token budget. */
  selectForGap(maxItems: number, maxTokens: number): KnowledgeItem[] {
    const candidates = this.items.filter(
      (item) => item.type === 'finding' || item.type === 'gap_resolution',
    );
    return this.selectWithBudget(candidates, maxItems, maxTokens);
  }

  /** Select top-K items for synthesis, bounded by token budget. */
  selectForSynthesis(maxItems: number, maxTokens: number): KnowledgeItem[] {
    const candidates = this.items.filter((item) => item.type !== 'serp_hypothesis'); // exclude unconfirmed hypotheses
    return this.selectWithBudget(candidates, maxItems, maxTokens);
  }

  /** Render selected items as conversation pairs for LLM context. */
  renderAsConversation(items: KnowledgeItem[]): { role: string; content: string }[] {
    const pairs: { role: string; content: string }[] = [];
    for (const item of items) {
      pairs.push({ role: 'user', content: `Research finding: ${item.question}` });
      pairs.push({
        role: 'assistant',
        content: item.answer, // sources in references: ${item.references.join(', ')}
      });
    }
    return pairs;
  }

  /** Count all items. */
  count(): number {
    return this.items.length;
  }

  /** Get all items (for serialization). */
  getAll(): KnowledgeItem[] {
    return [...this.items];
  }

  /** Restore from serialized state. */
  load(items: KnowledgeItem[]): void {
    this.items = items;
  }

  // ── Private helpers ───────────────────────────────────────────

  private selectWithBudget(
    candidates: KnowledgeItem[],
    maxItems: number,
    maxTokens: number,
  ): KnowledgeItem[] {
    let tokenCount = 0;
    const selected: KnowledgeItem[] = [];
    for (const item of candidates) {
      if (selected.length >= maxItems) break;
      const estimatedTokens = Math.ceil((item.question.length + item.answer.length) / 4);
      if (tokenCount + estimatedTokens > maxTokens) break;
      selected.push(item);
      tokenCount += estimatedTokens;
    }
    return selected;
  }
}
