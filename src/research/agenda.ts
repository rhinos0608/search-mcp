import { randomUUID } from 'node:crypto';
import type { GapTarget } from './types.js';

interface AgendaDedupOptions {
   enableSemanticDedup?: boolean;
   jaccardThreshold?: number;
}

const DEFAULT_DEDUP_OPTIONS: Required<AgendaDedupOptions> = {
   enableSemanticDedup: false,
   jaccardThreshold: 0.7,
};

function makeId(): string {
   return randomUUID().slice(0, 12);
}

/** Normalize text for dedup comparison. */
function normalize(text: string): string {
   return text.toLowerCase().replace(/[^\w\s]/g, '').trim();
}

/** Jaccard similarity over word sets. */
function jaccardSimilarity(a: string, b: string): number {
   const setA = new Set(normalize(a).split(/\s+/).filter(Boolean));
   const setB = new Set(normalize(b).split(/\s+/).filter(Boolean));
   if (setA.size === 0 && setB.size === 0) return 1;
   if (setA.size === 0 || setB.size === 0) return 0;
   let intersection = 0;
   for (const word of setA) {
      if (setB.has(word)) intersection++;
   }
   const union = setA.size + setB.size - intersection;
   return union === 0 ? 0 : intersection / union;
}

const MAX_ATTEMPTS_PER_TARGET = 3;

export class Agenda {
   private targets: GapTarget[] = [];
   private stepCounter = 0;
   private options: Required<AgendaDedupOptions>;

   constructor(options?: AgendaDedupOptions) {
      this.options = { ...DEFAULT_DEDUP_OPTIONS, ...options };
   }

   /** Get the next eligible target for processing. Does NOT remove it. */
   nextTarget(step?: number): GapTarget | undefined {
      if (step !== undefined) this.stepCounter = step;
      // Prefer 'open' targets with highest priority, then oldest lastTriedAtStep
      const candidates = this.targets
         .filter((t) => t.status === 'open' && t.attempts < MAX_ATTEMPTS_PER_TARGET)
         .sort((a, b) => {
            const prio = a.priority - b.priority;
            if (prio !== 0) return prio;
            return (a.lastTriedAtStep ?? 0) - (b.lastTriedAtStep ?? 0);
         });
      return candidates[0];
   }

   /** Mark a target as actively being worked. */
   activate(id: string): void {
      const t = this.targets.find((t) => t.id === id);
      if (!t) return;
      if (t.status !== 'active') {
         t.lastTriedAtStep = this.stepCounter;
         t.attempts++;
      }
      t.status = 'active';
   }

   /** Mark a target as resolved with answer evidence. */
   resolve(id: string, resolution: GapTarget['resolution']): void {
      const t = this.targets.find((t) => t.id === id);
      if (!t || !resolution) return;
      t.status = 'resolved';
      t.resolution = resolution;
   }

   /** Defer a target — keep it open but mark priority down. */
   defer(id: string, reason?: string): void {
      const t = this.targets.find((t) => t.id === id);
      if (!t) return;
      t.status = 'open';
      t.priority = Math.min(5, t.priority + 1);
      if (reason) t.failureReason = reason;
   }

   /** Permanently abandon a target. */
   abandon(id: string, reason?: string): void {
      const t = this.targets.find((t) => t.id === id);
      if (!t) return;
      t.status = 'abandoned';
      if (reason) t.failureReason = reason;
   }

   /** Add a new target, deduplicating by normalized text (and optionally Jaccard similarity). */
   enqueue(target: Omit<GapTarget, 'id' | 'normalizedQuestion' | 'status' | 'attempts' | 'createdAtStep'>): GapTarget | undefined {
      const normalized = normalize(target.question);

      // Check for duplicates by normalized text
      for (const existing of this.targets) {
         if (existing.normalizedQuestion === normalized) {
            // Mark as duplicate
            if (existing.status === 'open' || existing.status === 'active') {
               return undefined; // already present as actionable
            }
         }

         // Optional semantic dedup
         if (this.options.enableSemanticDedup) {
            const sim = jaccardSimilarity(existing.question, target.question);
            if (sim >= this.options.jaccardThreshold && (existing.status === 'open' || existing.status === 'active')) {
               return undefined;
            }
         }
      }



      const newTarget: GapTarget = {
         id: makeId(),
         question: target.question,
         normalizedQuestion: normalized,
         ...(target.parentId !== undefined ? { parentId: target.parentId, parentQuestion: target.parentQuestion } : {}),
         status: 'open',
         priority: target.priority,
         attempts: 0,
         createdAtStep: this.stepCounter,
         source: target.source,
      };

      // Block parent-child cycles — walk up the parent chain, detect existing cycles
      if (newTarget.parentId) {
         const visited = new Set<string>();
         let currentId: string | undefined = newTarget.parentId;
         let steps = 0;
         while (currentId && steps < 50) {
            if (visited.has(currentId)) return undefined; // existing cycle detected
            visited.add(currentId);
            const current = this.targets.find((t) => t.id === currentId);
            currentId = current?.parentId;
            steps++;
         }
      }

      this.targets.push(newTarget);
      return newTarget;
   }

   /** Check if a target has remaining attempts. */
   attemptsRemaining(id: string): boolean {
      const t = this.targets.find((t) => t.id === id);
      return t ? t.attempts < MAX_ATTEMPTS_PER_TARGET : false;
   }

   /** Get all targets (for inspection/serialization). */
   getAll(): GapTarget[] {
      return [...this.targets];
   }

   /** Get open targets only. */
   getOpen(): GapTarget[] {
      return this.targets.filter((t) => t.status === 'open');
   }

   /** Get resolved targets. */
   getResolved(): GapTarget[] {
      return this.targets.filter((t) => t.status === 'resolved');
   }

   /** Count of open targets. */
   openCount(): number {
      return this.targets.filter((t) => t.status === 'open').length;
   }

   /** Increment step counter. */
   tick(): number {
      return ++this.stepCounter;
   }

   /** Get current step. */
   getStep(): number {
      return this.stepCounter;
   }

   /** Restore from serialized state. */
   load(targets: GapTarget[], step: number): void {
      this.targets = targets;
      this.stepCounter = step;
   }
}
