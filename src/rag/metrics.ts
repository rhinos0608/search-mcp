// ── Types ──────────────────────────────────────────────────────────────────────

export type MetricValue = number;

export interface Counter {
  name: string;
  description: string;
  value: number;
  labels?: Record<string, string>;
}

export interface Histogram {
  name: string;
  description: string;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
  labels?: Record<string, string>;
}

export interface Gauge {
  name: string;
  description: string;
  current: number;
  min?: number;
  max?: number;
  labels?: Record<string, string>;
}

export interface MetricsSnapshot {
  timestamp: Date;
  counters: Counter[];
  histograms: Histogram[];
  gauges: Gauge[];
}

// ── Registry ─────────────────────────────────────────────────────────────────

interface CounterEntry {
  name: string;
  description: string;
  value: number;
  labels?: Record<string, string>;
}

interface HistogramEntry {
  name: string;
  description: string;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
  labels?: Record<string, string>;
}

interface GaugeEntry {
  name: string;
  description: string;
  current: number;
  min?: number;
  max?: number;
  labels?: Record<string, string>;
}

const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();
const gauges = new Map<string, GaugeEntry>();

// ── Counters ─────────────────────────────────────────────────────────────────

export function registerCounter(
  name: string,
  description: string,
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  if (!counters.has(key)) {
    const entry: CounterEntry = {
      name,
      description,
      value: 0,
      ...(labels !== undefined && { labels }),
    };
    counters.set(key, entry);
  }
}

export function incrementCounter(
  name: string,
  delta = 1,
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  const existing = counters.get(key);
  if (existing) {
    existing.value += delta;
  } else {
    const entry: CounterEntry = {
      name,
      description: '',
      value: delta,
      ...(labels !== undefined && { labels }),
    };
    counters.set(key, entry);
  }
}

export function getCounter(
  name: string,
  labels?: Record<string, string>,
): Counter | undefined {
  const key = metricKey(name, labels);
  const entry = counters.get(key);
  if (!entry) return undefined;
  const out: Counter = {
    name: entry.name,
    description: entry.description,
    value: entry.value,
  };
  if (entry.labels !== undefined) out.labels = entry.labels;
  return out;
}

export function getAllCounters(groupByName?: boolean): Counter[] {
  const entries = [...counters.values()];
  if (!groupByName) {
    return entries.map<Counter>((e) => {
      const out: Counter = {
        name: e.name,
        description: e.description,
        value: e.value,
      };
      if (e.labels !== undefined) out.labels = e.labels;
      return out;
    });
  }

  const grouped = new Map<string, number>();
  for (const e of entries) {
    const existing = grouped.get(e.name) ?? 0;
    grouped.set(e.name, existing + e.value);
  }
  return [...grouped.entries()].map(([name, value]) => {
    const out: Counter = {
      name,
      description: entries.find((e) => e.name === name)?.description ?? '',
      value,
    };
    return out;
  });
}

// ── Histograms ───────────────────────────────────────────────────────────────

export function registerHistogram(
  name: string,
  description: string,
  buckets: number[],
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  if (!histograms.has(key)) {
    const entry: HistogramEntry = {
      name,
      description,
      buckets,
      counts: new Array<number>(buckets.length).fill(0),
      sum: 0,
      count: 0,
      ...(labels !== undefined && { labels }),
    };
    histograms.set(key, entry);
  }
}

export function observeHistogram(
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  const existing = histograms.get(key);
  if (!existing) {
    // Create with default buckets if not registered
    const defaultBuckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
    const entry: HistogramEntry = {
      name,
      description: '',
      buckets: defaultBuckets,
      counts: new Array<number>(defaultBuckets.length).fill(0),
      sum: value,
      count: 1,
      ...(labels !== undefined && { labels }),
    };
    let bucketed = false;
    for (let i = 0; i < entry.buckets.length; i += 1) {
      const bucket = entry.buckets[i];
      if (bucket === undefined) break;
      if (value <= bucket) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
        bucketed = true;
        break;
      }
    }
    if (!bucketed) {
      // Value exceeds all buckets; quietly ignore
    }
    histograms.set(key, entry);
    return;
  }

  existing.sum += value;
  existing.count += 1;
  let bucketed = false;
  for (let i = 0; i < existing.buckets.length; i += 1) {
    const bucket = existing.buckets[i];
    if (bucket === undefined) break;
    if (value <= bucket) {
      existing.counts[i] = (existing.counts[i] ?? 0) + 1;
      bucketed = true;
      break;
    }
  }
  if (!bucketed) {
    // Value exceeds all buckets; quietly ignore for bucket counts
    // A production system would track +Inf separately
  }
  histograms.set(key, existing);
}

export function getHistogram(
  name: string,
  labels?: Record<string, string>,
): Histogram | undefined {
  const key = metricKey(name, labels);
  const entry = histograms.get(key);
  if (!entry) return undefined;
  const out: Histogram = {
    name: entry.name,
    description: entry.description,
    buckets: [...entry.buckets],
    counts: [...entry.counts],
    sum: entry.sum,
    count: entry.count,
  };
  if (entry.labels !== undefined) out.labels = entry.labels;
  return out;
}

export function getAllHistograms(): Histogram[] {
  return [...histograms.values()].map((e) => {
    const out: Histogram = {
      name: e.name,
      description: e.description,
      buckets: [...e.buckets],
      counts: [...e.counts],
      sum: e.sum,
      count: e.count,
    };
    if (e.labels !== undefined) out.labels = e.labels;
    return out;
  });
}

// ── Gauges ───────────────────────────────────────────────────────────────────

export function registerGauge(
  name: string,
  description: string,
  initial = 0,
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  if (!gauges.has(key)) {
    const entry: GaugeEntry = {
      name,
      description,
      current: initial,
      ...(labels !== undefined && { labels }),
    };
    gauges.set(key, entry);
  }
}

export function setGauge(
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  const key = metricKey(name, labels);
  const existing = gauges.get(key);
  if (existing) {
    existing.current = value;
    if (existing.min === undefined || value < existing.min) existing.min = value;
    if (existing.max === undefined || value > existing.max) existing.max = value;
  } else {
    const entry: GaugeEntry = {
      name,
      description: '',
      current: value,
      ...(labels !== undefined && { labels }),
    };
    gauges.set(key, entry);
  }
}

export function getGauge(
  name: string,
  labels?: Record<string, string>,
): Gauge | undefined {
  const key = metricKey(name, labels);
  const entry = gauges.get(key);
  if (!entry) return undefined;
  const out: Gauge = {
    name: entry.name,
    description: entry.description,
    current: entry.current,
  };
  if (entry.labels !== undefined) out.labels = entry.labels;
  if (entry.min !== undefined) out.min = entry.min;
  if (entry.max !== undefined) out.max = entry.max;
  return out;
}

export function getAllGauges(): Gauge[] {
  return [...gauges.values()].map((e) => {
    const out: Gauge = {
      name: e.name,
      description: e.description,
      current: e.current,
    };
    if (e.labels !== undefined) out.labels = e.labels;
    if (e.min !== undefined) out.min = e.min;
    if (e.max !== undefined) out.max = e.max;
    return out;
  });
}

// ── RAG-specific metrics helpers ───────────────────────────────────────────

export function recordRetrievalMetrics(options: {
  adapter: string;
  totalChunks: number;
  returnedResults: number;
  durationMs: number;
  vectorCandidates?: number;
  lexicalCandidates?: number;
}): void {
  const adapter = options.adapter;
  incrementCounter('rag.retrieval.total', 1, { adapter });
  observeHistogram('rag.retrieval.duration_ms', options.durationMs, { adapter });
  setGauge('rag.chunks.available', options.totalChunks, { adapter });
  incrementCounter('rag.results.returned', options.returnedResults, { adapter });

  if (options.vectorCandidates !== undefined) {
    incrementCounter('rag.candidates.vector', options.vectorCandidates, { adapter });
  }
  if (options.lexicalCandidates !== undefined) {
    incrementCounter('rag.candidates.lexical', options.lexicalCandidates, { adapter });
  }
}

export function recordDedupMetrics(options: {
  adapter: string;
  documentsBefore: number;
  documentsAfter: number;
  urlRemoved: number;
  fingerprintRemoved: number;
  semanticRemoved: number;
}): void {
  const adapter = options.adapter;
  incrementCounter('rag.dedup.url_removed', options.urlRemoved, { adapter });
  incrementCounter('rag.dedup.fingerprint_removed', options.fingerprintRemoved, { adapter });
  incrementCounter('rag.dedup.semantic_removed', options.semanticRemoved, { adapter });
  setGauge('rag.documents.after_dedup', options.documentsAfter, { adapter });
}

export function recordConstraintMetrics(options: {
  adapter: string;
  hardConstraints: number;
  softConstraints: number;
  passed: number;
  filtered: number;
}): void {
  const adapter = options.adapter;
  incrementCounter('rag.constraints.hard.evaluated', options.hardConstraints, { adapter });
  incrementCounter('rag.constraints.soft.evaluated', options.softConstraints, { adapter });
  incrementCounter('rag.constraints.passed', options.passed, { adapter });
  incrementCounter('rag.constraints.filtered', options.filtered, { adapter });
}

export function recordAdapterMetrics(options: {
  adapter: string;
  operation: string;
  durationMs: number;
  documentCount?: number;
  chunkCount?: number;
  success?: boolean;
}): void {
  const adapter = options.adapter;
  const operation = options.operation;
  incrementCounter('rag.adapter.operations', 1, { adapter, operation });
  observeHistogram('rag.adapter.duration_ms', options.durationMs, { adapter, operation });
  if (options.documentCount !== undefined) {
    incrementCounter('rag.adapter.documents', options.documentCount, { adapter, operation });
  }
  if (options.chunkCount !== undefined) {
    incrementCounter('rag.adapter.chunks', options.chunkCount, { adapter, operation });
  }
  if (options.success !== undefined && !options.success) {
    incrementCounter('rag.adapter.errors', 1, { adapter, operation });
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export function takeSnapshot(): MetricsSnapshot {
  return {
    timestamp: new Date(),
    counters: getAllCounters(),
    histograms: getAllHistograms(),
    gauges: getAllGauges(),
  };
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
  gauges.clear();
}

// ── Output ───────────────────────────────────────────────────────────────────

export function formatMetrics(snapshot?: MetricsSnapshot): string {
  const snap = snapshot ?? takeSnapshot();
  const lines: string[] = [`# Metrics snapshot at ${snap.timestamp.toISOString()}`, ''];

  if (snap.counters.length > 0) {
    lines.push('## Counters');
    for (const c of snap.counters) {
      const labelStr = formatLabels(c.labels);
      lines.push(`${c.name}${labelStr} ${String(c.value)}`);
    }
    lines.push('');
  }

  if (snap.gauges.length > 0) {
    lines.push('## Gauges');
    for (const g of snap.gauges) {
      const labelStr = formatLabels(g.labels);
      lines.push(`${g.name}${labelStr} ${String(g.current)}`);
    }
    lines.push('');
  }

  if (snap.histograms.length > 0) {
    lines.push('## Histograms');
    for (const h of snap.histograms) {
      const labelStr = formatLabels(h.labels);
      lines.push(`${h.name}${labelStr} count=${String(h.count)} sum=${String(h.sum)}`);
      for (let i = 0; i < h.buckets.length; i += 1) {
        lines.push(`  le ${String(h.buckets[i])}: ${String(h.counts[i])}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function metricKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${name}{${sorted.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}
