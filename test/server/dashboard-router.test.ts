import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { readBody, isHttps } from '../../src/server/dashboard-router.js';

// ── readBody tests ─────────────────────────────────────────────────────────

test('readBody: reads body within limit', async () => {
  const stream = Readable.from(['{"key":"value"}']);
  const result = await readBody(stream as unknown as http.IncomingMessage, 1024);
  assert.ok(result !== null);
  assert.equal(result.toString(), '{"key":"value"}');
});

test('readBody: returns null and stops reading over limit', async () => {
  const big = 'x'.repeat(100);
  const stream = Readable.from([big]);
  const result = await readBody(stream as unknown as http.IncomingMessage, 10);
  assert.equal(result, null);
});

// ── isHttps tests ──────────────────────────────────────────────────────────

/** Create a minimal mock IncomingMessage with just the fields isHttps needs. */
function mockReq(opts: {
  encrypted?: boolean;
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}): http.IncomingMessage {
  const socket = new EventEmitter() as http.IncomingMessage['socket'];
  (socket as unknown as Record<string, unknown>).remoteAddress = opts.remoteAddress ?? '127.0.0.1';
  (socket as unknown as Record<string, unknown>).encrypted = opts.encrypted ?? false;

  const req = new EventEmitter() as http.IncomingMessage;
  (req as unknown as Record<string, unknown>).socket = socket;
  req.headers = opts.headers ?? {};

  return req;
}

test('isHttps: returns true when socket is encrypted (direct TLS)', () => {
  const req = mockReq({ encrypted: true });
  assert.equal(isHttps(req), true);
});

test('isHttps: returns false for plain HTTP on loopback', () => {
  const req = mockReq({ encrypted: false, remoteAddress: '127.0.0.1' });
  assert.equal(isHttps(req), false);
});

test('isHttps: returns true when X-Forwarded-Proto is https from loopback (reverse proxy)', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(isHttps(req), true);
});

test('isHttps: returns true when X-Forwarded-Proto is https from ::1', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '::1',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(isHttps(req), true);
});

test('isHttps: returns true when X-Forwarded-Proto is https from ::ffff:127.0.0.1', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '::ffff:127.0.0.1',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(isHttps(req), true);
});

test('isHttps: ignores X-Forwarded-Proto from non-loopback address (spoofing defense)', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '192.168.1.100',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(isHttps(req), false);
});

test('isHttps: returns false when X-Forwarded-Proto is http from loopback', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'http' },
  });
  assert.equal(isHttps(req), false);
});

test('isHttps: returns false when X-Forwarded-Proto is missing from loopback', () => {
  const req = mockReq({
    encrypted: false,
    remoteAddress: '127.0.0.1',
  });
  assert.equal(isHttps(req), false);
});

test('isHttps: encrypted socket wins over any headers', () => {
  const req = mockReq({
    encrypted: true,
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'http' },
  });
  assert.equal(isHttps(req), true);
});
