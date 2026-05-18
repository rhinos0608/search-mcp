import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKgDb, closeKgDb } from '../src/knowledge/store/db.js';
import { appendEvents } from '../src/knowledge/store/events.js';
import { rebuildProjection } from '../src/knowledge/store/projections.js';
import { queryNodes } from '../src/knowledge/store/projections.js';

const tempDirs: string[] = [];

afterEach(() => {
  closeKgDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initTempDb(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-projection-'));
  tempDirs.push(tempDir);
  initKgDb(path.join(tempDir, 'kg.sqlite'));
}

function appendNode(runId: string, nodeId: string, label: string): void {
  appendEvents([
    {
      timestamp: new Date().toISOString(),
      eventType: 'NODE_ADDED',
      eventVersion: 1,
      runId,
      batchId: null,
      actor: 'system',
      entityId: nodeId,
      entityType: 'concept',
      payload: JSON.stringify({
        node_id: nodeId,
        label,
        type: 'concept',
        extraction_confidence: 0.9,
        evidence_verbatim: 1,
      }),
      payloadHash: null,
    },
  ]);
}

function appendClaim(runId: string, nodeId: string, label: string, evidence: string): void {
  appendEvents([
    {
      timestamp: new Date().toISOString(),
      eventType: 'CLAIM_EXTRACTED',
      eventVersion: 1,
      runId,
      batchId: null,
      actor: 'system',
      entityId: nodeId,
      entityType: 'concept',
      payload: JSON.stringify({ label, type: 'concept', evidence }),
      payloadHash: null,
    },
  ]);
}

test('default projection rebuild preserves existing graph state after new events', () => {
  initTempDb();

  appendNode('run-1', 'node-1', 'First passive memory');
  rebuildProjection({});
  assert.equal(queryNodes({ label: 'First passive memory', limit: 5 }).nodes.length, 1);

  appendNode('run-2', 'node-2', 'Second passive memory');
  const result = rebuildProjection({});

  assert.equal(result.fromGenesis, true);
  assert.equal(queryNodes({ label: 'First passive memory', limit: 5 }).nodes.length, 1);
  assert.equal(queryNodes({ label: 'Second passive memory', limit: 5 }).nodes.length, 1);
});

test('projection search falls back from exact phrase to meaningful query terms', () => {
  initTempDb();

  appendNode('run-1', 'node-1', 'Distributed systems');
  appendNode('run-1', 'node-2', 'Cache invalidation');
  appendNode('run-1', 'node-3', 'Mechanistic interpretability');
  appendNode('run-1', 'node-4', 'Circuit analysis');
  appendNode('run-1', 'node-5', 'Message broker');
  appendClaim('run-1', 'node-5', 'Message broker', 'Queue backpressure increases consumer latency.');
  rebuildProjection({});

  const broad = queryNodes({ search: 'distributed cache', limit: 10 }).nodes.map((node) => node.label);
  assert.deepEqual(broad, ['Distributed systems', 'Cache invalidation']);

  const exact = queryNodes({ search: 'mechanistic interpretability', limit: 10 }).nodes.map((node) => node.label);
  assert.deepEqual(exact, ['Mechanistic interpretability']);

  const evidence = queryNodes({ search: 'queue latency', limit: 10 }).nodes.map((node) => node.label);
  assert.deepEqual(evidence, ['Message broker']);
});
