import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as http from 'node:http';
import { queryKeyAuthEnabled, redactRequestUrl, validateMcpKey } from '../../src/server/http.js';

function fakeRequest(opts: { url?: string; authorization?: string }): http.IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  return {
    headers,
    url: opts.url ?? '/mcp',
  } as unknown as http.IncomingMessage;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('queryKeyAuthEnabled: secure default is disabled', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: undefined }, () => {
    assert.equal(queryKeyAuthEnabled(), false);
  });
});

test('queryKeyAuthEnabled: only explicit true enables', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: 'true' }, () => {
    assert.equal(queryKeyAuthEnabled(), true);
  });
  for (const v of ['false', '1', 'yes', 'TRUE', '']) {
    withEnv({ MCP_ALLOW_QUERY_KEY: v }, () => {
      assert.equal(queryKeyAuthEnabled(), false, `value ${v} must not enable`);
    });
  }
});

test('query-param key auth denied by default', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: undefined }, () => {
    assert.equal(validateMcpKey(fakeRequest({ url: '/mcp?key=expected' }), 'expected'), false);
  });
});

test('query-param key auth denied when MCP_ALLOW_QUERY_KEY=false', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: 'false' }, () => {
    assert.equal(validateMcpKey(fakeRequest({ url: '/mcp?key=expected' }), 'expected'), false);
  });
});

test('query-param key auth allowed when explicitly opted in', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: 'true' }, () => {
    assert.equal(validateMcpKey(fakeRequest({ url: '/mcp?key=expected' }), 'expected'), true);
    assert.equal(validateMcpKey(fakeRequest({ url: '/mcp?key=wrong' }), 'expected'), false);
  });
});

test('Bearer header auth works regardless of query-key setting', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: undefined }, () => {
    assert.equal(
      validateMcpKey(fakeRequest({ authorization: 'Bearer expected' }), 'expected'),
      true,
    );
    assert.equal(validateMcpKey(fakeRequest({ authorization: 'Bearer wrong' }), 'expected'), false);
  });
  withEnv({ MCP_ALLOW_QUERY_KEY: 'false' }, () => {
    assert.equal(
      validateMcpKey(fakeRequest({ authorization: 'Bearer expected' }), 'expected'),
      true,
    );
  });
});

test('no apiKey configured denies everything', () => {
  withEnv({ MCP_ALLOW_QUERY_KEY: 'true' }, () => {
    assert.equal(validateMcpKey(fakeRequest({ url: '/mcp?key=expected' }), ''), false);
  });
});

test('redactRequestUrl removes secret query values', () => {
  for (const param of ['key', 'apiKey', 'token', 'secret', 'auth', 'api_key', 'api-key']) {
    const redacted = redactRequestUrl(`/mcp?${param}=supersecret&x=1`);
    assert.ok(!redacted.includes('supersecret'), `param ${param} must be redacted`);
    assert.ok(redacted.includes('/mcp'), 'pathname preserved');
    assert.ok(redacted.includes('x=1'), 'non-sensitive params preserved');
  }
});

test('redactRequestUrl handles absolute URLs and invalid input', () => {
  const redacted = redactRequestUrl('https://example.com/mcp?key=abc');
  assert.ok(!redacted.includes('abc=') || redacted.includes('key='), 'key param redacted');
  assert.ok(!redacted.includes('abc&'), 'secret value gone');
  // Invalid input must not throw
  assert.equal(typeof redactRequestUrl('not a url ??'), 'string');
});

test('docker-compose defaults query key auth off', () => {
  const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
  assert.match(compose, /MCP_ALLOW_QUERY_KEY=\$\{MCP_ALLOW_QUERY_KEY:-false\}/);
  assert.ok(!compose.includes(':-true'), 'compose must not default query key auth on');
});
