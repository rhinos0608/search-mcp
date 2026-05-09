/**
 * ResearchOrchestrator — state machine with EVALUATE-DECIDE-ACT control loop.
 *
 * This orchestrator acts as a thin wrapper that manages the lifecycle of a research
 * task, delegating the actual investigation logic to pluggable strategies.
 */

import { logger } from '../logger.js';

import { ResearchStateEngine, BudgetTracker, resolveBudgetProfile } from './state.js';
import { DeepResearchLlmClient, type TokenBudget } from './llm/chat.js';
import { LanguageDetector } from './language.js';
import { strategyRegistry } from './strategies/index.js';
import type { ResearchStrategy, StrategyContext } from './strategies/types.js';
import type { ResearchDepth, ResearchResult } from './types.js';
import type { DeepResearchConfig } from '../config.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OrchestratorLlmConfig {
  baseUrl: string;
  workerBaseUrl?: string;
  model: string;
  workerModel: string;
  apiToken?: string;
}

/** Progress notification callback. Optional phase overrides derivePhase in the handler. */
export type ProgressCallback = (
  progress: number,
  message?: string,
  phase?: string,
  partials?: {
    sourceCount?: number;
    findingCount?: number;
    subQuestionCount?: number;
    sourceTypeCount?: number;
    gapLoopCount?: number;
    classification?: string;
  },
) => void | Promise<void>;

// ── Default config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<DeepResearchConfig> = {
  enabled: true,
  defaultDepth: 'standard',
  maxDepth: 'deep',
  maxToolCalls: 200,
  maxTokens: 500_000,
  maxTimeMs: 300_000,
  baseUrl: '',
  workerBaseUrl: '',
  model: '',
  workerModel: '',
  apiToken: '',
  treeBreadth: 4,
  treeDepth: 2,
  treeConcurrency: 2,
  treeContextWordLimit: 25000,
  agentMaxIterations: 30,
  agentMaxSubIterations: 8,
  agentDefaultFetchMode: 'summary_focus_query',
  autoSave: true,
};

function normalizeConfig(cfg?: Partial<DeepResearchConfig>): Required<DeepResearchConfig> {
  if (!cfg) return DEFAULT_CONFIG;
  return {
    enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
    defaultDepth: cfg.defaultDepth ?? DEFAULT_CONFIG.defaultDepth,
    maxDepth: cfg.maxDepth ?? DEFAULT_CONFIG.maxDepth,
    maxToolCalls: cfg.maxToolCalls ?? DEFAULT_CONFIG.maxToolCalls,
    maxTokens: cfg.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    maxTimeMs: cfg.maxTimeMs ?? DEFAULT_CONFIG.maxTimeMs,
    baseUrl: cfg.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    workerBaseUrl: cfg.workerBaseUrl ?? DEFAULT_CONFIG.workerBaseUrl,
    model: cfg.model ?? DEFAULT_CONFIG.model,
    workerModel: cfg.workerModel ?? DEFAULT_CONFIG.workerModel,
    apiToken: cfg.apiToken ?? DEFAULT_CONFIG.apiToken,
    treeBreadth: cfg.treeBreadth ?? DEFAULT_CONFIG.treeBreadth,
    treeDepth: cfg.treeDepth ?? DEFAULT_CONFIG.treeDepth,
    treeConcurrency: cfg.treeConcurrency ?? DEFAULT_CONFIG.treeConcurrency,
    treeContextWordLimit: cfg.treeContextWordLimit ?? DEFAULT_CONFIG.treeContextWordLimit,
    agentMaxIterations: cfg.agentMaxIterations ?? DEFAULT_CONFIG.agentMaxIterations,
    agentMaxSubIterations: cfg.agentMaxSubIterations ?? DEFAULT_CONFIG.agentMaxSubIterations,
    agentDefaultFetchMode: cfg.agentDefaultFetchMode ?? DEFAULT_CONFIG.agentDefaultFetchMode,
    autoSave: cfg.autoSave ?? DEFAULT_CONFIG.autoSave,
  };
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

export class ResearchOrchestrator {
  private state: ResearchStateEngine;
  private budget: BudgetTracker;
  private config: Required<DeepResearchConfig>;
  private llm: DeepResearchLlmClient | undefined;
  private abortSignal: AbortSignal | undefined;

  private onProgress: ProgressCallback = () => {
    // Default empty callback
  };

  private _currentStrategy: ResearchStrategy | null = null;
  private _currentStrategyName: string | null = null;

  /** The strategy name used for the current or most recent run. */
  get currentStrategy(): string | null {
    return this._currentStrategyName;
  }

  /** Release strategy resources. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this._currentStrategy?.close) {
      await this._currentStrategy.close();
    }
    this._currentStrategy = null;
    this._currentStrategyName = null;
  }
  private _jobId: string | undefined;

  constructor(config?: Partial<DeepResearchConfig>, llmConfig?: OrchestratorLlmConfig) {
    this.config = normalizeConfig(config);
    const depth = this.config.defaultDepth;
    const profile = resolveBudgetProfile(depth, {
      maxTimeMs: this.config.maxTimeMs,
    });
    this.budget = new BudgetTracker(profile);
    this.state = new ResearchStateEngine(this.budget);
    this.llm = this.createLlmClient(llmConfig);
  }

  /** Create LLM client when config is fully populated, else return undefined. */
  private createLlmClient(llmConfig?: OrchestratorLlmConfig): DeepResearchLlmClient | undefined {
    if (!llmConfig) return undefined;
    if (!llmConfig.baseUrl || !llmConfig.model) return undefined;

    const tokenBudget: TokenBudget = {
      recordTokens: (count: number) => {
        this.budget.recordTokens(count);
        return !this.budget.isExhausted();
      },
    };

    return new DeepResearchLlmClient(
      {
        baseUrl: llmConfig.baseUrl,
        ...(llmConfig.workerBaseUrl !== undefined
          ? { workerBaseUrl: llmConfig.workerBaseUrl }
          : {}),
        model: llmConfig.model,
        workerModel: llmConfig.workerModel,
        ...(llmConfig.apiToken !== undefined ? { apiToken: llmConfig.apiToken } : {}),
      },
      tokenBudget,
    );
  }

  /**
   * Public entry point. Sets up context and delegates to the selected strategy.
   * @param strategy - Optional override for strategy selection ('agent' | 'pipeline' | 'tree').
   */
  async run(
    query: string,
    depth?: ResearchDepth,
    maxTimeMs?: number,
    _abortSignal?: AbortSignal,
    onProgress?: ProgressCallback,
    jobId?: string,
    strategy?: string,
    deterministic?: boolean,
  ): Promise<ResearchResult> {
    const effectiveDepth = depth ?? this.config.defaultDepth;
    this._jobId = jobId;
    this.onProgress =
      onProgress ??
      (() => {
        /* no-op */
      });
    this.abortSignal = _abortSignal;

    // Build budget from effective depth and optional time override
    const maxTimeOverride =
      maxTimeMs && maxTimeMs < this.config.maxTimeMs ? { maxTimeMs } : undefined;
    const profile = resolveBudgetProfile(effectiveDepth, maxTimeOverride);
    this.budget = new BudgetTracker(profile);
    this.state.initialize(query, this.budget);

    // Language detection
    try {
      const langProfile = await LanguageDetector.detect(query, this.llm);
      this.state.setLanguage(langProfile);
    } catch {
      this.state.setLanguage({ code: 'en', style: 'formal' });
    }

    // Build strategy context
    const ctx: StrategyContext = {
      state: this.state,
      budget: this.budget,
      llm: this.llm,
      config: this.config,
      abortSignal: this.abortSignal,
      onProgress: this.onProgress,
      depth: effectiveDepth,
      jobId: this._jobId,
      deterministic: deterministic ?? false,
    };

    // Resolve strategy
    const isTreeMode = effectiveDepth === 'tree';
    let strategyName: string;
    if (isTreeMode) {
      strategyName = 'tree';
    } else if (deterministic) {
      strategyName = 'pipeline';
    } else if (strategy) {
      strategyName = strategy;
    } else {
      strategyName = strategyRegistry.selectDefault(ctx);
    }

    this._currentStrategyName = strategyName;
    logger.info(
      { query: query.slice(0, 80), strategy: strategyName, depth: effectiveDepth },
      'Research starting',
    );

    await this.reportProgress(0, `Starting deep research: ${query.slice(0, 80)}`, 'initializing');

    try {
      this._currentStrategy = strategyRegistry.create(strategyName, ctx);
      let result = await this._currentStrategy.analyze(query, ctx);

      // ── Agent → pipeline fallback when LLM was unusable ──────────────
      if (
        strategyName === 'agent' &&
        result.report.sourceCount === 0 &&
        result.report.findingCount === 0 &&
        strategyRegistry.has('pipeline')
      ) {
        logger.info(
          { originalStrategy: strategyName },
          'Agent produced no results (LLM failure), falling back to pipeline strategy',
        );
        await this._currentStrategy.close?.();
        this._currentStrategy = strategyRegistry.create('pipeline', ctx);
        this._currentStrategyName = 'pipeline';
        await this.reportProgress(
          10,
          'Falling back to deterministic pipeline (LLM unavailable)',
          'pipeline_fallback',
        );
        result = await this._currentStrategy.analyze(query, ctx);
      }

      return result;
    } catch (err) {
      logger.error({ err, strategy: this._currentStrategyName }, 'Strategy execution failed');
      throw err;
    } finally {
      if (this._currentStrategy?.close) {
        await this._currentStrategy.close();
      }
      this._currentStrategy = null;
    }
  }

  /**
   * Surface percentage + message + optional phase + optional bounded partials
   * via the onProgress callback. Clamped to 0-100.
   */
  private async reportProgress(
    progress: number,
    message?: string,
    phase?: string,
    partials?: {
      sourceCount?: number;
      findingCount?: number;
      subQuestionCount?: number;
      sourceTypeCount?: number;
      gapLoopCount?: number;
      classification?: string;
    },
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, progress));
    try {
      await this.onProgress(clamped, message, phase, partials);
    } catch {
      // Callback errors are non-fatal
    }
  }
}
