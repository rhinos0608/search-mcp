/**
 * V5.0.0 ClaimCache — content-hash-based claim extraction cache.
 *
 * Research queries have heavy long-tail overlap on canonical sources
 * (papers, Wikipedia, common news). Caching extracted claims by content
 * hash saves LLM calls and latency on repeated or similar queries.
 *
 * Design:
 * - Keyed by SHA-256 hash of (source URL + content prefix).
 * - Stores structured claims + extraction timestamp.
 * - TTL: 24 hours (configurable).
 * - In-memory, no disk persistence (process-wide singleton shared by all ExtractionEngine instances in this process).
 * - Thread-safe via Map (single-threaded Node.js event loop).
 */

import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { StructuredClaimResult } from './llm/schemas.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedClaims {
  /** Hash key. */
  contentHash: string;
  /** Source URL. */
  sourceUrl: string;
  /** Extracted claims. */
  claims: StructuredClaimResult[];
  /** When extraction happened. */
  extractedAt: number;
  /** Number of times this cache entry was hit. */
  hitCount: number;
}

export interface ClaimCacheConfig {
  /** TTL in milliseconds. Default: 24 hours. */
  ttlMs?: number;
  /** Max entries before eviction. Default: 500. */
  maxEntries?: number;
}

// ── Content hashing ──────────────────────────────────────────────────────────

/**
 * Build a content-aware hash for a source.
 * Uses URL + first 2KB of content to detect near-duplicates.
 */
export function hashSourceContent(url: string, content: string): string {
  const contentPrefix = content.slice(0, 2048);
  const input = `${url}::${contentPrefix}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ── Cache ─────────────────────────────────────────────────────────────────────

export class ClaimCache {
  private cache = new Map<string, CachedClaims>();
  private config: Required<ClaimCacheConfig>;

  constructor(config?: ClaimCacheConfig) {
    this.config = {
      ttlMs: config?.ttlMs ?? 24 * 60 * 60 * 1000, // 24 hours
      maxEntries: config?.maxEntries ?? 500,
    };
  }

  /**
   * Look up cached claims for a source.
   * Returns undefined if not found or expired.
   */
  get(url: string, content: string): CachedClaims | undefined {
    const hash = hashSourceContent(url, content);
    const entry = this.cache.get(hash);

    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.extractedAt > this.config.ttlMs) {
      this.cache.delete(hash);
      logger.debug({ url, hash }, 'Cache entry expired');
      return undefined;
    }

    entry.hitCount++;
    logger.info(
      { url, hash, hitCount: entry.hitCount, claims: entry.claims.length },
      'Claim cache hit',
    );
    return entry;
  }

  /**
   * Store claims for a source.
   */
  set(url: string, content: string, claims: StructuredClaimResult[]): void {
    const hash = hashSourceContent(url, content);

    // Evict oldest inserted entry (FIFO) if at capacity.
    if (!this.cache.has(hash) && this.cache.size >= this.config.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        logger.debug('Evicted oldest FIFO cache entry');
      }
    }

    this.cache.set(hash, {
      contentHash: hash,
      sourceUrl: url,
      claims,
      extractedAt: Date.now(),
      hitCount: 0,
    });

    logger.debug({ url, hash, claims: claims.length }, 'Cached claims');
  }

  /**
   * Get cache statistics.
   */
  stats(): { entries: number; totalHits: number; totalClaims: number } {
    let totalHits = 0;
    let totalClaims = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hitCount;
      totalClaims += entry.claims.length;
    }
    return {
      entries: this.cache.size,
      totalHits,
      totalClaims,
    };
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove expired entries. Call periodically.
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.extractedAt > this.config.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'Pruned expired cache entries');
    }
    return removed;
  }
}

/** Create an isolated claim cache instance. */
export function createClaimCache(config?: ClaimCacheConfig): ClaimCache {
  return new ClaimCache(config);
}

/** Singleton cache instance shared across all ExtractionEngine instances in this process. */
export const claimCache = createClaimCache();
