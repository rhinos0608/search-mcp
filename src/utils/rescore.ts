import type { SearchResult, AcademicPaper, HackerNewsItem, RedditPost } from '../types.js';
import { parseAgeToDays } from './time.js';

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
  return values.map(v => (v - min) / range);
}

export function multiSignalRescore<T>(
  items: RrfResultWithSignals<T>[],
  weights: Record<string, number>,
  limit: number,
): ScoredResult<T>[] {
  const rrfScores = items.map(i => i.rrfScore);
  const rrfNorm = minMaxNormalize(rrfScores);

  const scored = items.map((item, idx) => {
    const rrfAnchorValue = rrfNorm[idx] ?? 0;
    let combinedScore = (weights.rrfAnchor ?? 0) * rrfAnchorValue;

    const signalBreakdown: Record<string, number> = {};
    for (const [key, value] of Object.entries(item.signals)) {
      const weight = weights[key] ?? 0;
      combinedScore += weight * value;
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

export function extractWebSearchSignals(results: SearchResult[]): Record<string, number>[] {
  const rawRecency = results.map(r => {
    const days = parseAgeToDays(r.age);
    if (days == null) return 0;
    return applyRecencyDecay(days, 7);
  });
  const recencyNorm = minMaxNormalize(rawRecency);

  return results.map((r, i) => ({
    recency: recencyNorm[i] ?? 0,
    hasDeepLinks: (r.deepLinks?.length ?? 0) > 0 ? 1 : 0,
  }));
}

export function extractAcademicSignals(papers: AcademicPaper[], currentYear: number): Record<string, number>[] {
  const rawRecency = papers.map(p => {
    const ageYears = p.year == null ? 10 : currentYear - p.year;
    const ageDays = ageYears * 365;
    return applyRecencyDecay(ageDays, 1095);
  });
  const recencyNorm = minMaxNormalize(rawRecency);

  const rawCitations = papers.map(p => applyLogTransform(p.citationCount ?? 0));
  const citationsNorm = minMaxNormalize(rawCitations);

  return papers.map((p, i) => ({
    recency: recencyNorm[i] ?? 0,
    citations: citationsNorm[i] ?? 0,
    venue: p.venue != null && p.venue.length > 0 ? 1 : 0,
  }));
}

export function extractHNSignals(items: HackerNewsItem[], sort: 'relevance' | 'date' | 'top'): Record<string, number>[] {
  let rawRecency: number[] | undefined;
  if (sort !== 'date') {
    rawRecency = items.map(item => {
      const days = (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
  }
  const recencyNorm = rawRecency != null ? minMaxNormalize(rawRecency) : undefined;

  let rawEngagement: number[] | undefined;
  if (sort !== 'top') {
    rawEngagement = items.map(item => applyLogTransform(item.points));
  }
  const engagementNorm = rawEngagement != null ? minMaxNormalize(rawEngagement) : undefined;

  const rawCommentEngagement = items.map(item => applyLogTransform(item.numComments));
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

export function extractRedditSignals(posts: RedditPost[], sort: 'relevance' | 'date' | 'top'): Record<string, number>[] {
  let rawRecency: number[] | undefined;
  if (sort !== 'date') {
    rawRecency = posts.map(post => {
      const days = (Date.now() - post.createdUtc * 1000) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
  }
  const recencyNorm = rawRecency != null ? minMaxNormalize(rawRecency) : undefined;

  let rawEngagement: number[] | undefined;
  if (sort !== 'top') {
    rawEngagement = posts.map(post => applyLogTransform(post.score));
  }
  const engagementNorm = rawEngagement != null ? minMaxNormalize(rawEngagement) : undefined;

  const rawCommentEngagement = posts.map(post => applyLogTransform(post.numComments));
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
