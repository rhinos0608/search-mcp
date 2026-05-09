/**
 * Smart Extraction Module
 *
 * Integrates quality detection with RAG-Anything escalation.
 * This module provides the glue between:
 * - Crawl4AI/readability extraction (webRead)
 * - Quality detection (extractionQuality)
 * - RAG-Anything bridge (ragAnythingClient)
 */

import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { webRead } from '../tools/webRead.js';
import type { ArticleResult } from '../types.js';
import { RAGAnythingClient, type RAGAExtractionResult } from './ragAnythingClient.js';

// Quality-related types (simplified for this module)
interface QualityConfig {
  minTextLength?: number;
  minContentRatio?: number;
  minStructuralScore?: number;
  penalizeNavTerms?: boolean;
}

interface QualityCheck {
  score: number;
  passed: boolean;
  details: {
    textLength: number;
    contentRatio: number;
    structuralScore: number;
    extractionTimeMs?: number;
  };
  warnings: string[];
  contentType?: string;
}

// ============================================================================
// Configuration
// ============================================================================

export interface SmartExtractionConfig {
  /** Enable RAG-Anything escalation */
  ragaEnabled: boolean;
  /** RAG-Anything bridge URL */
  ragaBaseUrl: string;
  /** Quality check thresholds */
  qualityConfig: Partial<QualityConfig>;
  /** Minimum quality score to pass without escalation (0-100) */
  minQualityScore: number;
  /** Whether to always use RAG-Anything for document types */
  autoEscalateDocuments: boolean;
}

function resolveRagaBaseUrl(): string {
  const envUrl = process.env.RAGA_BRIDGE_URL;
  if (envUrl) return envUrl;
  try {
    const cfg = loadConfig();
    if (cfg.raga.baseUrl) return cfg.raga.baseUrl;
  } catch {
    // Config system not available yet
  }
  return 'http://localhost:8000';
}

const DEFAULT_CONFIG: SmartExtractionConfig = {
  ragaEnabled: process.env.RAGA_ENABLED === 'true',
  ragaBaseUrl: resolveRagaBaseUrl(),
  qualityConfig: {},
  minQualityScore: 60,
  autoEscalateDocuments: true,
};

// ============================================================================
// Result Types
// ============================================================================

export interface SmartExtractionResult {
  /** The extracted content */
  content: ArticleResult | RAGAExtractionResult;
  /** Which extraction method was used */
  method: 'readability' | 'raga' | 'fallback';
  /** Quality check results (if performed) */
  qualityCheck?: QualityCheck | undefined;
  /** Whether RAG-Anything escalation was used */
  ragaEscalated: boolean;
  /** Timing information */
  timing: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
}

// ============================================================================
// Client
// ============================================================================

export class SmartExtractionClient {
  private config: SmartExtractionConfig;
  private ragaClient: RAGAnythingClient | null = null;

  constructor(config: Partial<SmartExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.ragaEnabled) {
      this.ragaClient = new RAGAnythingClient({
        baseUrl: this.config.ragaBaseUrl,
      });
    }
  }

  /**
   * Perform smart extraction with automatic quality detection and RAG-Anything escalation
   */
  async extract(url: string): Promise<SmartExtractionResult> {
    const startedAt = Date.now();
    logger.debug({ url }, 'Starting smart extraction');

    try {
      // Step 1: Try standard webRead extraction
      const webResult = await webRead(url);

      // Step 2: Check extraction quality (simplified estimation)
      const textLength = webResult.textContent.length;
      const hasTitle = !!webResult.title?.trim();
      const qualityScore = Math.min(
        100,
        Math.max(
          0,
          (textLength > 500 ? 40 : textLength / 12.5) +
            (hasTitle ? 30 : 0) +
            (webResult.extractionMethod === 'readability' ? 30 : 10),
        ),
      );

      const qualityCheck: QualityCheck = {
        score: qualityScore,
        passed: qualityScore >= this.config.minQualityScore,
        details: {
          textLength,
          contentRatio: textLength / (webResult.content.length || 1),
          structuralScore: webResult.extractionMethod === 'readability' ? 0.8 : 0.5,
        },
        warnings:
          qualityScore < this.config.minQualityScore ? ['Low quality extraction detected'] : [],
      };

      logger.debug(
        { url, score: qualityCheck.score, passed: qualityCheck.passed },
        'Quality check completed',
      );

      // Step 3: Determine if we should escalate to RAG-Anything
      if (
        this.config.ragaEnabled &&
        this.ragaClient !== null &&
        qualityCheck.score < this.config.minQualityScore
      ) {
        logger.info({ url, qualityScore: qualityCheck.score }, 'Escalating to RAG-Anything');

        const ragaResult = await this.ragaClient.extract({
          url,
          parser: 'auto',
          extractTables: true,
          extractImages: false,
          extractEquations: true,
        });

        const completedAt = Date.now();
        return {
          content: ragaResult,
          method: 'raga',
          qualityCheck,
          ragaEscalated: true,
          timing: {
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
          },
        };
      }

      // Step 4: Return webRead result if quality is acceptable
      const completedAt = Date.now();
      return {
        content: webResult,
        method: webResult.extractionMethod === 'readability' ? 'readability' : 'fallback',
        qualityCheck,
        ragaEscalated: false,
        timing: {
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
        },
      };
    } catch (error) {
      // Step 5: On error, try RAG-Anything as fallback if enabled
      if (this.config.ragaEnabled && this.ragaClient !== null) {
        logger.warn({ url, error: String(error) }, 'webRead failed, trying RAG-Anything fallback');

        try {
          const ragaResult = await this.ragaClient.extract({
            url,
            parser: 'auto',
            extractTables: true,
            extractImages: false,
            extractEquations: true,
          });

          const completedAt = Date.now();
          return {
            content: ragaResult,
            method: 'raga',
            ragaEscalated: true,
            timing: {
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
            },
          };
        } catch (ragaError) {
          logger.error({ url, error: String(ragaError) }, 'RAG-Anything fallback also failed');
          // Re-throw the original error
          throw error;
        }
      }

      throw error;
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

let defaultClient: SmartExtractionClient | null = null;

/**
 * Get or create the default smart extraction client
 */
function getDefaultClient(): SmartExtractionClient {
  defaultClient ??= new SmartExtractionClient();
  return defaultClient;
}

/**
 * Smart extraction with automatic quality detection and RAG-Anything escalation
 *
 * This is the main entry point for smart extraction. It will:
 * 1. Try standard webRead extraction
 * 2. Check extraction quality
 * 3. Escalate to RAG-Anything if quality is poor or content type requires it
 * 4. Return the best result
 *
 * @param url - URL to extract content from
 * @returns Smart extraction result with metadata about the extraction process
 */
export async function smartExtract(url: string): Promise<SmartExtractionResult> {
  return getDefaultClient().extract(url);
}

/**
 * Check if RAG-Anything integration is enabled
 */
export function isRAGAEnabled(): boolean {
  return process.env.RAGA_ENABLED === 'true';
}

/**
 * Reset the default client (useful for testing)
 */
export function resetSmartExtractionClient(): void {
  defaultClient = null;
}
