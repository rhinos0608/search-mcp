const BYTES_PER_MB = 1_000_000;

/**
 * Shared default corpus budget for semantic tools.
 *
 * Semantic clients often cap raw payloads at 1–5MB, but these tools rely on
 * embedding-based retrieval and can safely budget much larger source corpora.
 */
export const DEFAULT_SEMANTIC_MAX_BYTES = 250_000_000;

export interface SemanticByteBudgetResult<T> {
  items: T[];
  truncated: boolean;
  bytesUsed: number;
  droppedCount: number;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function formatSemanticBytes(bytes: number): string {
  const mb = bytes / BYTES_PER_MB;
  return Number.isInteger(mb) ? `${String(mb)}MB` : `${mb.toFixed(1)}MB`;
}

/**
 * Keep items within a cumulative UTF-8 byte budget.
 * Items are preserved in order until adding the next one would exceed the budget.
 */
export function applySemanticByteBudget<T extends { text: string }>(
  items: T[],
  maxBytes: number,
): SemanticByteBudgetResult<T> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      items: [],
      truncated: items.length > 0,
      bytesUsed: 0,
      droppedCount: items.length,
    };
  }

  const kept: T[] = [];
  let bytesUsed = 0;

  for (const item of items) {
    const itemBytes = utf8ByteLength(item.text);
    if (bytesUsed + itemBytes > maxBytes) {
      return {
        items: kept,
        truncated: true,
        bytesUsed,
        droppedCount: items.length - kept.length,
      };
    }

    kept.push(item);
    bytesUsed += itemBytes;
  }

  return {
    items: kept,
    truncated: false,
    bytesUsed,
    droppedCount: 0,
  };
}
