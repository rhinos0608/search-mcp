/**
 * Generic in-memory LRU cache with TTL expiration.
 *
 * Uses a Map for O(1) get/set and insertion-order-based LRU eviction.
 */

export interface CacheOptions {
  /** Maximum number of entries in the cache. */
  maxSize: number;
  /** Time-to-live in milliseconds for each entry. */
  ttlMs: number;
}

interface CacheEntry<T> {
  data: T;
  createdAt: number;
}

export class ToolCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: CacheOptions) {
    if (options.maxSize < 1) throw new Error('Cache maxSize must be >= 1');
    if (options.ttlMs < 1) throw new Error('Cache ttlMs must be >= 1');
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  /** Retrieve a cached value. Returns null if not found or expired. */
  get(key: string): T | null {
    const entry = this.map.get(key);
    if (entry === undefined) return null;

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return null;
    }

    // Move to end for LRU freshness
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.data;
  }

  /** Store a value in the cache. Evicts LRU entry if maxSize exceeded. */
  set(key: string, data: T): void {
    // Delete first so re-insertion moves to end
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Evict LRU if at capacity
    while (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }

    this.map.set(key, { data, createdAt: Date.now() });
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this.map.size;
  }
}

/** Join parts with ':' to form a cache key. */
export function cacheKey(...parts: string[]): string {
  return parts.join(':');
}
