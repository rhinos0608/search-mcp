import type { DedupeConfig } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DedupeLayer {
  name: 'url' | 'fingerprint' | 'semantic' | 'entityOverlap';
  removed: number;
  kept: number;
  timeMs: number;
}

export interface DedupeDecision<T> {
  item: T;
  kept: boolean;
  reason: 'unique' | 'duplicate' | 'preferred' | 'cap';
  duplicateOf?: string;
}

export interface DedupeGroup<T> {
  key: string;
  items: T[];
  selected: T;
  discarded: T[];
}

export interface DedupeResult<T> {
  items: T[];
  decisions: DedupeDecision<T>[];
  layers: DedupeLayer[];
  totalTimeMs: number;
}

// ── URL deduplication ────────────────────────────────────────────────────────

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.toLowerCase().trim());
    // Remove common tracking parameters
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'ref',
      'source',
      'utm_id',
      'tracking',
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }
    // Sort remaining params for consistency
    u.searchParams.sort();
    // Remove empty hash and trailing slash
    let normalized = u.toString();
    normalized = normalized.replace(/\/$/, '');
    return normalized;
  } catch {
    // If URL parsing fails, return trimmed lowercase version
    return url.toLowerCase().trim().replace(/\/$/, '');
  }
}

export function dedupeByUrl<T extends { url: string }>(
  items: T[],
  options?: { normalize?: boolean; removeTracking?: boolean },
): DedupeResult<T> {
  const startMs = performance.now();
  const doNormalize = options?.normalize !== false;
  const decisions: DedupeDecision<T>[] = [];
  const seen = new Map<string, T>();

  for (const item of items) {
    const key = doNormalize ? normalizeUrl(item.url) : item.url.toLowerCase().trim();
    if (seen.has(key)) {
      const first = seen.get(key);
      if (first) {
        decisions.push({
          item,
          kept: false,
          reason: 'duplicate',
          duplicateOf: first.url,
        });
      }
    } else {
      seen.set(key, item);
      decisions.push({
        item,
        kept: true,
        reason: 'unique',
      });
    }
  }

  const keptItems = decisions.filter((d) => d.kept).map((d) => d.item);
  const removed = items.length - keptItems.length;

  return {
    items: keptItems,
    decisions,
    layers: [
      {
        name: 'url',
        removed,
        kept: keptItems.length,
        timeMs: performance.now() - startMs,
      },
    ],
    totalTimeMs: performance.now() - startMs,
  };
}

// ── Fingerprint deduplication ───────────────────────────────────────────────

export function computeFingerprint(text: string): string {
  // Normalize text: lowercase, collapse whitespace
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

  // Generate character bigrams as a simple fingerprint
  const shingles = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    shingles.add(normalized.slice(i, i + 2));
  }

  return Array.from(shingles).sort().join('|');
}

function jaccardSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const setA = new Set(a.split('|'));
  const setB = new Set(b.split('|'));
  if (setA.size === 0 || setB.size === 0) return 0.0;

  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

export function dedupeByFingerprint<T extends { text: string; id: string }>(
  items: T[],
  threshold: number,
): DedupeResult<T> {
  const startMs = performance.now();
  const decisions: DedupeDecision<T>[] = [];
  const fingerprints = new Map<string, string>();
  const groups: DedupeGroup<T>[] = [];
  const assignedToGroup = new Set<string>();

  // Compute fingerprints
  for (const item of items) {
    fingerprints.set(item.id, computeFingerprint(item.text));
  }

  // Build similarity groups
  for (const item of items) {
    if (assignedToGroup.has(item.id)) continue;

    const groupItems: T[] = [item];
    const fpA = fingerprints.get(item.id);
    // Skip items with no fingerprint (e.g. empty/short texts)
    if (fpA === undefined || fpA === '') continue;

    for (const other of items) {
      if (other.id === item.id || assignedToGroup.has(other.id)) continue;
      const fpB = fingerprints.get(other.id);
      if (!fpB) continue;
      const sim = jaccardSimilarity(fpA, fpB);
      if (sim >= threshold) {
        groupItems.push(other);
      }
    }

    for (const gItem of groupItems) {
      assignedToGroup.add(gItem.id);
    }

    const selected = selectPreferred(groupItems, 'mostComplete');
    const discarded = groupItems.filter((i) => i.id !== (selected as { id: string }).id);

    groups.push({
      key: item.id,
      items: groupItems,
      selected,
      discarded,
    });
  }

  // Build decisions
  for (const group of groups) {
    for (const item of group.items) {
      const isSelected = item.id === (group.selected as { id: string }).id;
      const decision: DedupeDecision<T> = {
        item,
        kept: isSelected,
        reason: isSelected ? 'preferred' : 'duplicate',
      };
      if (!isSelected) {
        (decision as DedupeDecision<T> & { duplicateOf: string }).duplicateOf = (
          group.selected as { id: string }
        ).id;
      }
      decisions.push(decision);
    }
  }

  const keptItems = decisions.filter((d) => d.kept).map((d) => d.item);
  const removed = items.length - keptItems.length;

  return {
    items: keptItems,
    decisions,
    layers: [
      {
        name: 'fingerprint',
        removed,
        kept: keptItems.length,
        timeMs: performance.now() - startMs,
      },
    ],
    totalTimeMs: performance.now() - startMs,
  };
}

// ── Entity overlap deduplication ─────────────────────────────────────────────

/** Additional words that should not be considered entities despite passing length/case heuristics */
const ENTITY_GENERIC_WORDS = new Set([
  'have',
  'find',
  'give',
  'tell',
  'call',
  'try',
  'ask',
  'feel',
  'leave',
  'put',
  'mean',
  'keep',
  'let',
  'begin',
  'seem',
  'help',
  'show',
  'hear',
  'play',
  'run',
  'move',
  'live',
  'believe',
  'bring',
  'happen',
  'write',
  'provide',
  'sit',
  'stand',
  'lose',
  'pay',
  'meet',
  'include',
  'continue',
  'set',
  'learn',
  'change',
  'lead',
  'understand',
  'watch',
  'follow',
  'stop',
  'create',
  'speak',
  'read',
  'allow',
  'add',
  'grow',
  'open',
  'walk',
  'win',
  'offer',
  'remember',
  'love',
  'consider',
  'appear',
  'buy',
  'wait',
  'serve',
  'die',
  'send',
  'expect',
  'build',
  'stay',
  'fall',
  'cut',
  'reach',
  'kill',
  'remain',
  'you',
  'your',
  'our',
  'them',
  'their',
  'very',
  'still',
  'only',
  'any',
  'most',
  'other',
  'such',
  'same',
  'own',
  'too',
  'should',
  'may',
  'might',
  'must',
  'against',
  'between',
  'during',
  'before',
  'since',
  'while',
  'where',
  'when',
  'why',
  'which',
  'there',
  'then',
  'these',
  'those',
  'upon',
  'every',
  'each',
  'much',
  'many',
  'also',
  'than',
  'into',
  'over',
  'after',
  'just',
  'being',
  'having',
  'doing',
  'does',
  'done',
  'make',
  'made',
  'take',
  'took',
  'look',
  'seen',
  'need',
  'know',
  'used',
  'using',
  'based',
  'part',
  'high',
  'long',
  'few',
  'old',
  'big',
  'sure',
  'next',
  'last',
  'best',
  'good',
  'well',
  'come',
  'came',
  'turn',
  'gave',
  'work',
  'works',
  'want',
  'went',
  'hard',
  'easy',
  'less',
  'more',
  'able',
  'even',
  'ever',
  'still',
  'early',
  'late',
  'real',
  'life',
  'hand',
  'fact',
  'way',
  'day',
  'end',
  'right',
  'left',
  'top',
  'bottom',
  'side',
  'sort',
  'kind',
  'form',
  'part',
  'case',
  'area',
  'line',
  'type',
  'held',
  'told',
  'shown',
  'kept',
  'felt',
  'means',
  'seems',
  'often',
  'thus',
]);

const ENTITY_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'how',
  'is',
  'in',
  'of',
  'on',
  'and',
  'with',
  'from',
  'by',
  'at',
  'this',
  'that',
  'it',
  'what',
  'are',
  'do',
  'can',
  'his',
  'her',
  'he',
  'she',
  'its',
  'was',
  'has',
  'new',
  'just',
  'says',
  'said',
  'will',
  'about',
  'after',
  'now',
  'all',
  'been',
  'here',
  'not',
  'out',
  'up',
  'more',
  'also',
  'but',
  'who',
  'year',
  'first',
  'make',
  'being',
  'making',
  'over',
  'into',
  'than',
  'they',
  'their',
  'would',
  'could',
  'get',
  'got',
  'some',
  'like',
  'back',
  'going',
  'breaking',
  'https',
  'http',
  'www',
  'com',
]);

/**
 * Extract significant words (proper nouns, numbers, capitalized words) from text.
 * Used for cross-source entity overlap dedup where phrasing differs but entities overlap.
 */
export function extractEntities(text: string): Set<string> {
  const words = text.replace(/[^\w\s]/g, ' ').split(/\s+/);
  const entities = new Set<string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower) || ENTITY_GENERIC_WORDS.has(lower)) continue;
    // Keep words that are: capitalized (>=2 chars), ALL CAPS (>=2 chars),
    // contain digits, or 4+ chars. This preserves 2-char all-caps
    // abbreviations (AI, UK, EU) that were previously lost to length <= 2.
    const firstChar = word[0];
    const isAllCaps = word === word.toUpperCase();
    if (
      (firstChar?.toUpperCase() === firstChar && word.length >= 2) ||
      (isAllCaps && word.length >= 2) ||
      /\d/.test(word) ||
      word.length >= 4
    ) {
      entities.add(lower);
    }
  }
  return entities;
}

/**
 * Overlap coefficient (intersection / min set size).
 * Not Jaccard: a short tweet about the same event has fewer total entities
 * but high overlap with a longer post.
 */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const smaller = Math.min(a.size, b.size);
  return smaller > 0 ? intersection.size / smaller : 0;
}

/**
 * Dedup by entity overlap. Merges items sharing high entity overlap across
 * different URLs. Catches cases like "Reddit thread about Kanye West" +
 * "X post about Kanye West" with different URLs but same underlying story.
 * Only merges items with different URLs (same-URL dedup handled by URL layer).
 */
export function dedupeByEntityOverlap<T extends { id: string; text: string; url: string }>(
  items: T[],
  threshold = 0.45,
): DedupeResult<T> {
  const startMs = performance.now();
  const decisions: DedupeDecision<T>[] = [];
  const entityCache = new Map<string, Set<string>>();
  const assigned = new Set<string>();
  const groups: DedupeGroup<T>[] = [];

  // Pre-compute entity sets
  for (const item of items) {
    entityCache.set(item.id, extractEntities(item.text));
  }

  // Build overlap groups across different URLs
  for (const item of items) {
    if (assigned.has(item.id)) continue;

    const groupItems: T[] = [item];
    const entitiesA = entityCache.get(item.id);
    if (!entitiesA) continue;

    for (const other of items) {
      if (other.id === item.id || assigned.has(other.id)) continue;
      if (other.url === item.url) continue; // same URL: handled by Layer 1

      const entitiesB = entityCache.get(other.id);
      if (!entitiesB) continue;

      const overlap = overlapCoefficient(entitiesA, entitiesB);
      if (overlap >= threshold) {
        groupItems.push(other);
      }
    }

    // Only form a group if we found at least one overlap
    if (groupItems.length === 1) {
      decisions.push({
        item,
        kept: true,
        reason: 'unique',
      });
      assigned.add(item.id);
      continue;
    }

    for (const gItem of groupItems) {
      assigned.add(gItem.id);
    }

    // Select the longest text as preferred (most complete)
    groupItems.sort((a, b) => b.text.length - a.text.length);
    const [selected] = groupItems;
    if (!selected) continue;
    const discarded = groupItems.filter((i) => i.id !== selected.id);

    groups.push({
      key: item.id,
      items: groupItems,
      selected,
      discarded,
    });
  }

  // Build decisions for group items
  for (const group of groups) {
    for (const gItem of group.items) {
      const isSelected = gItem.id === (group.selected as { id: string }).id;
      if (isSelected) {
        decisions.push({
          item: gItem,
          kept: true,
          reason: 'preferred',
        });
      } else {
        decisions.push({
          item: gItem,
          kept: false,
          reason: 'duplicate',
          duplicateOf: (group.selected as { id: string }).id,
        });
      }
    }
  }

  // Items not in any group — already added as 'unique' above
  const keptItems = decisions.filter((d) => d.kept).map((d) => d.item);
  const removed = items.length - keptItems.length;

  return {
    items: keptItems,
    decisions,
    layers: [
      {
        name: 'entityOverlap',
        removed,
        kept: keptItems.length,
        timeMs: performance.now() - startMs,
      },
    ],
    totalTimeMs: performance.now() - startMs,
  };
}

/**
 * Cap items per author. Prevents any single author/handle from dominating.
 * Items without an author are always kept.
 */
export function capPerAuthor<T extends { author?: string; source?: string }>(
  items: T[],
  maxPerAuthor = 3,
): T[] {
  const authorCounts = new Map<string, number>();
  const result: T[] = [];

  for (const item of items) {
    const author = item.author?.trim().toLowerCase();
    if (author === undefined || author === '') {
      result.push(item);
      continue;
    }
    const count = authorCounts.get(author) ?? 0;
    if (count < maxPerAuthor) {
      result.push(item);
      authorCounts.set(author, count + 1);
    }
  }

  return result;
}

// ── Semantic deduplication ───────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) continue;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function clusterBySimilarity(embeddings: number[][], threshold: number): number[][] {
  const clusters: number[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < embeddings.length; i += 1) {
    if (assigned.has(i)) continue;

    const cluster: number[] = [i];
    assigned.add(i);

    for (let j = i + 1; j < embeddings.length; j += 1) {
      if (assigned.has(j)) continue;
      const embI = embeddings[i];
      const embJ = embeddings[j];
      if (!embI || !embJ) continue;
      const sim = cosineSimilarity(embI, embJ);
      if (sim >= threshold) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

export async function dedupeBySemantic<
  T extends {
    id: string;
    text: string;
    embedding?: number[];
  },
>(
  items: T[],
  threshold: number,
  embedFn?: (texts: string[]) => Promise<number[][]>,
): Promise<DedupeResult<T>> {
  const startMs = performance.now();

  // Gather embeddings
  const itemsNeedingEmbed = items.filter((i) => !i.embedding);

  if (itemsNeedingEmbed.length > 0) {
    if (!embedFn) {
      throw new Error('embedFn is required when items lack embeddings');
    }
    const newEmbeddings = await embedFn(itemsNeedingEmbed.map((i) => i.text));
    for (let idx = 0; idx < itemsNeedingEmbed.length; idx += 1) {
      const emb = newEmbeddings[idx];
      const item = itemsNeedingEmbed[idx];
      if (emb !== undefined && item) {
        item.embedding = emb;
      }
    }
  }

  const embeddings: number[][] = [];
  for (const item of items) {
    if (!item.embedding) {
      throw new Error(`Item ${item.id} is missing embedding after generation`);
    }
    embeddings.push(item.embedding);
  }

  const clusters = clusterBySimilarity(embeddings, threshold);
  const decisions: DedupeDecision<T>[] = [];

  for (const cluster of clusters) {
    const clusterItems = cluster.map((idx) => {
      const item = items[idx];
      if (!item) {
        throw new Error(`Invalid cluster index: ${String(idx)}`);
      }
      return item;
    });
    const selected = selectPreferred(clusterItems, 'mostComplete');

    for (const item of clusterItems) {
      const isSelected = item.id === (selected as { id: string }).id;
      const decision: DedupeDecision<T> = {
        item,
        kept: isSelected,
        reason: isSelected ? 'preferred' : 'duplicate',
      };
      if (!isSelected) {
        (decision as DedupeDecision<T> & { duplicateOf: string }).duplicateOf = (
          selected as { id: string }
        ).id;
      }
      decisions.push(decision);
    }
  }

  const keptItems = decisions.filter((d) => d.kept).map((d) => d.item);
  const removed = items.length - keptItems.length;

  return {
    items: keptItems,
    decisions,
    layers: [
      {
        name: 'semantic',
        removed,
        kept: keptItems.length,
        timeMs: performance.now() - startMs,
      },
    ],
    totalTimeMs: performance.now() - startMs,
  };
}

// ── Preferred selection ──────────────────────────────────────────────────────

export function selectPreferred<T>(
  items: T[],
  strategy: 'newest' | 'mostComplete' | 'highestScore',
  scoreFn?: (item: T) => number,
): T {
  if (items.length === 0) {
    throw new Error('Cannot select preferred from empty array');
  }
  if (items.length === 1) {
    const [only] = items;
    if (!only) {
      throw new Error('Cannot select preferred from empty array');
    }
    return only;
  }

  switch (strategy) {
    case 'newest': {
      const [last] = items.slice(-1);
      if (!last) {
        throw new Error('Cannot select preferred from empty array');
      }
      return last;
    }

    case 'mostComplete': {
      // Use text length as a proxy for completeness
      const scored = items.map((item) => {
        const text = (item as Record<string, unknown>).text;
        const length = typeof text === 'string' ? text.length : 0;
        return { item, length };
      });
      scored.sort((a, b) => b.length - a.length);
      const [best] = scored;
      if (!best) {
        throw new Error('Cannot select preferred from empty array');
      }
      return best.item;
    }

    case 'highestScore': {
      if (!scoreFn) {
        throw new Error('scoreFn is required for highestScore strategy');
      }
      const scored = items.map((item) => ({ item, score: scoreFn(item) }));
      scored.sort((a, b) => b.score - a.score);
      const [best] = scored;
      if (!best) {
        throw new Error('Cannot select preferred from empty array');
      }
      return best.item;
    }

    default: {
      const [last] = items.slice(-1);
      if (!last) {
        throw new Error('Cannot select preferred from empty array');
      }
      return last;
    }
  }
}

// ── Main deduplication pipeline ──────────────────────────────────────────────

export async function deduplicateCorpus<
  T extends {
    url: string;
    text: string;
    id: string;
    embedding?: number[];
    author?: string;
    source?: string;
  },
>(
  items: T[],
  config: DedupeConfig,
  embedFn?: (texts: string[]) => Promise<number[][]>,
): Promise<DedupeResult<T>> {
  const pipelineStartMs = performance.now();
  const allDecisions = new Map<string, DedupeDecision<T>>();
  const allLayers: DedupeLayer[] = [];

  let currentItems = [...items];

  // Layer 1: URL
  if (config.layers.url) {
    const urlResult = dedupeByUrl(currentItems, {
      normalize: true,
      removeTracking: true,
    });
    allLayers.push(...urlResult.layers);
    for (const d of urlResult.decisions) {
      const id = (d.item as { id: string }).id;
      allDecisions.set(id, d);
    }
    currentItems = urlResult.items;
  }

  // Layer 2: Fingerprint
  if (config.layers.fingerprint) {
    const fpResult = dedupeByFingerprint(currentItems, config.fingerprintThreshold);
    allLayers.push(...fpResult.layers);
    for (const d of fpResult.decisions) {
      const id = (d.item as { id: string }).id;
      // Only update if this item survived previous layer
      if (d.kept || allDecisions.get(id)?.kept) {
        allDecisions.set(id, d);
      }
    }
    currentItems = fpResult.items;
  }

  // Layer 3: Semantic
  if (config.layers.semantic) {
    const semResult = await dedupeBySemantic(currentItems, config.semanticThreshold, embedFn);
    allLayers.push(...semResult.layers);
    for (const d of semResult.decisions) {
      const id = (d.item as { id: string }).id;
      if (d.kept || allDecisions.get(id)?.kept) {
        allDecisions.set(id, d);
      }
    }
    currentItems = semResult.items;
  }

  // Layer 4: Entity overlap (cross-source)
  if (config.layers.entityOverlap) {
    const entityResult = dedupeByEntityOverlap(currentItems);
    allLayers.push(...entityResult.layers);
    for (const d of entityResult.decisions) {
      const id = (d.item as { id: string }).id;
      if (d.kept || allDecisions.get(id)?.kept) {
        allDecisions.set(id, d);
      }
    }
    currentItems = entityResult.items;
  }

  // Optional post-processing: per-author cap
  if (config.maxPerAuthor !== undefined) {
    const beforeIds = new Set(currentItems.map((i) => (i as { id: string }).id));
    const authorItems = currentItems as unknown as { author?: string; source?: string }[];
    const capped = capPerAuthor(authorItems, config.maxPerAuthor);
    currentItems = capped as unknown as T[];
    // Track cap-removed items so decisions stay consistent with items
    const afterIds = new Set(currentItems.map((i) => (i as { id: string }).id));
    for (const item of items) {
      const itemId = (item as { id: string }).id;
      if (beforeIds.has(itemId) && !afterIds.has(itemId)) {
        allDecisions.set(itemId, { item, kept: false, reason: 'cap' });
      }
    }
  }

  // Rebuild consistent decisions for all original items
  const finalDecisions: DedupeDecision<T>[] = items.map((item) => {
    const id = item.id;
    const existing = allDecisions.get(id);
    if (existing) return existing;

    // Item was removed in a layer not tracked above
    return {
      item,
      kept: false,
      reason: 'duplicate',
    };
  });

  // For items that are kept but have no explicit decision, set to unique.
  // Also fix cap-removed items that may still show kept=true from prior layers.
  const keptSet = new Set(currentItems.map((i) => (i as { id: string }).id));
  for (const d of finalDecisions) {
    if (keptSet.has((d.item as { id: string }).id) && !d.kept) {
      d.kept = true;
      d.reason = 'unique';
    }
  }
  // Ensure cap-removed items are marked as not kept regardless of prior layers
  for (const d of finalDecisions) {
    if (d.reason === 'cap' && d.kept) {
      d.kept = false;
    }
  }

  return {
    items: currentItems,
    decisions: finalDecisions,
    layers: allLayers,
    totalTimeMs: performance.now() - pipelineStartMs,
  };
}
