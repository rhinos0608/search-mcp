import test from 'node:test';
import assert from 'node:assert/strict';

import { findElementByRef, refToLocator } from '../../src/browser/snapshot.js';
import { click, typeText, selectOption, hover, dragDrop, pressKey, scroll, evaluateJs, takeScreenshot, waitFor, resolveRefTarget } from '../../src/browser/actions.js';
import { extractStructured, extractByInstruction } from '../../src/browser/extraction.js';
import { startRequestTracking, listRequests, getRequestDetails, addRoute, removeRoute, setNetworkState } from '../../src/browser/network.js';
import { resolveCredentials, performLogin, BrowserCredentials } from '../../src/browser/credentials.js';
import type { SnapshotNode } from '../../src/browser/types.js';
import { BrowserError } from '../../src/browser/types.js';

// ── Helpers ──
function makeMockSnapshot(): SnapshotNode {
  return {
    ref: 'e1',
    role: 'document',
    name: 'Test Page',
    children: [
      {
        ref: 'e2',
        role: 'button',
        name: 'Submit',
        children: [],
      },
      {
        ref: 'e3',
        role: 'textbox',
        name: 'Email',
        children: [],
      },
    ],
  };
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

test('findElementByRef finds a node by ref', () => {
  const snapshot = makeMockSnapshot();
  const node = findElementByRef(snapshot, 'e2');
  assert.ok(node);
  assert.equal(node!.ref, 'e2');
  assert.equal(node!.name, 'Submit');
});

test('findElementByRef returns null for unknown ref', () => {
  const snapshot = makeMockSnapshot();
  const node = findElementByRef(snapshot, 'e999');
  assert.equal(node, null);
});

test('refToLocator throws for node without name/role', () => {
  const node: SnapshotNode = { ref: 'ex', role: '', name: '', children: [] };
  assert.throws(() => refToLocator({ locator: () => { throw new Error('mock'); } } as never, node));
});

// ── Credentials ──────────────────────────────────────────────────────────────

test('resolveCredentials matches by hostname', () => {
  const creds = { 'example.com': { username: 'user', password: 'pass' } };
  const result = resolveCredentials('https://example.com/page', creds);
  assert.ok(result);
  assert.equal(result!.username, 'user');
});

test('resolveCredentials matches subdomain', () => {
  const creds = { 'example.com': { username: 'user', password: 'pass' } };
  const result = resolveCredentials('https://app.example.com/page', creds);
  assert.ok(result);
  assert.equal(result!.username, 'user');
});

test('resolveCredentials returns null for no match', () => {
  const creds = { 'example.com': { username: 'user', password: 'pass' } };
  const result = resolveCredentials('https://other.com/page', creds);
  assert.equal(result, null);
});

// ── Extensions ───────────────────────────────────────────────────────────────

test('extractStructured and extractByInstruction are exported', () => {
  assert.equal(typeof extractStructured, 'function');
  assert.equal(typeof extractByInstruction, 'function');
});

// ── Network ──────────────────────────────────────────────────────────────────

test('listRequests returns empty array for untracked page', () => {
  // Page without tracking should return empty
  const mockPage = { url: () => 'about:blank' } as never;
  const requests = listRequests(mockPage);
  assert.deepEqual(requests, []);
});

test('getRequestDetails returns null for untracked page', () => {
  const mockPage = {} as never;
  const details = getRequestDetails(mockPage, 1);
  assert.equal(details, null);
});

test('setNetworkState is exported function', () => {
  assert.equal(typeof setNetworkState, 'function');
});

// ── Actions exports ──────────────────────────────────────────────────────────

test('all action functions are exported', () => {
  assert.equal(typeof click, 'function');
  assert.equal(typeof typeText, 'function');
  assert.equal(typeof selectOption, 'function');
  assert.equal(typeof hover, 'function');
  assert.equal(typeof dragDrop, 'function');
  assert.equal(typeof pressKey, 'function');
  assert.equal(typeof scroll, 'function');
  assert.equal(typeof evaluateJs, 'function');
  assert.equal(typeof takeScreenshot, 'function');
  assert.equal(typeof waitFor, 'function');
  assert.equal(typeof resolveRefTarget, 'function');
});

// ── Credentials exports ──────────────────────────────────────────────────────

test('performLogin is exported function', () => {
  assert.equal(typeof performLogin, 'function');
});

test('BrowserCredentials type exists', () => {
  // Just verify the type is usable — at runtime it's a plain object pattern
  const cred: BrowserCredentials = { username: 'u', password: 'p' };
  assert.equal(cred.username, 'u');
  assert.equal(cred.password, 'p');
});

// ── Network exports ──────────────────────────────────────────────────────────

test('startRequestTracking is exported function', () => {
  assert.equal(typeof startRequestTracking, 'function');
});

test('addRoute and removeRoute are exported functions', () => {
  assert.equal(typeof addRoute, 'function');
  assert.equal(typeof removeRoute, 'function');
});

// ── BrowserError ─────────────────────────────────────────────────────────────

test('BrowserError constructor and code property', () => {
  const err = new BrowserError('snapshot failed', 'ACTION_FAILED');
  assert.equal(err.name, 'BrowserError');
  assert.equal(err.code, 'ACTION_FAILED');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'snapshot failed');
});
