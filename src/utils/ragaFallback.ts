/**
 * RAG-Anything fallback extraction for document URLs.
 *
 * Provides a shared implementation for extracting content from PDFs,
 * Office documents, and other non-HTML formats via the RAG-Anything bridge.
 */

import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TRUNCATED_MARKER } from '../httpGuards.js';
import { logger } from '../logger.js';
import type { LlmConfig } from '../config.js';
import type { ExtractionConfig } from './extractionConfig.js';

/** Maximum size for RAGA extraction results before truncation (500KB). */
export const MAX_RAGA_MARKDOWN_BYTES = 500_000;

export interface RagaFallbackConfig {
  baseUrl: string;
  timeoutMs: number;
}

export interface RagaFallbackResult {
  markdown: string;
  warnings: string[];
}

/**
 * If url is a document URL and RAGA is configured, extract via RAGA.
 * Returns null if RAGA is not configured or the URL is not a document.
 */
export async function tryRagaFallback(
  url: string,
  raga: RagaFallbackConfig,
  extra?: Record<string, unknown>,
): Promise<RagaFallbackResult | null> {
  const { isDocumentUrl } = await import('./documentUtils.js');

  if (!isDocumentUrl(url)) {
    return null;
  }

  if (!raga.baseUrl) {
    return null;
  }

  const startTime = Date.now();

  const sendProgress = async (progress: number, message: string) => {
    try {
      const e = extra as
        | {
            _meta?: { progressToken?: string | number };
            sendNotification?: (n: {
              method: string;
              params: Record<string, unknown>;
            }) => Promise<void>;
          }
        | undefined;
      if (!e?.sendNotification || !e._meta?.progressToken) return;
      await e.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: e._meta.progressToken, progress, total: 100, message },
      });
    } catch (err) {
      logger.trace({ err }, 'non-fatal: failed to send progress notification');
    }
  };

  await sendProgress(5, 'Submitting extraction job');

  const { RAGAnythingClient } = await import('./ragAnythingClient.js');
  const client = new RAGAnythingClient({ baseUrl: raga.baseUrl, timeoutMs: raga.timeoutMs });

  // Use async extraction with progress polling.
  // The onProgress callback fires on each status poll, keeping the
  // MCP connection alive via notifications/progress.
  const result = await client.extractAsync(
    {
      url,
      parser: 'auto',
      extractTables: true,
      extractImages: false,
      extractEquations: true,
    },
    (progress: number, message: string) => {
      // Bridge progress is 0-100; pipe through to MCP progress notifications.
      // Fire-and-forget — progress visibility is best-effort.
      sendProgress(Math.round(progress), message).catch((err: unknown) => {
        logger.trace({ err }, 'non-fatal: failed to send progress notification from bridge');
      });
    },
  );

  await sendProgress(70, 'Processing extracted content');
  await sendProgress(90, 'Building result');

  const elapsed = Date.now() - startTime;
  logger.info(
    {
      tool: 'extractWithRAGA',
      url,
      timeoutMs: raga.timeoutMs,
      elapsedMs: elapsed,
      markdownLen: result.markdown.length,
    },
    'RAGA extraction completed',
  );

  await sendProgress(100, 'Extraction complete');

  if (!result.markdown) {
    return { markdown: '', warnings: ['Extraction returned no content'] };
  }

  const warnings: string[] = [];
  let markdown = result.markdown;

  if (markdown.length > MAX_RAGA_MARKDOWN_BYTES) {
    const hash = createHash('sha256').update(markdown).digest('hex');
    const tmpDir = path.join(os.tmpdir(), 'raga-extracts');
    const filePath = path.join(tmpDir, `${hash}.md`);

    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(filePath, markdown);
      logger.info({ filePath }, 'Full RAGA extraction saved to temp file');
    } catch (err) {
      logger.warn({ err, filePath }, 'Failed to save full RAGA extraction to temp file');
    }

    markdown = markdown.slice(0, MAX_RAGA_MARKDOWN_BYTES) + TRUNCATED_MARKER;
    warnings.push(
      `Result was truncated to ${String(MAX_RAGA_MARKDOWN_BYTES / 1024)}KB. Full content saved to ${filePath}`,
    );
  }

  return { markdown, warnings };
}

/**
 * Map LLM config to the shape expected by extractionConfig validator.
 */
export function normalizeLlmForValidation(llm: LlmConfig): {
  provider: string;
  apiToken: string;
  baseUrl?: string;
} {
  return {
    provider: llm.provider,
    apiToken: llm.apiToken ?? '',
    ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
  };
}

/**
 * Build llmFallback config for Crawl4AI extraction when LLM strategy is used.
 */
export function buildLlmFallback(
  extractionConfig: ExtractionConfig | undefined,
  llm: LlmConfig,
): { provider: string; apiToken: string; baseUrl?: string } | undefined {
  if (extractionConfig?.type !== 'llm') return undefined;
  return {
    provider: extractionConfig.llmProvider ?? llm.provider,
    apiToken: llm.apiToken ?? '',
    ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
  };
}
