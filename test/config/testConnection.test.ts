import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';
import { resetConfig } from '../../src/config.js';
import type { SafeFetchOptions } from '../../src/httpGuards.js';

type RequestMock = NonNullable<SafeFetchOptions['request']>;
type ResolverMock = NonNullable<SafeFetchOptions['resolver']>;

const PUBLIC_IP = '93.184.216.34';
const publicResolver: ResolverMock = async () => [{ address: PUBLIC_IP, family: 4 }];
const loopbackResolver: ResolverMock = async () => [{ address: '127.0.0.1', family: 4 }];

function okResponse(status = 200): ReturnType<RequestMock> {
  return Promise.resolve({
    statusCode: status,
    statusMessage: 'OK',
    headers: {},
    body: new Uint8Array(),
  });
}

function redirectResponse(location: string): ReturnType<RequestMock> {
  return Promise.resolve({
    statusCode: 302,
    statusMessage: 'Found',
    headers: { location },
    body: new Uint8Array(),
  });
}

function makeManager(): { mgr: ConfigManager; dir: string; cfg: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-testconn-'));
  process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
  resetConfig();
  const mgr = new ConfigManager({ configDir: dir });
  mgr.load();
  // Hermetic: clear provider fields that repo config.json / env may populate.
  const cfg = mgr.get() as unknown as Record<string, unknown>;
  cfg.brave = { apiKey: '' };
  cfg.searxng = { baseUrl: '' };
  cfg.crawl4ai = { baseUrl: '', apiToken: '' };
  return { mgr, dir, cfg };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true });
  delete process.env['SEARCH_MCP_CONFIG_KEY'];
  resetConfig();
}

test('searxng: public hostname with public DNS answer succeeds', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: 'http://example.test' };
    let requests = 0;
    const result = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: (options) => {
        requests++;
        assert.equal(options.path, '/healthz');
        return okResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(requests, 1);
    assert.equal(typeof result.latencyMs, 'number');
  } finally {
    cleanup(dir);
  }
});

test('crawl4ai: allowlisted loopback sidecar succeeds', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { crawl4ai: { baseUrl: string } }).crawl4ai = { baseUrl: 'http://127.0.0.1:8080' };
    let requests = 0;
    const result = await mgr.testConnection('crawl4ai', {
      resolver: loopbackResolver,
      request: (options) => {
        requests++;
        assert.equal(options.path, '/health');
        return okResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requests, 1);
  } finally {
    cleanup(dir);
  }
});

test('crawl4ai: non-HTTP base URL is rejected as invalid', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { crawl4ai: { baseUrl: string } }).crawl4ai = { baseUrl: 'ftp://127.0.0.1:8080' };
    const result = await mgr.testConnection('crawl4ai', {
      resolver: loopbackResolver,
      request: () => okResponse(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid URL');
  } finally {
    cleanup(dir);
  }
});

test('metadata endpoint is blocked with zero requests', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = {
      baseUrl: 'http://169.254.169.254:8080',
    };
    let requests = 0;
    const result = await mgr.testConnection('searxng', {
      resolver: loopbackResolver,
      request: () => {
        requests++;
        return okResponse();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
    assert.equal(requests, 0);
  } finally {
    cleanup(dir);
  }
});

test('redirect to cloud metadata is blocked with no metadata request', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: 'http://example.test' };
    let requests = 0;
    const result = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: () => {
        requests++;
        if (requests === 1) return redirectResponse('http://169.254.169.254/latest/meta-data/');
        return okResponse();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
    assert.equal(requests, 1, 'only the redirect hop; metadata hop must never be requested');
  } finally {
    cleanup(dir);
  }
});

test('redirect to private IP is blocked', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: 'http://example.test' };
    let requests = 0;
    const result = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: () => {
        requests++;
        if (requests === 1) return redirectResponse('http://127.0.0.1:9222/json');
        return okResponse();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
    assert.equal(requests, 1);
  } finally {
    cleanup(dir);
  }
});

test('malformed base URL returns Invalid URL without fetching', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: '::::not-a-url' };
    const result = await mgr.testConnection('searxng', {
      request: () => okResponse(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid URL');
  } finally {
    cleanup(dir);
  }
});

test('IPv6 link-local sidecar address is blocked', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: 'http://[fe80::1]:8080' };
    const result = await mgr.testConnection('searxng', {
      resolver: async () => [{ address: 'fe80::1', family: 6 }],
      request: () => okResponse(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
  } finally {
    cleanup(dir);
  }
});

test('transport errors are sanitized without internal detail', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { searxng: { baseUrl: string } }).searxng = { baseUrl: 'http://example.test' };

    const dnsFail = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: () => {
        const err = new Error(
          'connect ECONNREFUSED 93.184.216.34:443 with super-secret-header-value',
        ) as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        return Promise.reject(err) as unknown as ReturnType<RequestMock>;
      },
    });
    assert.equal(dnsFail.ok, false);
    assert.equal(dnsFail.error, 'Connection failed');
    assert.ok(!dnsFail.error?.includes('secret'));

    const timeout = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: () =>
        Promise.reject(
          new Error('safe fetch deadline exceeded'),
        ) as unknown as ReturnType<RequestMock>,
    });
    assert.equal(timeout.error, 'Connection timed out');

    const tooLarge = await mgr.testConnection('searxng', {
      resolver: publicResolver,
      request: () =>
        Promise.reject(
          new Error('Response exceeded size limit (>65536 bytes)'),
        ) as unknown as ReturnType<RequestMock>,
    });
    assert.equal(tooLarge.error, 'Response too large');
  } finally {
    cleanup(dir);
  }
});

test('brave: public API succeeds via public policy', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { brave: { apiKey: string } }).brave = { apiKey: 'test-brave-key' };
    let requests = 0;
    const result = await mgr.testConnection('brave', {
      resolver: publicResolver,
      request: (options) => {
        requests++;
        assert.equal(options.hostname, 'api.search.brave.com');
        // Headers keys are lowercased when safeFetch serializes Headers
        assert.equal(
          (options.headers as Record<string, string>)['x-subscription-token'],
          'test-brave-key',
        );
        return okResponse();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requests, 1);
  } finally {
    cleanup(dir);
  }
});

test('brave: redirect to private/metadata is blocked', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { brave: { apiKey: string } }).brave = { apiKey: 'test-brave-key' };
    let requests = 0;
    const result = await mgr.testConnection('brave', {
      resolver: publicResolver,
      request: () => {
        requests++;
        if (requests === 1) return redirectResponse('http://169.254.169.254/latest/meta-data/');
        return okResponse();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
    assert.equal(requests, 1);
  } finally {
    cleanup(dir);
  }
});

test('brave: hostname resolving to private address is blocked', async () => {
  const { mgr, dir, cfg } = makeManager();
  try {
    (cfg as { brave: { apiKey: string } }).brave = { apiKey: 'test-brave-key' };
    const result = await mgr.testConnection('brave', {
      resolver: async () => [{ address: '10.0.0.9', family: 4 }],
      request: () => okResponse(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Blocked unsafe URL');
  } finally {
    cleanup(dir);
  }
});

test('unconfigured providers report Not configured without network', async () => {
  const { mgr, dir } = makeManager();
  try {
    const result = await mgr.testConnection('brave', {
      request: () => okResponse(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not configured');
  } finally {
    cleanup(dir);
  }
});

test('unknown provider reports no test available', async () => {
  const { mgr, dir } = makeManager();
  try {
    const result = await mgr.testConnection('exa', { request: () => okResponse() });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /No test available/);
  } finally {
    cleanup(dir);
  }
});
