/**
 * StrategyRegistry — holds registered research strategies and selects the
 * appropriate one based on available infrastructure (LLM presence).
 */

import type { ResearchStrategy, StrategyContext, StrategyFactory } from './types.js';

// ── Strategy metadata (no factory required for listing) ───────────────────

export interface StrategyInfo {
   name: string;
   description: string;
   requiresLlm: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────────

export class StrategyRegistry {
   private factories = new Map<string, StrategyFactory>();

   register(name: string, factory: StrategyFactory): void {
      if (this.factories.has(name)) {
         throw new Error(`Strategy already registered: ${name}`);
      }
      this.factories.set(name, factory);
   }

   create(name: string, ctx: StrategyContext): ResearchStrategy {
      const factory = this.factories.get(name);
      if (!factory) {
         const available = [...this.factories.keys()].join(', ');
         throw new Error(`Unknown strategy: ${name}. Available: ${available}`);
      }
      return factory(ctx);
   }

   /** Returns the default strategy name based on context. */
   selectDefault(ctx: StrategyContext): string {
      if (ctx.depth === 'tree') return 'tree';
      if (ctx.deterministic) return 'pipeline';
      if (ctx.llm) return 'agent';
      return 'pipeline';
   }

   listAvailable(ctx: StrategyContext): StrategyInfo[] {
      return [...this.factories.entries()].map(([_, factory]) => {
         const s = factory(ctx);
         return {
            name: s.name,
            description: s.description,
            requiresLlm: s.requiresLlm,
         };
      });
   }

   has(name: string): boolean {
      return this.factories.has(name);
   }

   /** Number of registered strategies. */
   get size(): number {
      return this.factories.size;
   }
}

// ── Singleton ─────────────────────────────────────────────────────────────

export const strategyRegistry = new StrategyRegistry();
