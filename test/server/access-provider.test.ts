import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, classifyRequestOrigin, buildMcpConnectionUrl } from '../../src/server/access-provider.js';
import type { ExternalAccessProvider } from '../../src/server/access-provider.js';

// --- normalizeBaseUrl ---
test('normalizeBaseUrl: valid https URL', () => {
  const r = normalizeBaseUrl('https://example.com');
  assert.deepEqual(r, { ok: true, url: 'https://example.com' });
});
test('normalizeBaseUrl: strips trailing slash', () => {
  const r = normalizeBaseUrl('https://example.com/');
  assert.deepEqual(r, { ok: true, url: 'https://example.com' });
});
test('normalizeBaseUrl: rejects path', () => {
  const r = normalizeBaseUrl('https://example.com/mcp');
  assert.equal(r.ok, false);
});
test('normalizeBaseUrl: rejects credentials', () => {
  const r = normalizeBaseUrl('https://user:pass@example.com');
  assert.equal(r.ok, false);
});
test('normalizeBaseUrl: rejects query string', () => {
  const r = normalizeBaseUrl('https://example.com?foo=bar');
  assert.equal(r.ok, false);
});
test('normalizeBaseUrl: rejects non-http scheme', () => {
  const r = normalizeBaseUrl('ftp://example.com');
  assert.equal(r.ok, false);
});

// --- classifyRequestOrigin ---
test('classifyRequestOrigin: loopback address → loopback', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as never;
  assert.equal(classifyRequestOrigin(req), 'loopback');
});
test('classifyRequestOrigin: ::1 → loopback', () => {
  const req = { socket: { remoteAddress: '::1' }, headers: {} } as never;
  assert.equal(classifyRequestOrigin(req), 'loopback');
});
test('classifyRequestOrigin: loopback + tailscale header → tailscale_serve', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-tailscale-user': 'alice@example.com' },
  } as never;
  assert.equal(classifyRequestOrigin(req), 'tailscale_serve');
});
test('classifyRequestOrigin: non-loopback → public', () => {
  const req = { socket: { remoteAddress: '1.2.3.4' }, headers: {} } as never;
  assert.equal(classifyRequestOrigin(req), 'public');
});

// --- buildMcpConnectionUrl ---
test('buildMcpConnectionUrl: appends /mcp', () => {
  const p = { baseUrl: 'https://example.com' } as ExternalAccessProvider;
  assert.equal(buildMcpConnectionUrl(p), 'https://example.com/mcp');
});
