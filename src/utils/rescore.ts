import type { SearchResult, AcademicPaper, HackerNewsItem, RedditPost } from '../types.js';
import { parseAgeToDays, parseArxivYear } from './time.js';
import { getDomainAuthority } from './sourceTier.js';
import { getResultDomain } from './searchMerge.js';
import { contentDepthScore } from './searchRichness.js';

/**
 * Default weight for the `contentDepth` ranking signal when the caller's
 * weights map does not supply one (integrator wires the configured value;
 * this local default keeps the composite stable and backward compatible).
 */
export const CONTENT_DEPTH_WEIGHT = 0.05;

export interface RrfResultWithSignals<T> {
  item: T;
  rrfScore: number;
  signals: Record<string, number>;
}

export interface ScoredResult<T> {
  item: T;
  combinedScore: number;
  breakdown: {
    rrfAnchor: number;
    signals: Record<string, number>;
  };
}

export function applyRecencyDecay(ageDays: number, halfLifeDays: number): number {
  return Math.exp(-ageDays / halfLifeDays);
}

export function applyLogTransform(value: number): number {
  return Math.log(1 + Math.max(0, value));
}

export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return new Array<number>(values.length).fill(0);
  }
  return values.map((v) => (v - min) / range);
}

export function multiSignalRescore<T>(
  items: RrfResultWithSignals<T>[],
  weights: Partial<Record<string, number>>,
  limit: number,
): ScoredResult<T>[] {
  const rrfScores = items.map((i) => i.rrfScore);
  const rrfNorm = minMaxNormalize(rrfScores);

  const scored = items.map((item, idx) => {
    const rrfAnchorValue = rrfNorm[idx] ?? 0;
    let combinedScore = (weights.rrfAnchor ?? 0) * rrfAnchorValue;

    const signalBreakdown: Record<string, number> = {};
    for (const [key, value] of Object.entries(item.signals)) {
      let weight = weights[key];
      if (key === 'contentDepth' && weight === undefined) {
        weight = CONTENT_DEPTH_WEIGHT;
      }
      combinedScore += (weight ?? 0) * value;
      signalBreakdown[key] = value;
    }

    return {
      item: item.item,
      combinedScore,
      breakdown: {
        rrfAnchor: rrfAnchorValue,
        signals: signalBreakdown,
      },
    };
  });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  return scored.slice(0, limit);
}

export interface WebSearchSignalOptions {
  /** The original (non-category-expanded) query, used for year/recency intent. */
  query?: string | undefined;
}

/**
 * Detect an explicit four-digit year in the ORIGINAL query, e.g. `2026` in
 * "python 3.13 release 2026". Returns null when no explicit year intent exists
 * (so freshness is not forced on queries that never asked for a year).
 */
export function extractYearIntent(query: string | undefined): number | null {
  if (query == null) return null;
  // Reject candidates directly adjacent to `-` or `/` so embedded identifier
  // values (CVE-2026-…, ISO 2026-…, date ranges like 2026/03) never become year
  // intent; standalone four-digit years still match.
  const match = /(?<![-/])\b(19\d{2}|20\d{2})\b(?![-/])/.exec(query);
  const year = match?.[1];
  if (year === undefined) return null;
  const value = Number(year);
  return Number.isFinite(value) ? value : null;
}

/** True when the query signals a recency/freshness interest (year or keywords). */
export function hasFreshnessIntent(query: string | undefined): boolean {
  if (extractYearIntent(query) !== null) return true;
  if (query == null) return false;
  return /\b(recent|newest|latest|new|news|fresh|update|updated)\b/i.test(query);
}

/** Extract a four-digit year from an age string when one is encoded. */
function yearFromAge(age: string | null): number | null {
  if (age == null) return null;
  const trimmed = age.trim();
  const match = /^(19\d{2}|20\d{2})/.exec(trimmed);
  if (match?.[1]) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) return parsed.getFullYear();
  // Relative ages ("X days/weeks ago") resolve to a year from the current date.
  const days = parseAgeToDays(trimmed);
  if (days != null) {
    const year = new Date(Date.now() - days * 24 * 60 * 60 * 1000).getFullYear();
    if (Number.isFinite(year)) return year;
  }
  return null;
}

/**
 * Best-effort publication year for a result. `age` is only trusted as a
 * publication year when `ageKind === 'published'` — a `fetched` or
 * unclassified age is a crawl/fetch timestamp, not evidence of when the
 * content was published, and must never satisfy an explicit year intent.
 * The arXiv ID (when present) is always a valid publication-year fallback,
 * even when a `fetched` age is also present.
 */
function resultYear(result: SearchResult): number | null {
  if (result.ageKind === 'published') {
    const fromAge = yearFromAge(result.age);
    if (fromAge !== null) return fromAge;
  }
  return parseArxivYear(result.url);
}

export function extractWebSearchSignals(
  results: SearchResult[],
  options: WebSearchSignalOptions = {},
): Record<string, number>[] {
  // Query-sensitive recency: news/recency intent uses an aggressive 7-day news
  // half-life; otherwise a mild 60-day half-life so results are not collapsed
  // toward zero purely because no freshness was requested.
  const halfLife = hasFreshnessIntent(options.query) ? 7 : 60;
  const rawRecency = results.map((r) => {
    // Only publication dates indicate content freshness. Fetched and unknown
    // ages are neutral because they describe retrieval, not publication.
    if (r.ageKind !== 'published') return 0;
    const days = parseAgeToDays(r.age);
    if (days == null) return 0;
    return applyRecencyDecay(days, halfLife);
  });
  const recencyNorm = minMaxNormalize(rawRecency);

  const intentYear = extractYearIntent(options.query);

  return results.map((r, i) => {
    const signals: Record<string, number> = {
      domainAuthority: getDomainAuthority(getResultDomain(r)),
      recency: recencyNorm[i] ?? 0,
      hasDeepLinks: (r.deepLinks?.length ?? 0) > 0 ? 1 : 0,
      contentDepth: contentDepthScore(r),
    };
    if (intentYear !== null) {
      const year = resultYear(r);
      // Explicit year intent: matching year is preferred (1), a known wrong year
      // is strongly penalized (0), and an unknown date is neutral (0.5) rather
      // than falsely fresh.
      signals.yearAlignment = year === intentYear ? 1 : year !== null ? 0 : 0.5;
    }
    return signals;
  });
}

/**
 * Re-group ranked web-search results so an explicit year intent in the
 * ORIGINAL query survives an optional semantic rerank. Semantic rerank scores
 * purely on cosine × authority and has no notion of publication year, so it
 * can resurface a wrong-year result ahead of a matching one; this grouping
 * restores that ordering without discarding the semantic order within each
 * group (stable sort — groups are built by a single pass over `items`).
 * A no-op when the query carries no explicit year.
 */
export function applyExplicitYearIntentOrder<T extends SearchResult>(
  items: T[],
  query: string | undefined,
): T[] {
  const intentYear = extractYearIntent(query);
  if (intentYear === null) return items;

  const match: T[] = [];
  const unknown: T[] = [];
  const wrong: T[] = [];
  for (const item of items) {
    const year = resultYear(item);
    if (year === intentYear) match.push(item);
    else if (year === null) unknown.push(item);
    else wrong.push(item);
  }
  return [...match, ...unknown, ...wrong];
}

export function extractAcademicSignals(
  papers: AcademicPaper[],
  currentYear: number,
): Record<string, number>[] {
  const rawRecency = papers.map((p) => {
    const ageYears = p.year == null ? 10 : currentYear - p.year;
    const ageDays = ageYears * 365;
    return applyRecencyDecay(ageDays, 1095);
  });
  const recencyNorm = minMaxNormalize(rawRecency);

  const rawCitations = papers.map((p) => applyLogTransform(p.citationCount ?? 0));
  const citationsNorm = minMaxNormalize(rawCitations);

  return papers.map((p, i) => ({
    recency: recencyNorm[i] ?? 0,
    citations: citationsNorm[i] ?? 0,
    venue: p.venue != null && p.venue.length > 0 ? 1 : 0,
  }));
}

export function extractHNSignals(
  items: HackerNewsItem[],
  sort: 'relevance' | 'date' | 'top',
): Record<string, number>[] {
  let rawRecency: number[] | undefined;
  if (sort !== 'date') {
    rawRecency = items.map((item) => {
      const days = (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
  }
  const recencyNorm = rawRecency != null ? minMaxNormalize(rawRecency) : undefined;

  let rawEngagement: number[] | undefined;
  if (sort !== 'top') {
    rawEngagement = items.map((item) => applyLogTransform(item.points));
  }
  const engagementNorm = rawEngagement != null ? minMaxNormalize(rawEngagement) : undefined;

  const rawCommentEngagement = items.map((item) => applyLogTransform(item.numComments));
  const commentEngagementNorm = minMaxNormalize(rawCommentEngagement);

  return items.map((_, i) => {
    const signals: Record<string, number> = {};
    if (recencyNorm != null) {
      signals.recency = recencyNorm[i] ?? 0;
    }
    if (engagementNorm != null) {
      signals.engagement = engagementNorm[i] ?? 0;
    }
    signals.commentEngagement = commentEngagementNorm[i] ?? 0;
    return signals;
  });
}

export function extractRedditSignals(
  posts: RedditPost[],
  sort: 'relevance' | 'date' | 'top',
): Record<string, number>[] {
  let rawRecency: number[] | undefined;
  if (sort !== 'date') {
    rawRecency = posts.map((post) => {
      const days = (Date.now() - post.createdUtc * 1000) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
  }
  const recencyNorm = rawRecency != null ? minMaxNormalize(rawRecency) : undefined;

  let rawEngagement: number[] | undefined;
  if (sort !== 'top') {
    rawEngagement = posts.map((post) => applyLogTransform(post.score));
  }
  const engagementNorm = rawEngagement != null ? minMaxNormalize(rawEngagement) : undefined;

  const rawCommentEngagement = posts.map((post) => applyLogTransform(post.numComments));
  const commentEngagementNorm = minMaxNormalize(rawCommentEngagement);

  return posts.map((_, i) => {
    const signals: Record<string, number> = {};
    if (recencyNorm != null) {
      signals.recency = recencyNorm[i] ?? 0;
    }
    if (engagementNorm != null) {
      signals.engagement = engagementNorm[i] ?? 0;
    }
    signals.commentEngagement = commentEngagementNorm[i] ?? 0;
    return signals;
  });
}
