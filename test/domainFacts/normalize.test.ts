import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain } from '../../src/domainFacts/normalize.js';

test('normalizes case, www, trailing dot, whitespace', () => {
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain('  Example.COM. '), 'example.com');
  assert.equal(normalizeDomain('www.example.com'), 'example.com');
  assert.equal(normalizeDomain('WWW.Example.com.'), 'example.com');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
});

test('reduces URLs to their hostname', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('http://a.b.example.com/x'), 'a.b.example.com');
});

test('preserves child hosts', () => {
  assert.equal(normalizeDomain('a.b.example.com'), 'a.b.example.com');
});

test('deterministically punycodes IDNs', () => {
  assert.equal(normalizeDomain('täst.de'), 'xn--tst-qla.de');
  assert.equal(normalizeDomain('xn--tst-qla.de'), 'xn--tst-qla.de');
});

test('rejects IP addresses', () => {
  assert.equal(normalizeDomain('192.168.0.1'), null);
  assert.equal(normalizeDomain('2001:db8::1'), null);
  assert.equal(normalizeDomain('[2001:db8::1]'), null);
});

test('rejects ports, paths, queries', () => {
  assert.equal(normalizeDomain('example.com:8080'), null);
  assert.equal(normalizeDomain('example.com/path'), null);
  assert.equal(normalizeDomain('example.com?q=1'), null);
});

test('rejects wildcards', () => {
  assert.equal(normalizeDomain('*.example.com'), null);
  assert.equal(normalizeDomain('*'), null);
});

test('rejects bare TLDs and PSL-like entries', () => {
  assert.equal(normalizeDomain('com'), null);
  assert.equal(normalizeDomain('org'), null);
  assert.equal(normalizeDomain('co.uk'), null);
  assert.equal(normalizeDomain('ac.uk'), null);
  assert.equal(normalizeDomain('com.au'), null);
});

test('rejects malformed labels', () => {
  assert.equal(normalizeDomain('example..com'), null);
  assert.equal(normalizeDomain('-example.com'), null);
  assert.equal(normalizeDomain('example-.com'), null);
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(null as unknown as string), null);
});
