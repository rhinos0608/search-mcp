/**
 * Smart snippet extraction for search-mcp.
 *
 * Replaces first-N truncation with query-term-aware window extraction.
 * When query terms are found in the content, the snippet centers on
 * the region(s) where they appear, with configurable context padding.
 * Falls back to prefix + ellipsis when no terms match.
 */

export interface SnippetOptions {
  /** Maximum character length of the returned snippet. Default: 400. */
  maxChars?: number;
  /** Characters of context padding around each match position. Default: 100. */
  surroundChars?: number;
  /** Snap window boundaries to the nearest paragraph break. Default: true. */
  snapToParagraphs?: boolean;
}

/**
 * Extract a query-term-aware snippet from `content`.
 *
 * The algorithm finds all occurrences of query terms (words > 2 chars) in the
 * content, sorts them, merges overlapping windows, and returns the best
 * region(s) surrounding the matches.
 *
 * @param content - Full text to extract a snippet from.
 * @param query - User query whose terms drive the extraction window.
 * @param options - Optional configuration overrides.
 * @returns The extracted snippet, which may be shorter than `content`.
 */
export function extractSmartSnippet(
  content: string,
  query: string,
  options?: SnippetOptions,
): string {
  const maxChars = options?.maxChars ?? 400;
  const surroundChars = options?.surroundChars ?? 100;
  const snapToParagraphs = options?.snapToParagraphs ?? true;

  // Byte-size safety check — if content fits, return as-is
  if (Buffer.byteLength(content, 'utf8') <= maxChars) {
    return content;
  }

  if (!query || query.trim().length === 0) {
    return content.slice(0, maxChars) + '\n…';
  }

  // Find all positions where query terms match
  const positions: number[] = [];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const lower = content.toLowerCase();

  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lower.indexOf(term, idx + 1);
    }
  }

  // No matches at all — return prefix (existing truncation behaviour)
  if (positions.length === 0) {
    return content.slice(0, maxChars) + '\n…';
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);

  // positions is non-empty — we already returned above if length === 0
  const firstPos = positions[0];
  if (firstPos === undefined) {
    return content.slice(0, maxChars) + '\n…';
  }

  const windows: { start: number; end: number }[] = [];
  const pad = Math.max(1, Math.floor(surroundChars / 2));

  let currentStart = Math.max(0, firstPos - surroundChars);
  let currentEnd = Math.min(content.length, currentStart + maxChars);

  for (let i = 1; i < positions.length; i++) {
    const pos = positions[i];
    if (pos === undefined) continue;
    if (pos > currentEnd - pad) {
      // Position is too far from current window — start a new one
      windows.push({ start: currentStart, end: currentEnd });
      currentStart = Math.max(0, pos - surroundChars);
      currentEnd = Math.min(content.length, currentStart + maxChars);
    } else {
      // Extend current window to encompass this position
      currentEnd = Math.min(
        content.length,
        Math.max(currentEnd, pos + surroundChars),
      );
    }
  }
  windows.push({ start: currentStart, end: currentEnd });

  // Snap windows to paragraph boundaries
  if (snapToParagraphs) {
    for (const w of windows) {
      const prevBlank = content.lastIndexOf('\n\n', w.start);
      const nextBlank = content.indexOf('\n\n', w.end);
      if (prevBlank >= 0 && prevBlank > w.start - 200) {
        w.start = prevBlank + 2;
      }
      if (nextBlank >= 0 && nextBlank < w.end + 200) {
        w.end = nextBlank;
      }
    }
  }

  if (windows.length === 1) {
    const w = windows[0];
    if (w === undefined) {
      return content.slice(0, maxChars) + '\n…';
    }
    const prefix = w.start > 0 ? '…\n' : '';
    const suffix = w.end < content.length ? '\n…' : '';
    return prefix + content.slice(w.start, w.end) + suffix;
  }

  // Multiple windows: join with a separator marker
  return windows
    .map((w, i) => {
      const prefix =
        i > 0
          ? '\n... [between matches] ...\n'
          : w.start > 0
            ? '…\n'
            : '';
      const suffix =
        i < windows.length - 1 ? '' : w.end < content.length ? '\n…' : '';
      return prefix + content.slice(w.start, w.end) + suffix;
    })
    .join('');
}
