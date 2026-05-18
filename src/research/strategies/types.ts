/**
 * Strategy interface for deep research.
 *
 * Replaces the fixed 7-phase pipeline with a pluggable architecture.
 * Strategies: agent (ReAct, default with LLM), pipeline (deterministic, no LLM), tree (recursive).
 */

import type { ResearchStateEngine, BudgetTracker } from '../state.js';
import type { DeepResearchLlmClient } from '../llm/chat.js';
import type { DeepResearchConfig } from '../../config.js';
import type { ResearchResult, ResearchDepth } from '../types.js';
import type { ExtractedEntities } from '../entityExtractor.js';
import type { DomainRoute } from '../domainRouter.js';

// ── Progress callback (shared with orchestrator) ──────────────────────────

export type ProgressCallback = (
  progress: number,
  message?: string,
  phase?: string,
  partials?: {
    sourceCount?: number;
    findingCount?: number;
    subQuestionCount?: number;
    classification?: string;
  },
) => void | Promise<void>;

// ── StrategyContext ───────────────────────────────────────────────────────

export interface StrategyContext {
  state: ResearchStateEngine;
  budget: BudgetTracker;
  llm?: DeepResearchLlmClient | undefined;
  config: Required<DeepResearchConfig>;
  abortSignal?: AbortSignal | undefined;
  onProgress?: ProgressCallback | undefined;
  depth: ResearchDepth;
  jobId?: string | undefined;
  deterministic?: boolean;
  /** Extracted entities from the query, if available. */
  entities?: ExtractedEntities | undefined;
  /** Domain route classification, if available. */
  route?: DomainRoute | undefined;
}

// ── ResearchStrategy ──────────────────────────────────────────────────────

export interface ResearchStrategy {
  readonly name: string;
  readonly description: string;
  readonly requiresLlm: boolean;
  analyze(query: string, ctx: StrategyContext): Promise<ResearchResult>;
  close?(): Promise<void>;
}

// ── StrategyFactory ───────────────────────────────────────────────────────

export type StrategyFactory = (ctx: StrategyContext) => ResearchStrategy;
