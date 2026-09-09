import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as http from 'node:http';
import { resolveHttpListenHost } from '../../src/server/httpBind.js';

test('default (unset) binds loopback only', () => {
  const t = resolveHttpListenHost(undefined);
  assert.equal(t.host, '127.0.0.1');
  assert.equal(t.exposure, 'loopback');
});

test('empty string binds loopback only', () => {
  const t = resolveHttpListenHost('');
  assert.equal(t.host, '127.0.0.1');
  assert.equal(t.exposure, 'loopback');
});

test('wildcard 0.0.0.0 is explicit network exposure', () => {
  const t = resolveHttpListenHost('0.0.0.0');
  assert.equal(t.host, '0.0.0.0');
  assert.equal(t.exposure, 'network');
});

test('wildcard :: is explicit network exposure', () => {
  const t = resolveHttpListenHost('::');
  assert.equal(t.host, '::');
  assert.equal(t.exposure, 'network');
});

test('bracketed [::] normalizes to :: network exposure', () => {
  const t = resolveHttpListenHost('[::]');
  assert.equal(t.host, '::');
  assert.equal(t.exposure, 'network');
});

test('loopback values keep loopback exposure', () => {
  for (const [input, host] of [
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
  ] as const) {
    const t = resolveHttpListenHost(input);
    assert.equal(t.host, host, input);
    assert.equal(t.exposure, 'loopback', input);
  }
});

test('other valid IP addresses are explicit network exposure', () => {
  for (const host of ['192.168.1.10', '10.0.0.1', '::2', '2001:db8::1']) {
    const t = resolveHttpListenHost(host);
    assert.equal(t.host, host, host);
    assert.equal(t.exposure, 'network', host);
  }
});

test('hostnames, host:port, URLs, and junk are rejected', () => {
  for (const bad of [
    'example.com',
    '0.0.0.0:80',
    '[::1]:8080',
    'http://0.0.0.0',
    'http://0.0.0.0:8080/',
    'not a host',
    '127.0.0.1;rm -rf',
    ':::1',
  ]) {
    assert.throws(() => resolveHttpListenHost(bad), Error, `should reject: ${bad}`);
  }
});

test('input is trimmed before classification', () => {
  assert.equal(resolveHttpListenHost(' 0.0.0.0 ').exposure, 'network');
  assert.equal(resolveHttpListenHost(' 127.0.0.1 ').host, '127.0.0.1');
});

test('resolved host is what the server actually binds', async () => {
  const t = resolveHttpListenHost(undefined);
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, t.host, () => resolve());
  });
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('docker-compose explicitly opts in to wildcard in-container bind', () => {
  const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
  assert.match(compose, /- HTTP_HOST=0\.0\.0\.0/);
});
