/**
 * RAG-Anything Client
 *
 * TypeScript client for communicating with the RAG-Anything Bridge Service.
 * Provides typed interfaces for document extraction and content processing.
 */

import { logger } from "../logger.js";
import { env } from "../config.js";

// ============================================================================
// Types
// ============================================================================

export interface RAGAExtractionRequest {
	/** URL to extract content from */
	url: string;
	/** Content type hint (pdf, html, etc.) */
	contentType?: string;
	/** Parser to use */
	parser?: "auto" | "docling" | "paddleocr" | "mineru";
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
	type:
		| "text"
		| "image"
		| "table"
		| "equation"
		| "heading"
		| "list"
		| "generic";
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
	type: "image" | "table" | "equation" | "chart";
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
	citations: Array<Record<string, unknown>>;
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
	baseUrl: env.RAGA_BRIDGE_URL || "http://localhost:8000",
	timeoutMs: 30000,
	maxRetries: 2,
	cacheEnabled: true,
};

// ============================================================================
// Cache Implementation
// ============================================================================

// Simple in-memory cache with TTL
interface CacheEntry {
	result: RAGAExtractionResult;
	expiresAt: number;
}

const extractionCache = new Map<string, CacheEntry>();

function generateCacheKey(request: RAGAExtractionRequest): string {
	const keyData = {
		url: request.url,
		contentType: request.contentType,
		parser: request.parser,
		extractTables: request.extractTables,
		extractImages: request.extractImages,
		extractEquations: request.extractEquations,
		maxPages: request.maxPages,
	};
	return Buffer.from(JSON.stringify(keyData)).toString("base64");
}

function isCacheValid(entry: CacheEntry): boolean {
	return Date.now() < entry.expiresAt;
}

// ============================================================================
// Client Implementation
// ============================================================================

export class RAGAnythingClient {
	private config: RAGABridgeConfig;

	constructor(config: Partial<RAGABridgeConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Check bridge health
	 */
	async health(): Promise<{ status: string; version: string }> {
		const response = await fetch(`${this.config.baseUrl}/health`, {
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		if (!response.ok) {
			throw new Error(`Health check failed: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Extract content from URL using RAG-Anything
	 */
	async extract(request: RAGAExtractionRequest): Promise<RAGAExtractionResult> {
		// Check cache first
		if (this.config.cacheEnabled) {
			const cacheKey = generateCacheKey(request);
			const cached = extractionCache.get(cacheKey);

			if (cached && isCacheValid(cached)) {
				logger.debug({ url: request.url }, "RAG-Anything cache hit");
				return { ...cached.result, cached: true };
			}
		}

		// Make extraction request with retries
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
			try {
				const response = await fetch(`${this.config.baseUrl}/extract`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
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
						sync_timeout: Math.floor(this.config.timeoutMs / 1000),
					}),
					signal: AbortSignal.timeout(this.config.timeoutMs),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Extraction failed: ${errorText}`);
				}

				const result: RAGAExtractionResult = await response.json();

				// Cache result
				if (this.config.cacheEnabled) {
					const cacheKey = generateCacheKey(request);
					extractionCache.set(cacheKey, {
						result,
						expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
					});
				}

				return result;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (attempt < this.config.maxRetries) {
					const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
					logger.warn(
						{
							url: request.url,
							attempt: attempt + 1,
							error: lastError.message,
						},
						`RAG-Anything request failed, retrying in ${delay}ms`,
					);

					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw lastError || new Error("Extraction failed after all retries");
	}

	/**
	 * Get extraction status for async jobs
	 */
	async getStatus(
		documentId: string,
	): Promise<{ status: string; progress?: number }> {
		const response = await fetch(
			`${this.config.baseUrl}/extract/${documentId}/status`,
			{ signal: AbortSignal.timeout(this.config.timeoutMs) },
		);

		if (!response.ok) {
			throw new Error(`Status check failed: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Get extraction result
	 */
	async getResult(documentId: string): Promise<RAGAExtractionResult> {
		const response = await fetch(
			`${this.config.baseUrl}/extract/${documentId}/result`,
			{ signal: AbortSignal.timeout(this.config.timeoutMs) },
		);

		if (!response.ok) {
			throw new Error(`Result retrieval failed: ${response.statusText}`);
		}

		return response.json();
	}
}

// Export singleton instance
export const ragaClient = new RAGAnythingClient();

/**
 * Convenience function for simple extractions
 */
export async function extractWithRAGA(
	url: string,
	options: Omit<RAGAExtractionRequest, "url"> = {},
): Promise<RAGAExtractionResult> {
	return ragaClient.extract({ url, ...options });
}
