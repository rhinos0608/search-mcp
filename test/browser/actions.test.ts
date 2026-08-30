import test from 'node:test';
import assert from 'node:assert/strict';

import { findElementByRef, refToLocator } from '../../src/browser/snapshot.js';
import {
  click,
  typeText,
  selectOption,
  hover,
  dragDrop,
  pressKey,
  scroll,
  evaluateJs,
  takeScreenshot,
  waitFor,
  resolveRefTarget,
} from '../../src/browser/actions.js';
import { extractStructured, extractByInstruction } from '../../src/browser/extraction.js';
import {
  startRequestTracking,
  listRequests,
  getRequestDetails,
  addRoute,
  removeRoute,
  setNetworkState,
  redactBody,
  sanitizeUrl,
  redactHeaders,
} from '../../src/browser/network.js';

const S1 = '__INERT_PW_111__';
const S2 = '__INERT_TOKEN_222__';
const S3 = '__INERT_SIG_333__';
const S4 = '__INERT_SESS_444__';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
import {
  resolveCredentials,
  performLogin,
  BrowserCredentials,
} from '../../src/browser/credentials.js';
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
  assert.throws(() =>
    refToLocator(
      {
        locator: () => {
          throw new Error('mock');
        },
      } as never,
      node,
    ),
  );
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

// ── Redaction regressions (inert sentinels) ─────────────────────────────────
test('redacts nested valid JSON', () => {
  const body = JSON.stringify({
    outer: { password: S1, inner: { accessToken: S2, safe: 'keep' } },
    array: [{ clientSecret: S1 }],
  });
  const redacted = redactBody(body)!;
  assert.ok(!redacted.includes(S1));
  assert.ok(!redacted.includes(S2));
  assert.ok(redacted.includes('•••'));
  assert.ok(redacted.includes('keep'));
  assert.doesNotThrow(() => JSON.parse(redacted));
});

test('malformed JSON returns whole-body REDACTED', () => {
  const body = `{"password":"${S1}"`;
  const redacted = redactBody(body)!;
  assert.equal(redacted, '•••');
  assert.ok(!redacted.includes(S1));
});

test('truncated JSON returns REDACTED', () => {
  const full = JSON.stringify({ passwordHash: S1, refreshToken: S2, data: 'x'.repeat(5000) });
  const truncated = full.slice(0, 4000);
  const redacted = redactBody(truncated)!;
  assert.equal(redacted, '•••');
});

test('multipart returns REDACTED', () => {
  const body = `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\nContent-Disposition: form-data; name="password"\r\n\r\n${S1}\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--`;
  assert.equal(redactBody(body), '•••');
});

test('redacts urlencoded sensitive values including camelCase', () => {
  const body = `username=alice&passwordHash=${S1}&accessToken=${S2}&userPassword=${S3}&safe=keep`;
  const redacted = redactBody(body)!;
  assert.ok(!redacted.includes(S1));
  assert.ok(!redacted.includes(S2));
  assert.ok(redacted.includes('safe=keep'));
});

test('redacts colon/equal key forms in plain bodies', () => {
  const body = `userPassword: ${S1} \n token = ${S2}`;
  const redacted = redactBody(body)!;
  assert.ok(!redacted.includes(S1));
  assert.ok(!redacted.includes(S2));
});

test('redacts plain Bearer and JWT', () => {
  const body = `Authorization: Bearer ${S1} and ${JWT}`;
  const redacted = redactBody(body)!;
  assert.ok(!redacted.includes(S1));
  assert.ok(!redacted.includes(JWT));
  assert.ok(redacted.includes('•••'));
});

test('keeps safe text useful', () => {
  const body = 'hello world this is safe text';
  assert.equal(redactBody(body), body);
});

test('redacts case-insensitive headers including camelCase', () => {
  const headers = {
    Cookie: `a=${S1}`,
    AUTHORIZATION: `Bearer ${S1}`,
    'X-Access-Token': S2,
    clientSecret: S3,
    'x-amz-signature': S3,
    'Safe-Header': 'keep',
  } as Record<string, string>;
  const out = redactHeaders(headers);
  assert.equal(out['Cookie'], '•••');
  assert.equal(out['AUTHORIZATION'], '•••');
  assert.equal(out['X-Access-Token'], '•••');
  assert.equal(out['clientSecret'], '•••');
  assert.equal(out['Safe-Header'], 'keep');
});

test('sanitizeUrl redacts credentials and query tokens including camelCase', () => {
  const url = `https://user:${S1}@example.com/path?accessToken=${S2}&clientSecret=${S3}&sessionId=${S4}&safe=keep`;
  const sanitized = sanitizeUrl(url);
  assert.ok(!sanitized.includes(S1));
  assert.ok(!sanitized.includes(S2));
  assert.ok(!sanitized.includes(S3));
  assert.ok(sanitized.includes('safe=keep'));
});

test('malformed URL fails closed', () => {
  const bad = 'http://[invalid';
  assert.equal(sanitizeUrl(bad), '•••');
});

test('defensive getRequestDetails re-applies redaction and is non-vacuous', async () => {
  const handlers: Record<string, Function[]> = {};
  const fakePage: any = {
    on: (ev: string, h: Function) => {
      (handlers[ev] ||= []).push(h);
    },
    off: (ev: string, h: Function) => {
      handlers[ev] = (handlers[ev] || []).filter((x) => x !== h);
    },
  };
  startRequestTracking(fakePage);
  const mockRequest: any = {
    method: () => 'POST',
    url: () => `https://example.com/api?accessToken=${S2}`,
    headers: () => ({ authorization: `Bearer ${S1}`, 'x-safe': 'keep' }),
    postData: () => `passwordHash=${S1}`,
    response: () =>
      Promise.resolve({
        status: () => 200,
        headers: () => ({ 'set-cookie': S1 }),
        body: () =>
          Promise.resolve(Buffer.from(JSON.stringify({ refreshToken: S1, safe: 'keep' }))),
      }),
  };
  (handlers['request']?.[0] as Function)(mockRequest);
  await new Promise<void>((r) => setTimeout(r, 60));
  const detail = getRequestDetails(fakePage, 1);
  assert.ok(detail, 'detail should exist');
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes(S1), 'sentinel S1 leaked');
  assert.ok(!serialized.includes(S2), 'sentinel S2 leaked');
  assert.ok(
    detail!.requestHeaders['x-safe'] === 'keep' ||
      detail!.requestHeaders['X-Safe'] === 'keep' ||
      serialized.includes('keep'),
  );
  assert.ok(!detail!.requestBody?.includes(S1));
});

test('sanitizeUrl and redactBody handle JWT and Bearer in URL/body', () => {
  const jwtBody = `token=${JWT}`;
  const redacted = redactBody(jwtBody)!;
  assert.ok(!redacted.includes(JWT));
  assert.ok(redacted.includes('•••'));
  const bearerBody = `Authorization: Bearer ${S1}`;
  const redactedBearer = redactBody(bearerBody)!;
  assert.ok(!redactedBearer.includes(S1));
  assert.ok(redactedBearer.includes('•••'));
});
