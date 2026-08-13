/**
 * Content-truth helpers shared by web-search dedup/ranking and the markdown
 * formatter.
 *
 * A "richer" representation is preferred over a thinner one when the same URL
 * is reported by multiple backends: full page text beats a generated summary
 * beats a thin excerpt, with byte length as the tiebreak within a kind. The
 * Codex "main source" preference is bounded — it applies only as a tiebreak
 * when the Codex result is not materially thinner than a competing one, so a
 * rich Exa/Tavily result can outrank a thin Codex snippet.
 */
import type { SearchResult } from '../types.js';

export type ContentKind = 'snippet' | 'full' | 'summary';

/** Ordinal richness of a content kind (higher = richer). */
export function contentKindRank(kind: ContentKind | undefined): number {
  if (kind === 'full') return 3;
  if (kind === 'summary') return 2;
  return 1; // 'snippet' or unset
}

/** Total content byte proxy (description + extras) used as a length tiebreak. */
export function contentLength(result: SearchResult): number {
  return result.description.length + (result.extraSnippet ?? '').length;
}

/**
 * Richness of a result representation as separate keys: `[contentKindRank,
 * contentLength]`. Kind rank is the primary key and always takes precedence
 * over text length, so a `full` representation is richer than a `summary` or
 * `snippet` regardless of how long the thinner one is. Compare with
 * `richerThan` / `contentRichnessEqual` (or lexicographically on the tuple).
 */
export type RichnessKey = readonly [number, number];

export function contentRichness(result: SearchResult): RichnessKey {
  return [contentKindRank(result.contentKind), contentLength(result)];
}

/** True when `a` is richer than `b` (kind rank first, then length). */
export function richerThan(a: SearchResult, b: SearchResult): boolean {
  const ra = contentRichness(a);
  const rb = contentRichness(b);
  return ra[0] > rb[0] || (ra[0] === rb[0] && ra[1] > rb[1]);
}

/** True when two representations have identical richness (kind rank and length). */
export function contentRichnessEqual(a: SearchResult, b: SearchResult): boolean {
  const ra = contentRichness(a);
  const rb = contentRichness(b);
  return ra[0] === rb[0] && ra[1] === rb[1];
}

/**
 * True when `a` is materially less rich than `b`: a strictly thinner content
 * kind, or the same kind with `b` at least twice as long.
 */
export function materiallyLessRich(a: SearchResult, b: SearchResult): boolean {
  const aRank = contentKindRank(a.contentKind);
  const bRank = contentKindRank(b.contentKind);
  if (bRank > aRank) return true;
  if (aRank > bRank) return false;
  return contentLength(b) > contentLength(a) * 2;
}

/** True when a result was produced by Codex, directly or via a Codex engine. */
export function isCodexProduced(result: SearchResult): boolean {
  return result.source === 'codex' || (result.engines?.includes('codex') ?? false);
}

/**
 * Minimum-content gate for the rendering pipeline. Drops results when BOTH
 * the title and body are below substantial-content thresholds: a title of at
 * most 1 character AND a body shorter than 20 characters. Any result carrying
 * a substantial title (> 1 char) or a substantial body (≥ 20 chars) is kept —
 * thin or title-only results are demoted by the contentDepth ranking signal
 * rather than deleted, so legitimate sparse results (short abstracts, terse
 * API-doc snippets, short-titled homepages) are never lost.
 */
export function hasMinimumContent(result: SearchResult): boolean {
  const body = (result.description + (result.extraSnippet ?? '')).trim();
  const title = result.title.trim();
  // Substantial: title longer than 1 char, or body at least 20 chars.
  if (title.length > 1 || body.length >= 20) return true;
  // Both below thresholds: reject.
  return false;
}

/** Normalized (0..1) content-kind rank: snippet 0, summary 0.5, full 1. */
function normalizedKindRank(kind: ContentKind | undefined): number {
  return (contentKindRank(kind) - 1) / 2;
}

/**
 * 0..1 depth score combining content-kind rank and content length. Length is
 * normalized with diminishing returns, saturating around a few thousand chars
 * (`length / (length + 2000)`), so a short but substantial result still gets
 * meaningful credit without letting byte count dominate kind. Used as a ranking
 * signal so thin snippets stop out-ranking richer full-page or summary results.
 */
export function contentDepthScore(result: SearchResult): number {
  const kindScore = normalizedKindRank(result.contentKind);
  const length = contentLength(result);
  const lengthScore = length / (length + 2000);
  return 0.5 * kindScore + 0.5 * lengthScore;
}
