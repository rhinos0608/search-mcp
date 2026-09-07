import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type {
  FrozenCorpus,
  EvalManifest,
  Instant,
  FrozenDocument,
  EvalQuery,
  EvalLabel,
} from './types.js';
import { canonicalJson, sha256Hex, computeManifestHash } from './hashes.js';

// ---------------------------------------------------------------------------
// Freeze corpus
// ---------------------------------------------------------------------------

/** Sets status=freezing, fills manifestHash, deep-freezes the object graph. */
export function freezeCorpus(draft: FrozenCorpus, frozenAt: Instant): FrozenCorpus {
  const manifest = { ...draft.manifest, status: 'frozen' as const, frozenAt };

  // Recompute label content hashes BEFORE computing manifest hash
  manifest.labels = draft.labels.map((l, i) => ({
    labelId: manifest.labels[i]?.labelId ?? 'label-' + String(i),
    contentHash: sha256Hex(canonicalJson(l)),
  }));
  manifest.manifestHash = computeManifestHash(manifest);

  const frozen: FrozenCorpus = {
    manifest,
    documents: draft.documents,
    queries: draft.queries,
    labels: draft.labels,
  };

  return deepFreeze(frozen);
}

// ---------------------------------------------------------------------------
// Verify manifest
// ---------------------------------------------------------------------------

export function verifyManifest(corpus: FrozenCorpus): void {
  const { manifest } = corpus;

  // Frozen must have frozenAt
  if (manifest.status === 'frozen' && !manifest.frozenAt) {
    throw new Error('EVAL_INTEGRITY: frozen corpus missing frozenAt');
  }

  // Hash must match
  const computed = computeManifestHash(manifest);
  if (computed !== manifest.manifestHash) {
    throw new Error('EVAL_INTEGRITY: manifestHash mismatch');
  }

  // Splits must be disjoint on queryIds
  const trainSet = new Set(manifest.splits.train);
  const devSet = new Set(manifest.splits.dev);
  const testSet = new Set(manifest.splits.test);
  for (const qid of trainSet) {
    if (devSet.has(qid) || testSet.has(qid)) {
      throw new Error('EVAL_INTEGRITY: split overlap on queryId ' + qid);
    }
  }
  for (const qid of devSet) {
    if (testSet.has(qid)) {
      throw new Error('EVAL_INTEGRITY: split overlap on queryId ' + qid);
    }
  }
}

// ---------------------------------------------------------------------------
// Assert no leakage
// ---------------------------------------------------------------------------

export function assertNoLeakage(corpus: FrozenCorpus): void {
  const { manifest, queries } = corpus;

  // Build queryId → identityClusterId
  const queryMap = new Map(queries.map((q) => [q.queryId, q.identityClusterId]));

  // Check disjoint identity clusters across splits
  const trainClusters = new Set<string>();
  const testClusters = new Set<string>();
  for (const qid of manifest.splits.train) {
    const cid = queryMap.get(qid);
    if (cid) trainClusters.add(cid);
  }
  for (const qid of manifest.splits.test) {
    const cid = queryMap.get(qid);
    if (cid) {
      if (trainClusters.has(cid)) {
        throw new Error('EVAL_LEAKAGE: test query ' + qid + ' shares identityClusterId with train');
      }
      testClusters.add(cid);
    }
  }

  // Time order: test asOf >= every train asOf in same identity cluster
  const trainByCluster = new Map<string, string[]>();
  for (const qid of manifest.splits.train) {
    const q = queries.find((x) => x.queryId === qid);
    if (!q) continue;
    let arr = trainByCluster.get(q.identityClusterId);
    if (!arr) {
      arr = [];
      trainByCluster.set(q.identityClusterId, arr);
    }
    arr.push(q.asOf);
  }

  for (const qid of manifest.splits.test) {
    const q = queries.find((x) => x.queryId === qid);
    if (!q) continue;
    const trainAsOfs = trainByCluster.get(q.identityClusterId);
    if (!trainAsOfs) continue;
    for (const trainAsOf of trainAsOfs) {
      if (q.asOf < trainAsOf) {
        throw new Error(
          'EVAL_LEAKAGE: test query ' + qid + ' asOf ' + q.asOf + ' < train asOf ' + trainAsOf,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Load frozen corpus from disk
// ---------------------------------------------------------------------------

export function loadFrozenCorpus(rootDir: string, corpusId: string): FrozenCorpus {
  const corpusDir = path.join(rootDir, corpusId);
  const manifestPath = path.join(corpusDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('EVAL_LOAD: manifest not found at ' + manifestPath);
  }

  const manifest: EvalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as EvalManifest;

  // Verify manifest hash
  verifyManifest({ manifest, documents: [], queries: [], labels: [] });

  // Verify each document file hash
  for (const doc of manifest.documents) {
    const filePath = path.join(corpusDir, doc.fixturePath);
    if (!fs.existsSync(filePath)) {
      throw new Error('EVAL_LOAD: document file not found: ' + doc.fixturePath);
    }
    const bytes = fs.readFileSync(filePath);
    const fileHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    if (fileHash !== doc.contentHash) {
      throw new Error('EVAL_LOAD: contentHash mismatch for ' + doc.documentId);
    }
  }

  // Load documents, queries, labels from subdirectories
  const documents = loadJsonDir(path.join(corpusDir, 'documents')) as FrozenDocument[];
  const queries = loadJsonDir(path.join(corpusDir, 'queries')) as EvalQuery[];
  const labels = loadJsonDir(path.join(corpusDir, 'labels')) as EvalLabel[];

  return { manifest, documents, queries, labels };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJsonDir(dir: string): unknown[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return raw;
  });
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) deepFreeze(item);
  } else {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(val);
    }
  }
  return obj;
}
