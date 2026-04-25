import type { SemanticCrawlSource } from '../types.js';
import type { AdapterType } from './types.js';

export * from '../utils/corpusCache.js';

export interface CacheSourceDescriptor {
  adapter: AdapterType;
  source: SemanticCrawlSource | Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function buildSourceKey(descriptor: CacheSourceDescriptor): string {
  return stableStringify(descriptor);
}
