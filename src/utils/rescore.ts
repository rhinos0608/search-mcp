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
    return new Array(values.length).fill(0);
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
