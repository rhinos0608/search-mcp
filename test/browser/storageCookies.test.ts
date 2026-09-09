import test from 'node:test';
import assert from 'node:assert/strict';
import type { Cookie } from 'playwright-core';
import { projectCookies } from '../../src/browser/cookieProjection.js';

function makeCookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: 'session',
    value: 'super-secret-cookie-value',
    domain: '.example.com',
    path: '/',
    expires: 1735689600,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides,
  } as unknown as Cookie;
}

test('default projection omits cookie value and marks redaction', () => {
  const [out] = projectCookies([makeCookie()], false);
  assert.ok(out);
  assert.equal('value' in out, false);
  assert.equal(out.valueRedacted, true);
  assert.equal(out.name, 'session');
  assert.equal(out.domain, '.example.com');
  assert.equal(out.path, '/');
  assert.equal(out.expires, 1735689600);
  assert.equal(out.httpOnly, true);
  assert.equal(out.secure, true);
  assert.equal(out.sameSite, 'Lax');
});

test('default projection never leaks value even for malformed cookies', () => {
  const out = projectCookies(
    [makeCookie({ value: 'Authorization=Bearer abc; path=/' }), makeCookie({ name: 'x' })],
    false,
  );
  const json = JSON.stringify(out);
  assert.ok(!json.includes('super-secret-cookie-value'));
  assert.ok(!json.includes('Bearer abc'));
  for (const c of out) {
    assert.equal('value' in c, false);
    assert.equal(c.valueRedacted, true);
  }
});

test('explicit includeValues returns actual values without redaction marker', () => {
  const [out] = projectCookies([makeCookie()], true);
  assert.ok(out);
  assert.equal(out.value, 'super-secret-cookie-value');
  assert.equal('valueRedacted' in out, false);
});

test('empty cookie list projects to empty list for both modes', () => {
  assert.deepEqual(projectCookies([], false), []);
  assert.deepEqual(projectCookies([], true), []);
});
