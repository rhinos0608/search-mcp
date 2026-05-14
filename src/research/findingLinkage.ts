import { embedTexts } from '../rag/embedding.js';
import { logger } from '../logger.js';
import {
  type Finding,
  type FindingCluster,
  type FindingClusterEdge,
  type FindingClusterRelation,
  type FindingClusterEdgeStrength,
} from './types.js';
import type { EmbedRequest, EmbedResponse } from '../rag/embedding.js';

const DEFAULT_VECTOR_THRESHOLD = 0.82;
const DEFAULT_LEXICAL_THRESHOLD = 0.58;
const DEFAULT_DIRECT_THRESHOLD = 0.92;
const DEFAULT_MAX_EDGES_PER_FINDING = 8;
const DEFAULT_MAX_VECTOR_FINDINGS = 120;
const STRONG_VECTOR_LEXICAL_FLOOR = 0.18;
const STRONG_LEXICAL_FLOOR = 0.78;
/** Cosine threshold above which clusters auto-merge deterministically (no LLM needed). */
const DETERMINISTIC_MERGE_THRESHOLD = 0.92;
/** Lower bound of the LLM-review band. Cosine scores in [LLM_MERGE_BAND_LOWER, DETERMINISTIC_MERGE_THRESHOLD) need LLM review. */
const LLM_MERGE_BAND_LOWER = 0.8;
/** Maximum intra-cluster cosine distance before a cluster is split. */
const MAX_INTRA_CLUSTER_DISTANCE = 0.55;
/** Minimum cluster size to consider splitting. */
const MIN_CLUSTER_SIZE_FOR_SPLIT = 5;

const LINK_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'but',
  'can',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'may',
  'more',
  'not',
  'now',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'which',
  'with',
]);

export interface FindingLinkageOptions {
  embeddings?: number[][];
  vectorThreshold?: number;
  lexicalThreshold?: number;
  directThreshold?: number;
  maxEdgesPerFinding?: number;
}

export interface FindingLinkageResult {
  clusters: FindingCluster[];
  edges: FindingClusterEdge[];
  usedVectorIndex: boolean;
}

type EmbeddingClient = (request: EmbedRequest) => Promise<EmbedResponse>;

interface CandidateEdge extends FindingClusterEdge {
  leftIndex: number;
  rightIndex: number;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parent[value];
    if (parent === undefined) return value;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent[value] = root;
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, ' ')
    .trim();
}

function termsFor(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .map((term) => term.replace(/^[._/-]+|[._/-]+$/g, ''))
      .filter((term) => term.length > 2 && !LINK_STOP_WORDS.has(term)),
  );
}

function anchorsFor(text: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of text.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi)) {
    anchors.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(/\bv?\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi)) {
    anchors.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) anchors.add(match[0]);
  return anchors;
}

function discriminatorsFor(text: string): Set<string> {
  const discriminators = anchorsFor(text);
  const normalized = text.toLowerCase();
  if (/\bmodel context protocol\b/i.test(text)) discriminators.add('mcp');
  for (const match of text.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g)) {
    const phrase = match[0].toLowerCase().replace(/\s+/g, ' ');
    if (phrase !== 'model context protocol') discriminators.add(phrase);
  }
  for (const match of text.matchAll(/\b[A-Z]{2,}\b/g)) discriminators.add(match[0].toLowerCase());
  if (normalized.includes('claude desktop')) discriminators.add('claude desktop');
  if (normalized.includes('anthropic')) discriminators.add('anthropic');
  return discriminators;
}

function discriminatorGap(left: Set<string>, right: Set<string>): string[] {
  if (left.size === 0 || right.size === 0) return [];
  const gap = new Set<string>();
  for (const item of left) if (!right.has(item)) gap.add(item);
  for (const item of right) if (!left.has(item)) gap.add(item);
  return [...gap].sort();
}

function hasContradictionSignal(left: string, right: string): boolean {
  const negated =
    /\b(no longer|not|without|removed|removes|deprecated|drops?|disable[sd]?|cannot|can't)\b/i;
  const positive = /\b(adds?|added|supports?|introduced|enables?|includes?|allows?)\b/i;
  return (
    (negated.test(left) && positive.test(right)) || (negated.test(right) && positive.test(left))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function recordText(finding: Finding): string {
  return [finding.claim, finding.evidenceSummary, finding.evidenceExcerpt, finding.caveats]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function representativeFinding(findings: Finding[]): Finding {
  const sorted = [...findings].sort((a, b) => {
    const relevanceDelta = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    if (relevanceDelta !== 0) return relevanceDelta;
    const sourceDelta = b.sourceIds.length - a.sourceIds.length;
    if (sourceDelta !== 0) return sourceDelta;
    return a.claim.length - b.claim.length;
  });
  const representative = sorted[0];
  if (!representative) {
    throw new Error('Cannot choose a representative finding from an empty cluster');
  }
  return representative;
}

function methodForEdges(edges: FindingClusterEdge[]): FindingCluster['method'] {
  if (edges.some((edge) => edge.method === 'vector')) {
    return edges.some((edge) => edge.method === 'direct' || edge.method === 'lexical')
      ? 'hybrid'
      : 'vector';
  }
  if (edges.some((edge) => edge.method === 'direct')) return 'direct';
  if (edges.some((edge) => edge.method === 'lexical')) return 'lexical';
  return 'direct';
}

function relationCounts(edges: FindingClusterEdge[]): FindingCluster['relationCounts'] {
  const counts: Partial<Record<FindingClusterRelation, number>> = {};
  for (const edge of edges) {
    const { relation } = edge;
    counts[relation] = (counts[relation] ?? 0) + 1;
  }
  return counts;
}

function classifyEdge(
  method: FindingClusterEdge['method'],
  score: number,
  lexicalScore: number,
  anchorScore: number,
  discriminatorBridge: boolean,
  contradictionSignal: boolean,
): { relation: FindingClusterRelation; strength: FindingClusterEdgeStrength; bridge?: boolean } {
  if (contradictionSignal) {
    return { relation: 'contradicts', strength: 'weak', bridge: true };
  }
  if (method === 'direct' && !discriminatorBridge) {
    return { relation: 'same_claim', strength: 'strong' };
  }
  if (method === 'lexical' && score >= STRONG_LEXICAL_FLOOR && !discriminatorBridge) {
    return { relation: 'near_duplicate', strength: 'strong' };
  }
  if (
    method === 'vector' &&
    score >= DETERMINISTIC_MERGE_THRESHOLD &&
    lexicalScore >= STRONG_VECTOR_LEXICAL_FLOOR &&
    !discriminatorBridge
  ) {
    return { relation: 'near_duplicate', strength: 'strong' };
  }
  if (anchorScore > 0 && discriminatorBridge) {
    return { relation: 'elaborates', strength: 'weak', bridge: true };
  }
  return {
    relation: method === 'vector' ? 'supports' : 'elaborates',
    strength: 'weak',
    ...(discriminatorBridge ? { bridge: true } : {}),
  };
}

function shouldUnionEdge(edge: FindingClusterEdge): boolean {
  // Zone 1: Deterministic merge for very high cosine similarity (vector edges only)
  const semScore = edge.semanticScore;
  if (semScore !== undefined && semScore >= DETERMINISTIC_MERGE_THRESHOLD) {
    if (edge.relation === 'same_claim' || edge.relation === 'near_duplicate') return true;
  }
  // Zone 2: LLM review band — mark for LLM evaluation, do not union
  if (semScore !== undefined && semScore >= LLM_MERGE_BAND_LOWER) {
    edge.needsLlmReview = true;
    return false;
  }
  // Zone 3: Fall through to existing strength-based logic for lexical/direct edges
  return (
    edge.strength === 'strong' &&
    (edge.relation === 'same_claim' || edge.relation === 'near_duplicate')
  );
}

/**
 * Compute the maximum intra-cluster pairwise cosine distance.
 * Uses semanticScore from edges where available; returns 0 if no semantic scores exist.
 */
function computeMaxPairwiseDistance(findingIds: string[], edges: FindingClusterEdge[]): number {
  const idSet = new Set(findingIds);
  let maxDistance = 0;
  for (const edge of edges) {
    if (!idSet.has(edge.leftFindingId) || !idSet.has(edge.rightFindingId)) continue;
    if (edge.semanticScore !== undefined) {
      const distance = 1 - edge.semanticScore;
      if (distance > maxDistance) maxDistance = distance;
    }
  }
  return maxDistance;
}

/**
 * Greedy cluster-split algorithm.
 *
 * Starts with the first finding as centroid, gathers all findings whose cosine
 * distance to it is <= maxIntraDistance, then repeats on the remainder.
 */
function greedySplit(
  findingIds: string[],
  edges: FindingClusterEdge[],
  maxIntraDistance: number,
): string[][] {
  // Build distance lookup: findingId -> neighbor -> distance
  const distances = new Map<string, Map<string, number>>();
  for (const id of findingIds) distances.set(id, new Map<string, number>());

  for (const edge of edges) {
    const idSet = new Set(findingIds);
    if (!idSet.has(edge.leftFindingId) || !idSet.has(edge.rightFindingId)) continue;
    const score = edge.semanticScore ?? edge.score;
    const distance = 1 - Math.max(0, Math.min(1, score));
    distances.get(edge.leftFindingId)?.set(edge.rightFindingId, distance);
    distances.get(edge.rightFindingId)?.set(edge.leftFindingId, distance);
  }

  const remaining = new Set(findingIds);
  const clusters: string[][] = [];

  while (remaining.size > 0) {
    const iterator = remaining.values();
    const firstResult = iterator.next();
    if (firstResult.done) break;
    const centroid = firstResult.value;
    remaining.delete(centroid);

    const cluster = [centroid];
    const centroidDistances = distances.get(centroid) ?? new Map<string, number>();

    // Find all findings within maxIntraDistance of centroid
    const toRemove: string[] = [];
    for (const candidate of remaining) {
      const dist = centroidDistances.get(candidate);
      if (dist !== undefined && dist <= maxIntraDistance) {
        cluster.push(candidate);
        toRemove.push(candidate);
      }
    }

    for (const id of toRemove) remaining.delete(id);
    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Split oversized clusters where intra-cluster semantic variance exceeds threshold.
 *
 * For each cluster with size >= minSizeForSplit, computes the max pairwise
 * cosine distance. If it exceeds maxIntraDistance, the cluster is split using
 * a greedy centroid-based algorithm.
 */
export function splitOversizedClusters(
  clusters: FindingCluster[],
  options?: { maxIntraDistance?: number; minSizeForSplit?: number },
): FindingCluster[] {
  const maxIntraDistance = options?.maxIntraDistance ?? MAX_INTRA_CLUSTER_DISTANCE;
  const minSizeForSplit = options?.minSizeForSplit ?? MIN_CLUSTER_SIZE_FOR_SPLIT;

  const result: FindingCluster[] = [];

  for (const cluster of clusters) {
    if (cluster.findingIds.length < minSizeForSplit) {
      result.push(cluster);
      continue;
    }

    // Compute intra-cluster pairwise semantic distances
    const maxDistance = computeMaxPairwiseDistance(cluster.findingIds, cluster.edges);

    // No semantic scores available or all within threshold — keep as-is
    if (maxDistance <= maxIntraDistance) {
      result.push(cluster);
      continue;
    }

    // Split using greedy algorithm
    const subIdGroups = greedySplit(cluster.findingIds, cluster.edges, maxIntraDistance);

    // Build sub-clusters
    for (let i = 0; i < subIdGroups.length; i++) {
      const subIds = subIdGroups[i];
      if (!subIds || subIds.length === 0) continue;

      const subIdSet = new Set(subIds);
      const subEdges = cluster.edges.filter(
        (e) => subIdSet.has(e.leftFindingId) && subIdSet.has(e.rightFindingId),
      );

      const strongEdges = subEdges.filter((e) => e.strength === 'strong');
      const weakEdges = subEdges.filter((e) => e.strength === 'weak');
      const bridgeEdges = subEdges.filter((e) => e.bridge);

      const confidenceBase =
        strongEdges.length === 0
          ? subIds.length === 1
            ? 1
            : 0.55
          : strongEdges.reduce((sum, e) => sum + e.score, 0) / strongEdges.length;
      const confidence = bridgeEdges.length > 0 ? Math.min(confidenceBase, 0.72) : confidenceBase;

      result.push({
        id: `${cluster.id}-s${String(i + 1)}`,
        findingIds: subIds,
        representativeClaim: cluster.representativeClaim,
        method: methodForEdges(subEdges),
        confidence: Math.max(0, Math.min(1, confidence)),
        edges: subEdges,
        strongEdges,
        weakEdges,
        bridgeEdges,
        relationCounts: relationCounts(subEdges),
        mergeStatus: 'split',
        ...(bridgeEdges.length > 0
          ? {
              confidenceCapReason:
                'Cluster contains weak semantic bridge edges; synthesis must avoid treating all members as equivalent.',
            }
          : {}),
      });
    }
  }

  return result;
}

/**
 * Build a small, in-memory finding vector index and cluster graph.
 *
 * This intentionally keeps the first implementation boring: brute-force cosine over
 * the current job's embeddings rather than introducing a new service dependency.
 * It still follows the same vector-database shape (embed records → nearest-neighbour
 * candidate edges → transitive linkage) and can be swapped for HNSW/SQLite-vector
 * later if deep-research jobs grow beyond this scale.
 */
export function buildFindingLinkage(
  findings: Finding[],
  options: FindingLinkageOptions = {},
): FindingLinkageResult {
  const vectorThreshold = options.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD;
  const lexicalThreshold = options.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD;
  const directThreshold = options.directThreshold ?? DEFAULT_DIRECT_THRESHOLD;
  const maxEdgesPerFinding = options.maxEdgesPerFinding ?? DEFAULT_MAX_EDGES_PER_FINDING;
  const records = findings.map(recordText);
  const terms = records.map(termsFor);
  const anchors = records.map(anchorsFor);
  const discriminators = records.map(discriminatorsFor);
  const normalized = findings.map((finding) =>
    normalizeText(finding.normalizedClaim || finding.claim),
  );
  const edgesByKey = new Map<string, CandidateEdge>();
  const edgeCounts = new Map<string, number>();

  const addEdge = (
    leftIndex: number,
    rightIndex: number,
    method: FindingClusterEdge['method'],
    score: number,
    rationale: string,
    lexicalScore: number,
    anchorScore: number,
  ): void => {
    const left = findings[leftIndex];
    const right = findings[rightIndex];
    if (!left || !right || score <= 0) return;
    const currentLeftCount = edgeCounts.get(left.id) ?? 0;
    const currentRightCount = edgeCounts.get(right.id) ?? 0;
    if (currentLeftCount >= maxEdgesPerFinding || currentRightCount >= maxEdgesPerFinding) return;
    const key = edgeKey(left.id, right.id);
    const existing = edgesByKey.get(key);
    if (existing && existing.score >= score) return;
    const discriminatorBridge =
      discriminatorGap(
        discriminators[leftIndex] ?? new Set<string>(),
        discriminators[rightIndex] ?? new Set<string>(),
      ).length > 0;
    const relation = classifyEdge(
      method,
      score,
      lexicalScore,
      anchorScore,
      discriminatorBridge,
      hasContradictionSignal(left.claim, right.claim),
    );
    edgesByKey.set(key, {
      leftFindingId: left.id,
      rightFindingId: right.id,
      leftIndex,
      rightIndex,
      method,
      ...relation,
      score,
      rationale: `${rationale} Classified as ${relation.relation}/${relation.strength}.`,
      lexicalOverlap: lexicalScore,
      anchorOverlap: anchorScore,
      ...(method === 'vector' ? { semanticScore: score } : {}),
    });
    edgeCounts.set(left.id, currentLeftCount + 1);
    edgeCounts.set(right.id, currentRightCount + 1);
  };

  for (let left = 0; left < findings.length; left++) {
    for (let right = left + 1; right < findings.length; right++) {
      const anchorScore = overlapScore(
        anchors[left] ?? new Set<string>(),
        anchors[right] ?? new Set<string>(),
      );
      const lexicalScore = jaccard(
        terms[left] ?? new Set<string>(),
        terms[right] ?? new Set<string>(),
      );
      if (normalized[left] === normalized[right] && normalized[left] !== '') {
        addEdge(
          left,
          right,
          'direct',
          1,
          'Exact normalized-claim match.',
          lexicalScore,
          anchorScore,
        );
      } else if (anchorScore >= directThreshold && lexicalScore >= 0.25) {
        addEdge(
          left,
          right,
          'direct',
          Math.min(1, (anchorScore + lexicalScore) / 2),
          'Shared high-confidence entity/version/date anchors.',
          lexicalScore,
          anchorScore,
        );
      } else if (lexicalScore >= lexicalThreshold) {
        addEdge(
          left,
          right,
          'lexical',
          lexicalScore,
          'High lexical overlap after stop-word removal.',
          lexicalScore,
          anchorScore,
        );
      }

      const vectorScore = cosineSimilarity(options.embeddings?.[left], options.embeddings?.[right]);
      if (vectorScore >= vectorThreshold) {
        addEdge(
          left,
          right,
          'vector',
          vectorScore,
          'Nearest-neighbour match in the finding embedding index.',
          lexicalScore,
          anchorScore,
        );
      }
    }
  }

  const edges = [...edgesByKey.values()].sort((a, b) => b.score - a.score);
  const union = new UnionFind(findings.length);
  for (const edge of edges) {
    if (shouldUnionEdge(edge)) union.union(edge.leftIndex, edge.rightIndex);
  }

  const grouped = new Map<number, Finding[]>();
  for (let index = 0; index < findings.length; index++) {
    const root = union.find(index);
    const bucket = grouped.get(root) ?? [];
    const finding = findings[index];
    if (finding) bucket.push(finding);
    grouped.set(root, bucket);
  }

  const clusters: FindingCluster[] = [...grouped.values()].map(
    (clusterFindings: Finding[], index) => {
      const rep = representativeFinding(clusterFindings);
      const findingIds = new Set(clusterFindings.map((finding: Finding) => finding.id));
      const clusterEdges = edges.filter(
        (edge) => findingIds.has(edge.leftFindingId) && findingIds.has(edge.rightFindingId),
      );
      const publicEdges: FindingClusterEdge[] = clusterEdges.map((edge) => {
        const { leftIndex: _l, rightIndex: _r, ...edgeData } = edge;
        return edgeData;
      });
      const strongEdges = publicEdges.filter((edge) => edge.strength === 'strong');
      const weakEdges = publicEdges.filter((edge) => edge.strength === 'weak');
      const bridgeEdges = publicEdges.filter((edge) => edge.bridge);
      const confidenceBase =
        strongEdges.length === 0
          ? clusterFindings.length === 1
            ? 1
            : 0.55
          : strongEdges.reduce((sum, edge) => sum + edge.score, 0) / strongEdges.length;
      const confidence = bridgeEdges.length > 0 ? Math.min(confidenceBase, 0.72) : confidenceBase;
      return {
        id: `fc-${String(index + 1).padStart(3, '0')}`,
        findingIds: [...findingIds],
        representativeClaim: rep.claim,
        method: methodForEdges(publicEdges),
        confidence: Math.max(0, Math.min(1, confidence)),
        edges: publicEdges,
        strongEdges,
        weakEdges,
        bridgeEdges,
        relationCounts: relationCounts(publicEdges),
        ...(bridgeEdges.length > 0
          ? {
              confidenceCapReason:
                'Cluster contains weak semantic bridge edges; synthesis must avoid treating all members as equivalent.',
            }
          : {}),
      };
    },
  );

  // Apply cluster splitting and set mergeStatus
  const splitClusters = splitOversizedClusters(clusters);
  const finalClusters = splitClusters.map((cluster) => {
    if (cluster.mergeStatus === 'split') return cluster;
    const hasLlmReviewEdge = cluster.edges.some((e) => e.needsLlmReview);
    if (hasLlmReviewEdge) {
      return { ...cluster, mergeStatus: 'needs_llm_review' as const };
    }
    return { ...cluster, mergeStatus: 'auto_merged' as const };
  });

  return {
    clusters: finalClusters,
    edges: edges.map((edge) => {
      const { leftIndex: _l, rightIndex: _r, ...edgeData } = edge;
      return edgeData;
    }),
    usedVectorIndex:
      Array.isArray(options.embeddings) && options.embeddings.length === findings.length,
  };
}

export async function buildFindingLinkageWithEmbeddings(
  findings: Finding[],
  embedder: EmbeddingClient = embedTexts,
): Promise<FindingLinkageResult> {
  if (findings.length === 0) return buildFindingLinkage(findings);
  const bounded = findings.slice(0, DEFAULT_MAX_VECTOR_FINDINGS);
  try {
    const response = await embedder({
      texts: bounded.map(recordText),
      mode: 'document',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
    });
    const linked = buildFindingLinkage(bounded, { embeddings: response.embeddings });
    if (findings.length > DEFAULT_MAX_VECTOR_FINDINGS) {
      const fallback = buildFindingLinkage(findings.slice(DEFAULT_MAX_VECTOR_FINDINGS));
      const fallbackEdges = fallback.edges.map((e) => ({ ...e, needsLlmReview: false }));
      const fallbackClusters = fallback.clusters.map((cluster: FindingCluster, index: number) => ({
        ...cluster,
        id: `fc-${String(linked.clusters.length + index + 1).padStart(3, '0')}`,
      }));
      return {
        clusters: [...linked.clusters, ...fallbackClusters],
        edges: [...linked.edges, ...fallbackEdges],
        usedVectorIndex: true,
      };
    }
    return linked;
  } catch (err) {
    logger.debug(
      { err },
      'Finding vector linkage unavailable; using lexical/direct linkage fallback',
    );
    return buildFindingLinkage(findings);
  }
}

export function clusterIdByFindingId(clusters: FindingCluster[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cluster of clusters) {
    for (const findingId of cluster.findingIds) map.set(findingId, cluster.id);
  }
  return map;
}
