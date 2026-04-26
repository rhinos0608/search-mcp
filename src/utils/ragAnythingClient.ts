/**
 * RAG-Anything Client
 *
 * TypeScript client for communicating with the RAG-Anything Bridge Service.
 * Provides typed interfaces for document extraction and content processing.
 */

import { logger } from '../logger.js';

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

const DEFAULT_CONFIG: RAGABridgeConfig = {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  baseUrl: process.env.RAGA_BRIDGE_URL || 'http://localhost:8000',
  timeoutMs: 30000,
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
  if (Array.isArray(value))
    return value.map(normalizeSource) as unknown as T | Record<string, unknown> | unknown[];
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

  async getStatus(documentId: string): Promise<{ status: string; progress?: number }> {
    const response = await fetch(`${this.config.baseUrl}/extract/${documentId}/status`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.statusText}`);
    }

    return response.json() as Promise<{ status: string; progress?: number }>;
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
}

// Export singleton instance
export const ragaClient = new RAGAnythingClient();

export async function extractWithRAGA(
  url: string,
  options: Omit<RAGAExtractionRequest, 'url'> = {},
): Promise<RAGAExtractionResult> {
  return ragaClient.extract({ url, ...options });
}
