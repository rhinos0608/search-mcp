/**
 * RAG-Anything Client
 *
 * TypeScript client for communicating with the RAG-Anything Bridge Service.
 * Provides typed interfaces for document extraction and content processing.
 */

import { logger } from '../logger.js';
import { loadConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface RAGAExtractionRequest {
  /** URL to extract content from */
  url: string;
  /** Content type hint (pdf, html, etc.) */
  contentType?: string;
  /** Parser to use */
  parser?: 'auto' | 'docling' | 'paddleocr' | 'mineru';
  /** Extract and structure tables */
  extractTables?: boolean;
  /** Extract image captions/descriptions */
  extractImages?: boolean;
  /** Extract and parse equations */
  extractEquations?: boolean;
  /** OCR language code */
  ocrLanguage?: string;
  /** Maximum pages to process */
  maxPages?: number;
  /** Synchronous timeout in seconds */
  syncTimeout?: number;
}

export interface RAGAContentItem {
  /** Unique item identifier */
  itemId: string;
  /** Content type */
  type: 'text' | 'image' | 'table' | 'equation' | 'heading' | 'list' | 'generic';
  /** Plain text content */
  text?: string;
  /** Markdown representation */
  markdown?: string;
  /** Page number in source document */
  pageNumber?: number;
  /** Section heading context */
  sectionHeading?: string;
  /** Caption or description */
  caption?: string;
  /** Reference to extracted asset */
  assetRef?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface RAGAAsset {
  /** Unique asset identifier */
  assetId: string;
  /** Asset type */
  type: 'image' | 'table' | 'equation' | 'chart';
  /** MIME type */
  mimeType?: string;
  /** Source URL */
  sourceUrl?: string;
  /** Caption or description */
  caption?: string;
  /** Alt text for accessibility */
  altText?: string;
  /** Page number in source */
  pageNumber?: number;
  /** Bounding box coordinates */
  boundingBox?: { x: number; y: number; width: number; height: number };
  /** Storage path or reference */
  storagePath?: string;
}

export interface RAGAExtractionResult {
  /** Document identifier (content hash) */
  documentId: string;
  /** Source URL */
  sourceUrl: string;
  /** Source content type */
  sourceType: string;
  /** Parser used */
  parserUsed: string;
  /** Parser version */
  parserVersion?: string;
  /** Extraction configuration */
  extractionConfig: Record<string, unknown>;
  /** Full document markdown */
  markdown: string;
  /** Document title */
  title?: string;
  /** Document description */
  description?: string;
  /** Structured content items */
  contentItems: RAGAContentItem[];
  /** Extracted assets */
  assets: RAGAAsset[];
  /** Page count */
  pageCount?: number;
  /** Word count */
  wordCount?: number;
  /** Detected language */
  language?: string;
  /** Citations and references */
  citations: Record<string, unknown>[];
  /** Warning messages */
  warnings: string[];
  /** Error messages */
  errors: string[];
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Whether result was served from cache */
  cached: boolean;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Cache expiration timestamp */
  expiresAt?: string;
}

// ============================================================================
// Async Job Types
// ============================================================================

export interface RAGAJobStatus {
  documentId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_found' | 'expired';
  progress?: number | null;
  message?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  result?: RAGAExtractionResult | null;
}

export interface RAGABridgeConfig {
  /** Bridge service base URL */
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Enable result caching */
  cacheEnabled: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

function resolveDefaultBaseUrl(): string {
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

const DEFAULT_CONFIG: RAGABridgeConfig = {
  baseUrl: resolveDefaultBaseUrl(),
  timeoutMs: 180000,
  maxRetries: 2,
  cacheEnabled: true,
};

// ============================================================================
// Cache Implementation
// ============================================================================

const MAX_CACHE_ENTRIES = 256;

interface CacheEntry {
  result: RAGAExtractionResult;
  expiresAt: number;
  lastAccessed: number;
}

const extractionCache = new Map<string, CacheEntry>();

/** Recursively sort object keys for stable serialization. */
function normalizeSource<T>(value: T): T | Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as unknown[]).map(normalizeSource);
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = normalizeSource(record[key]);
  }
  return out;
}

/** Deterministic JSON.stringify that preserves key order. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',') + '}'
  );
}

function generateCacheKey(request: RAGAExtractionRequest): string {
  const keyData = {
    url: request.url,
    contentType: request.contentType,
    parser: request.parser,
    extractTables: request.extractTables,
    extractImages: request.extractImages,
    extractEquations: request.extractEquations,
    maxPages: request.maxPages,
    ocrLanguage: request.ocrLanguage,
  };
  return Buffer.from(stableStringify(normalizeSource(keyData))).toString('base64');
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() < entry.expiresAt;
}

function pruneCache(): void {
  if (extractionCache.size <= MAX_CACHE_ENTRIES) return;

  for (const [key, entry] of extractionCache) {
    if (!isCacheValid(entry)) {
      extractionCache.delete(key);
    }
  }

  if (extractionCache.size <= MAX_CACHE_ENTRIES) return;

  const sorted = [...extractionCache.entries()].sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed,
  );
  const toRemove = sorted.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    const entry = sorted[i];
    if (entry !== undefined) {
      extractionCache.delete(entry[0]);
    }
  }
}

// ============================================================================
// Client Implementation
// ============================================================================

export class RAGAnythingClient {
  private config: RAGABridgeConfig;

  constructor(config: Partial<RAGABridgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async health(): Promise<{ status: string; version: string }> {
    const response = await fetch(`${this.config.baseUrl}/health`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return response.json() as Promise<{ status: string; version: string }>;
  }

  async extract(request: RAGAExtractionRequest): Promise<RAGAExtractionResult> {
    // Check cache first
    if (this.config.cacheEnabled) {
      const cacheKey = generateCacheKey(request);
      const cached = extractionCache.get(cacheKey);

      if (cached && isCacheValid(cached)) {
        cached.lastAccessed = Date.now();
        logger.debug({ url: request.url }, 'RAG-Anything cache hit');
        const result = cached.result;
        return { ...result, cached: true };
      }
    }

    const effectiveTimeoutMs = request.syncTimeout
      ? request.syncTimeout * 1000
      : this.config.timeoutMs;

    // Make extraction request with retries
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/extract`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: request.url,
            content_type: request.contentType,
            parser: request.parser,
            extract_tables: request.extractTables,
            extract_images: request.extractImages,
            extract_equations: request.extractEquations,
            ocr_language: request.ocrLanguage,
            max_pages: request.maxPages,
            sync_timeout: Math.floor(effectiveTimeoutMs / 1000),
          }),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Extraction failed: ${errorText}`);
        }

        const result: RAGAExtractionResult = (await response.json()) as RAGAExtractionResult;

        // Cache result
        if (this.config.cacheEnabled) {
          const cacheKey = generateCacheKey(request);
          extractionCache.set(cacheKey, {
            result,
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
            lastAccessed: Date.now(),
          });
          pruneCache();
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(
            {
              url: request.url,
              attempt: attempt + 1,
              error: lastError.message,
            },
            `RAG-Anything request failed, retrying in ${String(delay)}ms`,
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Extraction failed after all retries');
  }

  async getStatus(documentId: string): Promise<RAGAJobStatus> {
    const response = await fetch(`${this.config.baseUrl}/extract/${documentId}/status`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.statusText}`);
    }

    return response.json() as Promise<RAGAJobStatus>;
  }

  async getResult(documentId: string): Promise<RAGAExtractionResult> {
    const response = await fetch(`${this.config.baseUrl}/extract/${documentId}/result`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Result retrieval failed: ${response.statusText}`);
    }

    return response.json() as Promise<RAGAExtractionResult>;
  }

  async submitExtract(request: RAGAExtractionRequest): Promise<RAGAJobStatus> {
    const response = await fetch(`${this.config.baseUrl}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: request.url,
        content_type: request.contentType,
        parser: request.parser,
        extract_tables: request.extractTables,
        extract_images: request.extractImages,
        extract_equations: request.extractEquations,
        ocr_language: request.ocrLanguage,
        max_pages: request.maxPages,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Extraction submission failed: ${errorText}`);
    }

    const raw = (await response.json()) as Record<string, unknown>;

    // Normalize snake_case API response to camelCase TS interface
    return {
      documentId: (raw.document_id ?? raw.documentId) as string,
      status: raw.status as RAGAJobStatus['status'],
      progress: raw.progress != null ? Number(raw.progress) : null,
      message: (raw.message ?? null) as string | null,
      createdAt: (raw.created_at ?? raw.createdAt) as string,
      updatedAt: (raw.updated_at ?? raw.updatedAt) as string,
      completedAt: (raw.completed_at ?? raw.completedAt ?? null) as string | null,
      result: raw.result as RAGAExtractionResult | null,
    };
  }

  async pollExtract(
    documentId: string,
    onProgress?: (progress: number, message: string) => void,
    pollIntervalMs = 2000,
  ): Promise<RAGAJobStatus> {
    for (;;) {
      const status = await this.getStatus(documentId);

      if (status.progress != null && onProgress) {
        onProgress(status.progress, status.message ?? '');
      }

      if (status.status === 'completed') {
        return status;
      }

      if (status.status === 'failed') {
        throw new Error(`Extraction failed: ${status.message ?? 'Unknown error'}`);
      }

      if (status.status === 'not_found' || status.status === 'expired') {
        throw new Error(`Extraction job ${status.status}: ${status.message ?? ''}`);
      }

      // Still pending/processing — wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async extractAsync(
    request: RAGAExtractionRequest,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<RAGAExtractionResult> {
    // Check local cache first
    if (this.config.cacheEnabled) {
      const cacheKey = generateCacheKey(request);
      const cached = extractionCache.get(cacheKey);
      if (cached && isCacheValid(cached)) {
        cached.lastAccessed = Date.now();
        logger.debug({ url: request.url }, 'RAGA cache hit (extractAsync)');
        return { ...cached.result, cached: true };
      }
    }

    // Submit and poll
    const jobStatus = await this.submitExtract(request);

    // If already completed (cache hit on bridge), return immediately
    if (jobStatus.status === 'completed' && jobStatus.result) {
      const result = jobStatus.result;
      if (this.config.cacheEnabled) {
        const cacheKey = generateCacheKey(request);
        extractionCache.set(cacheKey, {
          result,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          lastAccessed: Date.now(),
        });
        pruneCache();
      }
      return result;
    }

    // Poll until completed
    const finalStatus = await this.pollExtract(jobStatus.documentId, onProgress);

    // Fetch full result
    const result = finalStatus.result ?? (await this.getResult(jobStatus.documentId));

    // Cache result
    if (this.config.cacheEnabled) {
      const cacheKey = generateCacheKey(request);
      extractionCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        lastAccessed: Date.now(),
      });
      pruneCache();
    }

    return result;
  }
}

// Export singleton instance
export const ragaClient = new RAGAnythingClient();

export async function extractWithRAGA(
  url: string,
  options: Omit<RAGAExtractionRequest, 'url'> = {},
  onProgress?: (progress: number, message: string) => void,
): Promise<RAGAExtractionResult> {
  return ragaClient.extractAsync({ url, ...options }, onProgress);
}
