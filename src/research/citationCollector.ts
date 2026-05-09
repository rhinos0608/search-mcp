/**
 * CitationCollector — thread-safe citation tracking for agent-driven research.
 *
 * Assigns globally unique 1-based citation indices to search results.
 * Deduplicates by URL (reuses existing index when the same URL appears again).
 * Thread-safe for parallel access from sub-agents.
 */

interface CitationEntry {
  index: number; // 1-based, globally unique
  url: string;
  title: string;
  snippet: string;
  sourceType: string;
}

interface SearchResultLike {
  title?: string | undefined;
  link?: string | undefined;
  url?: string | undefined;
  snippet?: string | null | undefined;
  body?: string | undefined;
}

export class CitationCollector {
  private entries: CitationEntry[] = [];
  private urlMap = new Map<string, number>(); // normalized url → index
  private nextIndex = 1;

  /**
   * Add search results and return the starting citation index.
   * Thread-safe: uses synchronous operations on local state.
   */
  addResults(results: SearchResultLike[], sourceType: string): number {
    const startIdx = this.nextIndex;
    for (const r of results) {
      const url = (r.link ?? r.url ?? '').trim();
      const normalized = this.normalizeUrl(url);

      // Dedup: reuse existing index if URL already tracked
      if (normalized && this.urlMap.has(normalized)) continue;

      const idx = this.nextIndex++;
      if (normalized) this.urlMap.set(normalized, idx);

      this.entries.push({
        index: idx,
        url: url || '(no url)',
        title: r.title ?? 'Untitled',
        snippet: r.snippet ?? r.body ?? '',
        sourceType,
      });
    }
    return startIdx;
  }

  /** Find existing citation index for a URL, or undefined. */
  findCitation(url: string): number | undefined {
    return this.urlMap.get(this.normalizeUrl(url));
  }

  /** Get all entries sorted by index. */
  getAll(): CitationEntry[] {
    return [...this.entries];
  }

  /** Number of unique citations collected. */
  get count(): number {
    return this.entries.length;
  }

  /** Reset per-run state but preserve urlMap for cross-run dedup. */
  reset(): void {
    this.entries = [];
    this.nextIndex = 1;
  }

  /** Format results as citation text for LLM consumption. */
  formatForLlm(): string {
    if (this.entries.length === 0) return '(no sources collected)';
    return this.entries
      .map((e) => `[${String(e.index)}] ${e.title}\n${e.url}\n${e.snippet}`)
      .join('\n\n');
  }

  /** Format a source list for the final answer. */
  formatSourceList(): string {
    if (this.entries.length === 0) return '';
    return this.entries.map((e) => `[${String(e.index)}] ${e.title} — ${e.url}`).join('\n');
  }

  // ── private ────────────────────────────────────────────────────────

  private normalizeUrl(url: string): string {
    if (!url) return '';
    try {
      const u = new URL(url);
      // Strip tracking params and fragments
      u.searchParams.delete('utm_source');
      u.searchParams.delete('utm_medium');
      u.searchParams.delete('utm_campaign');
      u.searchParams.delete('utm_term');
      u.searchParams.delete('utm_content');
      u.searchParams.delete('ref');
      u.searchParams.delete('source');
      u.hash = '';
      // Remove trailing slash for consistency
      let normalized = u.toString();
      if (normalized.endsWith('/') && u.pathname !== '/') {
        normalized = normalized.slice(0, -1);
      }
      return normalized.toLowerCase();
    } catch {
      return url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
    }
  }
}
