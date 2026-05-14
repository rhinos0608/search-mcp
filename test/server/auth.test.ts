import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, LoginRateLimiter, parseCookieHeader, getCookieName } from '../../src/server/auth.js';

test('SessionStore: create and validate session', () => {
  const store = new SessionStore(60_000);
  const s = store.create();
  assert.ok(store.validate(s.id));
  store.destroy();
});

test('SessionStore: expired session is invalid', () => {
  const store = new SessionStore(1); // 1ms TTL
  const s = store.create();
  // Force expiry
  s.expiresAt = Date.now() - 1;
  assert.equal(store.validate(s.id), false);
  store.destroy();
});

test('SessionStore: revoke removes session', () => {
  const store = new SessionStore(60_000);
  const s = store.create();
  store.revoke(s.id);
  assert.equal(store.validate(s.id), false);
  store.destroy();
});

test('SessionStore: revokeAll clears all sessions', () => {
  const store = new SessionStore(60_000);
  const a = store.create();
  const b = store.create();
  store.revokeAll();
  assert.equal(store.validate(a.id), false);
  assert.equal(store.validate(b.id), false);
  store.destroy();
});

test('LoginRateLimiter: allows requests below threshold', () => {
  const rl = new LoginRateLimiter();
  for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
  assert.deepEqual(rl.check('1.2.3.4'), { allowed: true });
});

test('LoginRateLimiter: blocks after maxFailures', () => {
  const rl = new LoginRateLimiter();
  for (let i = 0; i < 10; i++) rl.recordFailure('1.2.3.4');
  const r = rl.check('1.2.3.4');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter !== undefined && r.retryAfter > 0);
});

test('LoginRateLimiter: recordSuccess resets counter', () => {
  const rl = new LoginRateLimiter();
  for (let i = 0; i < 9; i++) rl.recordFailure('1.2.3.4');
  rl.recordSuccess('1.2.3.4');
  assert.deepEqual(rl.check('1.2.3.4'), { allowed: true });
});

test('parseCookieHeader: extracts session id', () => {
  const id = parseCookieHeader('smcp-session=abc123; other=xyz', 'smcp-session');
  assert.equal(id, 'abc123');
});

test('getCookieName: uses __Host- prefix on HTTPS', () => {
  assert.equal(getCookieName(true), '__Host-smcp-session');
  assert.equal(getCookieName(false), 'smcp-session');
});
