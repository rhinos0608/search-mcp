/**
 * Selective two-tier indexed enrichment.
 * Discovery stays cheap. Only bounded selected candidates call enrichUrls.
 */
import { acquiredContentHash, deterministicAcquisitionId } from '../acquisition/adapterSupport.js';
import { AcquisitionSliceResultSchema } from '../acquisition/contracts.js';
import type {
  AcquisitionCandidate,
  AcquisitionSliceResult,
  DiscoveryEvidence,
} from '../acquisition/contracts.js';
import type { AcquisitionRunResult } from '../acquisition/coordinator.js';
import type { IndexedProviderPort } from '../acquisition/providers/ports.js';
import { normalizeHttpUrlMetadata } from '../acquisition/adapterSupport.js';
import { classifyListingUrl } from '../acquisition/listingHeuristics.js';

function capText(text: string): string {
  return text.length > 8192 ? text.slice(0, 8192) : text;
}

function snippetLength(
  candidate: AcquisitionCandidate,
  evidence: readonly DiscoveryEvidence[],
): number {
  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  for (const ref of candidate.evidenceRefs) {
    const ev = byId.get(ref);
    if (ev?.kind === 'indexed_snippet' && typeof ev.boundedText === 'string') {
      return ev.boundedText.length;
    }
  }
  return 0;
}

function titleOverlap(titleHint: string | undefined, query: string): number {
  if (titleHint === undefined || titleHint.length === 0) return 0;
  const q = new Set(
    query
      .toLowerCase()
      .split(/\s+/u)
      .filter((t) => t.length > 0),
  );
  const t = titleHint
    .toLowerCase()
    .split(/\s+/u)
    .filter((tok) => tok.length > 0);
  let n = 0;
  for (const tok of t) if (q.has(tok)) n += 1;
  return n;
}

function candidateUrl(candidate: AcquisitionCandidate): string | undefined {
  return candidate.provenance.destination?.canonicalUrl;
}

function canEnrich(port: IndexedProviderPort | undefined): port is IndexedProviderPort {
  return (
    port !== undefined &&
    typeof port.enrichUrls === 'function' &&
    port.governance.supportsUrlAttributedSummary
  );
}

function enrichPortForCandidate(
  cand: AcquisitionCandidate,
  run: AcquisitionRunResult,
  portByProvider: Map<string, IndexedProviderPort>,
): IndexedProviderPort | undefined {
  const url = candidateUrl(cand);
  const rows: { providerId: string; ordinal: number; candidateId: string }[] = [];
  const consider = (c: AcquisitionCandidate, ordinal: number): void => {
    if (c.provenance.kind !== 'indexed_discovery') return;
    for (const d of c.provenance.discoverers) {
      rows.push({ providerId: d.providerId, ordinal, candidateId: c.candidateId });
    }
  };
  const sliceOrdinal = new Map<string, number>();
  for (const [i, slice] of run.slices.entries()) sliceOrdinal.set(slice.sliceId, i);
  consider(cand, sliceOrdinal.get(cand.sliceId) ?? 0);
  if (url !== undefined) {
    const group = run.duplicates.find((g) => g.canonicalUrl === url);
    if (group !== undefined) {
      const wanted = new Set([
        group.retainedCandidateId,
        ...group.superseded.map((s) => s.candidateId),
      ]);
      wanted.delete(cand.candidateId);
      for (const [i, slice] of run.slices.entries()) {
        for (const extra of slice.candidates) {
          if (!wanted.has(extra.candidateId)) continue;
          consider(extra, i);
        }
      }
    }
  }
  rows.sort((a, b) => {
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    if (a.candidateId !== b.candidateId) return a.candidateId < b.candidateId ? -1 : 1;
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.providerId)) continue;
    seen.add(row.providerId);
    const port = portByProvider.get(row.providerId);
    if (canEnrich(port)) return port;
  }
  return undefined;
}

export function selectIndexedEnrichmentCandidates(
  run: AcquisitionRunResult,
  query: string,
  cap: number,
): AcquisitionCandidate[] {
  if (cap <= 0) return [];
  const superseded = new Set<string>();
  for (const group of run.duplicates) {
    for (const s of group.superseded) superseded.add(s.candidateId);
  }
  const sliceOrdinal = new Map<string, number>();
  for (const [i, slice] of run.slices.entries()) sliceOrdinal.set(slice.sliceId, i);
  const retained: AcquisitionCandidate[] = [];
  for (const slice of run.slices) {
    for (const cand of slice.candidates) {
      if (superseded.has(cand.candidateId)) continue;
      if (cand.state !== 'indexed_only' && cand.state !== 'fetch_eligible') continue;
      // Aggregates are discovery artifacts: never spend enrichUrls on SERPs.
      if (cand.caveats.includes('aggregate_search_page')) continue;
      const candUrl = candidateUrl(cand);
      if (candUrl !== undefined && classifyListingUrl(candUrl) === 'aggregate') continue;
      retained.push(cand);
    }
  }
  const scored = retained.map((cand) => {
    const slice = run.slices.find((s) => s.sliceId === cand.sliceId);
    const evidence = slice?.evidence ?? [];
    const caveats = cand.caveats;
    let priority = 3;
    if (
      caveats.includes('destination_fetch_blocked') ||
      caveats.includes('publisher_not_fetched')
    ) {
      priority = 1;
    } else if (snippetLength(cand, evidence) < 80) {
      priority = 2;
    }
    const title =
      'titleHint' in cand && typeof cand.titleHint === 'string' ? cand.titleHint : undefined;
    return {
      cand,
      priority,
      overlap: titleOverlap(title, query),
      ordinal: sliceOrdinal.get(cand.sliceId) ?? 0,
    };
  });
  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.cand.candidateId < b.cand.candidateId
      ? -1
      : a.cand.candidateId > b.cand.candidateId
        ? 1
        : 0;
  });
  const selected: AcquisitionCandidate[] = [];
  const seenUrl = new Set<string>();
  for (const row of scored) {
    if (selected.length >= cap) break;
    const url = candidateUrl(row.cand);
    if (url !== undefined) {
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
    }
    selected.push(row.cand);
  }
  return selected;
}

function makeSummaryEvidence(
  slice: AcquisitionSliceResult,
  providerId: string,
  adapterId: string,
  url: string,
  summary: string,
  capturedAt: string,
): DiscoveryEvidence {
  const hash = acquiredContentHash(summary);
  const evidenceId = deterministicAcquisitionId('evidence', [
    slice.runId,
    slice.sliceId,
    adapterId,
    url,
    'provider_generated_summary',
    String(slice.evidence.length),
  ]);
  return {
    evidenceId,
    kind: 'provider_generated_summary',
    providerAttributed: true,
    providerId,
    targetCanonicalUrl: url,
    contentHash: hash,
    capturedAt,
    boundedText: capText(summary),
    generatedBy: providerId,
    urlAttributable: true,
  } as DiscoveryEvidence;
}

/**
 * Deterministic run-capturedAt threading: every enrichment evidence timestamp
 * comes from the acquisition run's capturedAt (request provenance), never from
 * wall-clock `new Date()`, so identical deps reproduce identical output.
 */
function normalizeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].slice(0, 50);
}

export async function applyIndexedEnrichment(
  run: AcquisitionRunResult,
  ports: readonly IndexedProviderPort[],
  query: string,
  cap: number,
  runCapturedAt: string,
): Promise<{ run: AcquisitionRunResult; warnings: string[] }> {
  const warnings: string[] = [];
  const selected = selectIndexedEnrichmentCandidates(run, query, cap);
  if (selected.length === 0) return { run, warnings: normalizeWarnings(warnings) };

  const portByProvider = new Map(ports.map((p) => [p.providerId, p]));
  const sliceById = new Map(run.slices.map((s) => [s.sliceId, s]));
  const batches = new Map<string, { port: IndexedProviderPort; items: AcquisitionCandidate[] }>();
  for (const cand of selected) {
    const port = enrichPortForCandidate(cand, run, portByProvider);
    if (port === undefined) {
      warnings.push('indexed_enrichment_skipped');
      continue;
    }
    const batch = batches.get(port.providerId) ?? { port, items: [] };
    batch.items.push(cand);
    batches.set(port.providerId, batch);
  }

  const mutatedSlices = new Map<string, AcquisitionSliceResult>();
  for (const [, batch] of batches) {
    const urls: string[] = [];
    const byUrl = new Map<string, AcquisitionCandidate[]>();
    for (const cand of batch.items) {
      const url = candidateUrl(cand);
      if (url === undefined) continue;
      const meta = normalizeHttpUrlMetadata(url);
      if (!meta) continue;
      const canonical = meta.canonicalUrl;
      const list = byUrl.get(canonical) ?? [];
      list.push(cand);
      byUrl.set(canonical, list);
      if (!urls.includes(canonical)) urls.push(canonical);
    }
    if (urls.length === 0) continue;
    let results: readonly {
      url: string;
      generatedSummary?: string;
      generatedSummaryProvider?: string;
    }[] = [];
    try {
      if (typeof batch.port.enrichUrls !== 'function') {
        warnings.push('indexed_enrichment_skipped');
        continue;
      }
      results = await batch.port.enrichUrls({
        urls: urls.slice(0, 10),
        mode: 'summary',
        ...(query.length > 0 ? { query } : {}),
      });
    } catch {
      warnings.push('indexed_enrichment_failed');
      continue;
    }
    const resultByUrl = new Map<string, (typeof results)[number]>();
    for (const row of results) {
      const meta = normalizeHttpUrlMetadata(row.url);
      if (!meta) continue;
      resultByUrl.set(meta.canonicalUrl, row);
    }
    for (const [canonical, cands] of byUrl) {
      const row = resultByUrl.get(canonical);
      const summary = row?.generatedSummary?.trim() ?? '';
      if (summary.length === 0) {
        warnings.push('indexed_enrichment_skipped');
        continue;
      }
      const cand = cands[0];
      if (!cand) continue;
      const original = mutatedSlices.get(cand.sliceId) ?? sliceById.get(cand.sliceId);
      if (!original) continue;
      const slice = structuredClone(original);
      const target = slice.candidates.find((c) => c.candidateId === cand.candidateId);
      if (!target) continue;
      // Non-indexed discovery provenance: fall back to the run's capturedAt
      // (threaded from the request), never wall-clock time.
      const capturedAt =
        target.provenance.kind === 'indexed_discovery'
          ? target.provenance.capturedAt
          : runCapturedAt;
      const ev = makeSummaryEvidence(
        slice,
        batch.port.providerId,
        batch.port.adapterId,
        canonical,
        summary,
        capturedAt,
      );
      slice.evidence = [...slice.evidence, ev];
      const nextRefs = [...target.evidenceRefs, ev.evidenceId];
      const nextCaveats = target.caveats.includes('provider_generated_summary')
        ? target.caveats
        : [...target.caveats, 'provider_generated_summary'];
      const updated = {
        ...target,
        evidenceRefs: nextRefs.slice(0, 32),
        caveats: nextCaveats.slice(0, 16),
      };
      slice.candidates = slice.candidates.map((c) =>
        c.candidateId === target.candidateId ? (updated as AcquisitionCandidate) : c,
      );
      const parsed = AcquisitionSliceResultSchema.safeParse(slice);
      if (!parsed.success) {
        warnings.push('indexed_enrichment_failed');
        continue;
      }
      mutatedSlices.set(cand.sliceId, parsed.data);
    }
  }

  if (mutatedSlices.size === 0) return { run, warnings: normalizeWarnings(warnings) };
  const slices = run.slices.map((s) => mutatedSlices.get(s.sliceId) ?? s);
  return { run: { ...run, slices }, warnings: normalizeWarnings(warnings) };
}
