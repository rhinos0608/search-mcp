import type { SearchResult } from '../types.js';

export interface MergedSearchResult extends SearchResult {
  engines: string[];
}

const DOMAIN_AUTHORITY: Record<string, number> = {
  'arxiv.org': 0.9,
  'wikipedia.org': 0.9,
  'github.com': 0.8,
  'stackoverflow.com': 0.8,
  'developer.mozilla.org': 0.8,
  'docs.python.org': 0.8,
  'nodejs.org': 0.75,
  'typescriptlang.org': 0.75,
  'react.dev': 0.7,
  'docs.rs': 0.7,
  'crates.io': 0.7,
  'pypi.org': 0.7,
  'npmjs.com': 0.7,
  'medium.com': 0.5,
  'reddit.com': 0.4,
  'youtube.com': 0.3,
  'twitter.com': 0.3,
  'substack.com': 0.45,
  'dev.to': 0.4,
};

export function normalizeUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    parsed.hostname = hostname;
    parsed.hash = '';
    // Normalize trailing slash
    let pathname = parsed.pathname;
    if (pathname.endsWith('/') && pathname !== '/') {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return url.toLowerCase().trim();
  }
}

function getDomainAuthority(domain: string): number {
  const bare = domain.replace(/^www\./, '').toLowerCase();
  return DOMAIN_AUTHORITY[bare] ?? 0.3;
}

export function mergeSearchResults(
  backendResults: Map<string, SearchResult[]>,
  limit = 10,
): MergedSearchResult[] {
  if (backendResults.size === 0) return [];

  // Step 1: deduplicate by normalized URL, tracking engine agreement
  const byUrl = new Map<
    string,
    { result: SearchResult; engines: Set<string>; bestPosition: number }
  >();

  for (const [engine, results] of backendResults) {
    for (const result of results) {
      const key = normalizeUrlForDedup(result.url);
      const existing = byUrl.get(key);

      if (existing === undefined) {
        byUrl.set(key, {
          result,
          engines: new Set([engine]),
          bestPosition: result.position,
        });
      } else {
        existing.engines.add(engine);
        if (result.position < existing.bestPosition) {
          existing.bestPosition = result.position;
        }
      }
    }
  }

  // Step 2: score each result
  const scored = Array.from(byUrl.values()).map((entry) => {
    const engineAgreement = entry.engines.size;
    const domainAuthority = getDomainAuthority(
      entry.result.domain || new URL(entry.result.url).hostname,
    );
    const positionPenalty = 1 / Math.log(entry.bestPosition + Math.E);

    // Composite score: engine agreement * 0.4 + domain authority * 0.3 + position * 0.3
    const score =
      Math.min(engineAgreement / 2, 1) * 0.4 + domainAuthority * 0.3 + positionPenalty * 0.3;

    return {
      ...entry.result,
      engines: Array.from(entry.engines),
      score,
    };
  });

  // Step 3: sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 4: return top-k with position reassigned
  return scored.slice(0, limit).map((r, i) => ({
    ...r,
    position: i + 1,
  }));
}
