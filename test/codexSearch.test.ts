import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODEX_SEARCH_URL,
  codexConfigured,
  codexSearch,
  mapCodexResults,
  readCodexCredentials,
} from '../src/tools/codexSearch.js';
import {
  FALLBACK_ORDER,
  resolveBackends,
  searchWithBackends,
  type ProvenanceResult,
  type WebSearchDeps,
} from '../src/tools/webSearch.js';
import { configHealth, orderedSearchBackends } from '../src/health.js';
import { createMockConfig } from './helpers/mocks.js';
import type { SearchConfig, SearchBackend } from '../src/config.js';
import type { SearchResult } from '../src/types.js';
import { reset as resetBackendHealth } from '../src/utils/backendHealth.js';
import { resetTrackers } from '../src/rateLimit.js';

// Test isolation notes:
// - Tests never rename, write, or remove the repo's config.json / config.enc.
//   Config-dependent behavior is exercised through createMockConfig() injected
//   via WebSearchDeps.config, and through the pure helpers resolveBackends /
//   orderedSearchBackends which take a config plus credential availability.

// codexSearch now gates on the shared rate-limit tracker (assertRateLimitOk) and
// records 429 hits. Reset the module-level tracker before each test so a 429
// recorded in one test never leaks into a later one.
beforeEach(() => {
  resetTrackers();
});

function codexResult(url: string, title: string, snippet = ''): SearchResult {
  return {
    title,
    url,
    description: snippet,
    position: 1,
    domain: new URL(url).hostname,
    source: 'codex',
    age: null,
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet' as const,
    generatedSummary: null,
  };
}

function braveResult(
  url: string,
  title: string,
  snippet = '',
  age: string | null = null,
  deepLinks: { title: string; url: string }[] | null = null,
): SearchResult {
  return {
    title,
    url,
    description: snippet,
    position: 1,
    domain: new URL(url).hostname,
    source: 'brave',
    age,
    extraSnippet: null,
    deepLinks,
  };
}

function exaResult(
  url: string,
  title: string,
  content: string,
  contentKind: 'snippet' | 'full' | 'summary' = 'full',
): SearchResult {
  return {
    title,
    url,
    description: content,
    position: 1,
    domain: new URL(url).hostname,
    source: 'exa',
    age: '2026-01-01',
    extraSnippet: null,
    deepLinks: null,
    contentKind,
    generatedSummary: null,
  };
}

/** Hermetic search config that never consults repo config files. */
function baseSearchConfig(overrides?: Partial<SearchConfig>): SearchConfig {
  return createMockConfig({
    searchBackend: 'searxng',
    searchBackendExplicit: false,
    brave: { apiKey: 'brave-key' },
    rescoreWeights: { webSearch: { rrfAnchor: 0.5, recency: 0.2, hasDeepLinks: 0.05 } },
    ...overrides,
  });
}

/** Set env vars for the duration of fn, restoring afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function throwingDeps(): WebSearchDeps {
  const fail = async (): Promise<SearchResult[]> => {
    throw new Error('backend should not be called');
  };
  return { braveSearch: fail, searxngSearch: fail, exaSearch: fail, tavilySearch: fail };
}

// ── Credential discovery ────────────────────────────────────────────────────

test('codex credential discovery: env token wins, auth file fallback, malformed/missing unconfigured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smcp-codex-auth-'));
  try {
    assert.deepEqual(
      readCodexCredentials({ CODEX_ACCESS_TOKEN: 'env-token', CODEX_ACCOUNT_ID: 'acct-1' }),
      { accessToken: 'env-token', accountId: 'acct-1' },
    );
    assert.ok(codexConfigured({ CODEX_ACCESS_TOKEN: 'env-token' }));
    // Blank env token falls through to the file
    assert.equal(
      readCodexCredentials({ CODEX_ACCESS_TOKEN: '  ', CODEX_HOME: join(dir, 'missing') }),
      undefined,
    );

    // Valid auth file via CODEX_HOME
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file-token', account_id: 'file-acct' } }),
    );
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir }), {
      accessToken: 'file-token',
      accountId: 'file-acct',
    });

    // account_id is optional
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file-token' } }),
    );
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir }), { accessToken: 'file-token' });

    // Malformed JSON → unconfigured
    await writeFile(join(dir, 'auth.json'), '{not json');
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);

    // Missing tokens.access_token / missing tokens object → unconfigured
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ other: 'x' }));
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);

    // Missing file → unconfigured
    assert.equal(readCodexCredentials({ CODEX_HOME: join(dir, 'nope') }), undefined);

    // Env token wins over malformed file
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir, CODEX_ACCESS_TOKEN: 'env-token' }), {
      accessToken: 'env-token',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Response mapping ────────────────────────────────────────────────────────

test('mapCodexResults accepts result objects with valid http/https URLs and trims fields', () => {
  assert.deepEqual(mapCodexResults({ results: [] }, 10), []);
  assert.deepEqual(mapCodexResults('nope', 10), []);
  assert.deepEqual(mapCodexResults({ results: 'nope' }, 10), []);
  const mapped = mapCodexResults(
    {
      results: [
        { url: '  https://example.com/a  ', title: '  A  ', snippet: '  snip  ' },
        { url: 'not-a-url', title: 'no' },
        { url: 'ftp://example.com/x', title: 'no' },
        { url: '', title: 'no' },
        42,
        null,
        { title: 'no url' },
        { url: 'http://example.com/b', title: 'B', snippet: '' },
      ],
    },
    10,
  );
  assert.deepEqual(mapped, [
    { title: 'A', url: 'https://example.com/a', snippet: 'snip' },
    { title: 'B', url: 'http://example.com/b' },
  ]);
  // Limit respected
  assert.equal(
    mapCodexResults(
      {
        results: [
          { url: 'https://a.com/1', title: '1' },
          { url: 'https://a.com/2', title: '2' },
        ],
      },
      1,
    ).length,
    1,
  );
});

// ── Request shape / no secret exposure ──────────────────────────────────────

test('codexSearch posts to fixed endpoint with bearer headers and query-only payload; results leak no credentials', async () => {
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(input);
    observedInit = init;
    return new Response(
      JSON.stringify({
        results: [
          {
            url: 'https://example.com/a',
            title: '  Trimmed title  ',
            snippet: ' Trimmed snippet ',
          },
          { url: 'relative/path', title: 'skip' },
          { url: 'https://example.com/b', title: 'B', snippet: null },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    await withEnv(
      {
        CODEX_ACCESS_TOKEN: 'tok-leak-me',
        CODEX_ACCOUNT_ID: 'acct-9',
        CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home'),
      },
      async () => {
        const results = await codexSearch('hello world', 10);
        assert.equal(observedUrl, CODEX_SEARCH_URL);
        const headers = observedInit?.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer tok-leak-me');
        assert.equal(headers['ChatGPT-Account-ID'], 'acct-9');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = JSON.parse(String(observedInit?.body)) as Record<string, unknown>;
        assert.equal(body.model, 'gpt-4o');
        assert.deepEqual(body.commands, { search_query: [{ q: 'hello world' }] });
        assert.equal(typeof body.id, 'string');
        assert.equal(results.length, 2);
        assert.equal(results[0]?.url, 'https://example.com/a');
        assert.equal(results[0]?.title, 'Trimmed title');
        assert.equal(results[0]?.description, 'Trimmed snippet');
        assert.equal(results[0]?.domain, 'example.com');
        assert.equal(results[0]?.source, 'codex');
        assert.equal(results[1]?.url, 'https://example.com/b');
        const serialized = JSON.stringify(results);
        assert.doesNotMatch(serialized, /tok-leak-me/);
        assert.doesNotMatch(serialized, /acct-9/);
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codexSearch returns [] without credentials (caller gates on configured)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => {
    throw new Error('codexSearch must not fetch when unconfigured');
  };
  try {
    await withEnv(
      { CODEX_HOME: join(tmpdir(), 'smcp-no-codex-home'), CODEX_ACCESS_TOKEN: undefined },
      async () => {
        assert.deepEqual(await codexSearch('x', 5), []);
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codexSearch: credential removal after cached search returns [] without reusing cache', async () => {
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({ results: [{ url: 'https://example.com/a', title: 'A', snippet: 's' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    // First call with credentials: should fetch and cache.
    await withEnv(
      { CODEX_ACCESS_TOKEN: 'tok-a', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
      async () => {
        const r1 = await codexSearch('cache-test', 5);
        assert.equal(r1.length, 1);
        assert.equal(fetchCalls, 1);
        // Second call with same credentials: cache hit, no fetch.
        const r2 = await codexSearch('cache-test', 5);
        assert.equal(r2.length, 1);
        assert.equal(fetchCalls, 1, 'second call must be a cache hit');
      },
    );
    // Now call without credentials: must return [] immediately, no cache reuse.
    await withEnv(
      { CODEX_ACCESS_TOKEN: undefined, CODEX_HOME: join(tmpdir(), 'smcp-no-codex-home') },
      async () => {
        const r3 = await codexSearch('cache-test', 5);
        assert.deepEqual(r3, []);
        assert.equal(fetchCalls, 1, 'no fetch when credentials are missing');
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codexSearch: account change after cached search forces a fresh fetch', async () => {
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({ results: [{ url: 'https://example.com/a', title: 'A', snippet: 's' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    // First call with account A.
    await withEnv(
      {
        CODEX_ACCESS_TOKEN: 'shared-token',
        CODEX_ACCOUNT_ID: 'acct-a',
        CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home'),
      },
      async () => {
        const r1 = await codexSearch('acct-test', 5);
        assert.equal(r1.length, 1);
        assert.equal(fetchCalls, 1);
      },
    );
    // Second call with account B (same token, different account): must miss cache.
    await withEnv(
      {
        CODEX_ACCESS_TOKEN: 'shared-token',
        CODEX_ACCOUNT_ID: 'acct-b',
        CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home'),
      },
      async () => {
        const r2 = await codexSearch('acct-test', 5);
        assert.equal(r2.length, 1);
        assert.equal(fetchCalls, 2, 'account change must miss the cache');
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codexSearch: 5xx retried (3 attempts), error body never exposed; 401/403/429 not retried', async () => {
  // 5xx -> retried per retryWithBackoff conventions (maxAttempts 3)
  let serverCalls = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    serverCalls++;
    return new Response('{"error":"internal-secret-detail"}', { status: 500 });
  };
  try {
    await withEnv(
      { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
      async () => {
        await assert.rejects(() => codexSearch('x', 5), /HTTP 500/);
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.equal(serverCalls, 3, '5xx must be retried (maxAttempts 3)');
  assert.ok(true, '500 body never surfaces in the error (message only carries status)');

  // 401/403/429 -> single attempt, no retry
  for (const status of [401, 403, 429]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('denied', { status });
    };
    try {
      await withEnv(
        { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
        async () => {
          await assert.rejects(() => codexSearch('x', 5), new RegExp(String(status)));
        },
      );
      assert.equal(calls, 1, `status ${status} must not be retried`);
      assert.doesNotMatch('denied', /,/, 'body content never included');
    } finally {
      globalThis.fetch = savedFetch;
    }
  }
});

// ── Auto-use ordering / dedupe / fallback (hermetic: injected config) ───────

test('no explicit backend: configured codex is primary, merged results are codex-first with normalized-URL dedupe', async () => {
  await withEnv(
    { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
    async () => {
      const prov: { current: ProvenanceResult | null } = { current: null };
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig(),
        codexSearch: async () => [
          codexResult('https://example.com/a', 'A-codex', 'ca'),
          codexResult('https://example.com/b', 'B-codex', 'cb'),
        ],
        braveSearch: async () => [
          braveResult('https://www.example.com/a/', 'A-brave', 'ba'), // dedupes to example.com/a
          braveResult('https://example.com/d', 'D-brave', 'dd'),
        ],
      };
      const results = await searchWithBackends(
        'x',
        3,
        'moderate',
        deps,
        undefined,
        false,
        true,
        prov,
      );
      const urls = results.map((r) => r.url);
      assert.deepEqual(urls, [
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/d',
      ]);
      const first = results[0] as SearchResult & { engines?: string[] };
      assert.deepEqual(
        first.engines,
        ['codex', 'brave'],
        'codex entry deduped with brave duplicate keeps both engines',
      );
      assert.equal(prov.current?.usedBackend, 'codex');
      assert.equal(prov.current?.usedFallback, false);
      assert.ok(prov.current?.servedBackends.includes('codex'));
    },
  );
});

test('cross-query dedup: richer fallback description retained (content truth); score-first ranks the higher-signal fallback-only result first', async () => {
  await withEnv(
    { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
    async () => {
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig(),
        // Query expansion: 'api' → ['api' (original), 'rest graphql' (concept)]
        codexSearch: async (q: string) =>
          q === 'api' ? [codexResult('https://example.com/a', 'A-codex', 'short')] : [],
        braveSearch: async (q: string) =>
          q === 'rest graphql'
            ? [
                // Same normalized URL as the codex hit, but with the LONGER description.
                braveResult(
                  'https://www.example.com/a/',
                  'A-brave',
                  'much longer description from the fallback variation',
                ),
                // Fallback-only result that rescoring prefers (recency + deep links).
                {
                  ...braveResult('https://example.com/c', 'C-brave', 'c', '1 day ago'),
                  deepLinks: [{ title: 'l', url: 'https://example.com/c/l' }],
                },
              ]
            : [],
      };
      const results = await searchWithBackends('api', 3, 'moderate', deps, undefined, true, true);

      assert.equal(results.length, 2);
      // Score sorts first: the fallback-only result (c) carries recency + deep
      // links, so it has a higher ranking score and leads — Codex does not jump
      // it because that would move a lower-score result above a higher-score
      // fallback.
      assert.equal(results[0]?.url, 'https://example.com/c', 'higher-signal fallback leads');
      const second = results[1] as SearchResult & { engines?: string[] };
      // Content truth retained for the cross-query deduped entry: the richer
      // fallback (brave) representation wins, so `source` is the provider of the
      // chosen content — not the thin Codex snippet — while engines still union
      // Codex's discovery of the same URL.
      assert.equal(
        results[1]?.url,
        'https://www.example.com/a/',
        'deduped entry keeps winner content',
      );
      assert.equal(results[1]?.description, 'much longer description from the fallback variation');
      assert.equal(
        results[1]?.source,
        'brave',
        'source is the provider of the richer chosen content',
      );
      assert.ok(second.engines?.includes('codex'), 'engines must retain codex');
      assert.ok(second.engines?.includes('brave'), 'engines must include the fallback too');
    },
  );
});

test('codex failure falls back to remaining backends; provenance records usedFallback', async () => {
  await withEnv(
    { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
    async () => {
      const prov: { current: ProvenanceResult | null } = { current: null };
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig(),
        codexSearch: async () => {
          throw new Error('HTTP 500 for Codex search');
        },
        braveSearch: async () => [braveResult('https://example.com/b', 'B')],
      };
      const results = await searchWithBackends(
        'x',
        3,
        'moderate',
        deps,
        undefined,
        false,
        true,
        prov,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0]?.url, 'https://example.com/b');
      assert.equal(prov.current?.usedBackend, 'codex');
      assert.equal(prov.current?.usedFallback, true);
      assert.equal(typeof prov.current?.fallbackReason, 'string');
      assert.equal(prov.current?.servedBackends.includes('codex'), false);
    },
  );
});

// ── Explicit backend behavior ───────────────────────────────────────────────

test('explicit backend remains preferred but all configured providers run and Codex stays first', async () => {
  resetBackendHealth();
  await withEnv(
    { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
    async () => {
      let codexCalls = 0;
      let braveCalls = 0;
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig({ searchBackend: 'brave', searchBackendExplicit: true }),
        codexSearch: async () => {
          codexCalls++;
          return [codexResult('https://example.com/shared', 'Codex', 'codex')];
        },
        braveSearch: async () => {
          braveCalls++;
          return [braveResult('https://www.example.com/shared/', 'Brave', 'brave')];
        },
      };
      const results = await searchWithBackends('x', 3, 'moderate', deps, undefined, false, true);
      assert.equal(codexCalls, 1, 'Codex must run alongside explicit backend');
      assert.equal(braveCalls, 1, 'explicit backend must still run');
      assert.equal(results.length, 1, 'matching URLs must dedupe');
      assert.equal(
        results[0]?.source,
        'codex',
        'Codex duplicate provenance keeps main-source priority',
      );
      assert.deepEqual((results[0] as SearchResult & { engines?: string[] }).engines, [
        'codex',
        'brave',
      ]);
    },
  );
});

test('explicit Codex runs first with all providers; unconfigured Codex falls back', async () => {
  resetBackendHealth();
  // Configured: Codex still runs first.
  await withEnv(
    { CODEX_ACCESS_TOKEN: 'tk', CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home') },
    async () => {
      let codexCalls = 0;
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig({ searchBackend: 'codex', searchBackendExplicit: true }),
        codexSearch: async () => {
          codexCalls++;
          return [codexResult('https://example.com/codex', 'Codex')];
        },
      };
      const results = await searchWithBackends('x', 3, 'moderate', deps, undefined, false, true);
      assert.equal(codexCalls, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.url, 'https://example.com/codex');
      assert.equal(results[0]?.source, 'codex');
    },
  );

  // Unconfigured Codex: configured fallback providers still serve results.
  resetBackendHealth();
  await withEnv(
    { CODEX_ACCESS_TOKEN: undefined, CODEX_HOME: join(tmpdir(), 'smcp-no-codex-home') },
    async () => {
      const deps: WebSearchDeps = {
        ...throwingDeps(),
        config: baseSearchConfig({ searchBackend: 'codex', searchBackendExplicit: true }),
        braveSearch: async () => [braveResult('https://example.com/brave-fallback', 'Brave')],
      };
      const results = await searchWithBackends('x', 3, 'moderate', deps, undefined, false, true);
      assert.equal(results[0]?.url, 'https://example.com/brave-fallback');
    },
  );
});

// ── Health / config behavior (pure, no network, no repo config reads) ──────

test('health/config: codex detected non-secretly via auth file; unconfigured codex alone is not healthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smcp-codex-status-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file-secret-token-xyz' } }),
    );

    // No explicit SEARCH_BACKEND + auth file present → codex configured.
    // Keyless cfg: codex is the only thing that can make web_search healthy.
    await withEnv(
      { SEARCH_BACKEND: undefined, CODEX_HOME: dir, CODEX_ACCESS_TOKEN: undefined },
      async () => {
        const cfg = createMockConfig({ searchBackend: 'searxng', searchBackendExplicit: false });
        assert.equal(cfg.brave.apiKey, '', 'precondition: no key-backed backend');
        const report = configHealth(cfg);
        assert.equal(report.web_search?.status, 'healthy');
        const serialized = JSON.stringify(report);
        assert.doesNotMatch(
          serialized,
          /file-secret-token-xyz/,
          'health report must not leak credentials',
        );
      },
    );

    // Unconfigured codex → web_search relies on remaining defaults (not healthy via codex)
    await withEnv(
      {
        SEARCH_BACKEND: undefined,
        CODEX_HOME: join(dir, 'missing'),
        CODEX_ACCESS_TOKEN: undefined,
      },
      async () => {
        const cfg = createMockConfig({ searchBackend: 'searxng', searchBackendExplicit: false });
        const report = configHealth(cfg);
        assert.notEqual(
          report.web_search?.status,
          'healthy',
          'codex alone must not mark web_search healthy when unconfigured',
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('health/config: Ollama search alone configures web_search', () => {
  const report = configHealth(
    createMockConfig({ ollamaSearch: { baseUrl: 'http://ollama.test', apiKey: '' } }),
  );
  assert.equal(report.web_search?.status, 'healthy');
  assert.equal(report.web_search?.configuration?.configured, true);
  assert.equal(report.web_search?.configuration?.missing.length, 0);
});

// ── Backend ordering (pure, no network) ─────────────────────────────────────

test('ordering: health probes align exactly with runtime all-provider fanout (incl. ollama-search)', () => {
  // Codex is main source; remaining provider candidates follow FALLBACK_ORDER.
  const inferred = baseSearchConfig({ searchBackend: 'codex', searchBackendExplicit: false });
  const probed = orderedSearchBackends(inferred, true);
  assert.deepEqual(
    probed,
    ['codex', ...FALLBACK_ORDER],
    'health probe order must match runtime FALLBACK_ORDER exactly (codex primary first)',
  );
  assert.ok(probed.includes('ollama-search'), 'ollama-search must be probed');
  assert.ok(probed.includes('duckduckgo'));

  // No Codex credentials: default primary remains Codex; availability filtering skips it at execution.
  assert.deepEqual(orderedSearchBackends(inferred, false), ['codex', ...FALLBACK_ORDER]);

  // Explicit selection changes fallback order, never provider scope.
  assert.deepEqual(
    orderedSearchBackends(
      baseSearchConfig({ searchBackend: 'codex', searchBackendExplicit: true }),
      true,
    ),
    ['codex', ...FALLBACK_ORDER],
  );

  const explicitBrave = orderedSearchBackends(
    baseSearchConfig({ searchBackend: 'brave', searchBackendExplicit: true }),
    true,
  );
  assert.deepEqual(explicitBrave, [
    'codex',
    'brave',
    ...FALLBACK_ORDER.filter((b) => b !== 'brave'),
  ]);
});

test('ordering: resolveBackends and health orderedSearchBackends agree for the same config', () => {
  const cfg: SearchConfig = baseSearchConfig();
  assert.deepEqual(orderedSearchBackends(cfg, true), resolveBackends(cfg, undefined, true));
  assert.deepEqual(orderedSearchBackends(cfg, false), resolveBackends(cfg, undefined, false));

  const explicit: SearchConfig = baseSearchConfig({
    searchBackend: 'codex',
    searchBackendExplicit: true,
  });
  assert.deepEqual(
    orderedSearchBackends(explicit, true),
    resolveBackends(explicit, undefined, true),
  );

  // Overrides bypass config-driven ordering verbatim.
  const override: SearchBackend[] = ['brave', 'codex'];
  assert.deepEqual(resolveBackends(cfg, override, true), override);
});

// ── Control-character credential rejection ───────────────────────────────────

test('codex credentials: control characters in token make credentials unavailable; invalid optional account id ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smcp-codex-ctrl-'));
  try {
    // CR/LF in the token → unconfigured (never reaches header construction)
    assert.equal(readCodexCredentials({ CODEX_ACCESS_TOKEN: 'tok\r\nINJECTED' }), undefined);
    assert.equal(codexConfigured({ CODEX_ACCESS_TOKEN: 'tok\r\nINJECTED' }), false);
    assert.equal(readCodexCredentials({ CODEX_ACCESS_TOKEN: 'tok\u0000null' }), undefined);
    // Control chars in the optional account id → account id ignored, token kept
    assert.deepEqual(
      readCodexCredentials({ CODEX_ACCESS_TOKEN: 'tok', CODEX_ACCOUNT_ID: 'acct\nEVIL' }),
      {
        accessToken: 'tok',
      },
    );
    // File-based token with control chars → unconfigured
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file\r\nEVIL' } }),
    );
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);
    // File-based account id with control chars → dropped
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file-tok', account_id: 'acct\u0001x' } }),
    );
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir }), { accessToken: 'file-tok' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codexSearch: malformed token never reaches headers or thrown errors; invalid account header safely omitted', async () => {
  const savedFetch = globalThis.fetch;
  const seenHeaders: (Record<string, string> | undefined)[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    seenHeaders.push(init?.headers as Record<string, string> | undefined);
    return new Response('{"error":"secret-detail"}', { status: 500 });
  };
  try {
    const evilToken = 'evil\r\nINJECTED';
    await withEnv(
      {
        CODEX_ACCESS_TOKEN: evilToken,
        CODEX_ACCOUNT_ID: 'acct\nEVIL',
        CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home'),
      },
      async () => {
        assert.equal(
          codexConfigured(process.env),
          false,
          'control-char token must not count as configured',
        );
        // Unconfigured → no fetch, no throw; nothing surfaces the token
        const results = await codexSearch('x', 5);
        assert.deepEqual(results, []);
        assert.doesNotMatch(JSON.stringify({ results }), /evil|INJECTED/);
      },
    );
    assert.equal(seenHeaders.length, 0, 'fetch must not be called for a control-char token');

    // Valid token + invalid account id → request proceeds, account header omitted
    seenHeaders.length = 0;
    const evilAccount = 'acct\nEVIL';
    await withEnv(
      {
        CODEX_ACCESS_TOKEN: 'good-token',
        CODEX_ACCOUNT_ID: evilAccount,
        CODEX_HOME: join(tmpdir(), 'smcp-missing-codex-home'),
      },
      async () => {
        await assert.rejects(() => codexSearch('x', 5), /HTTP 500/);
      },
    );
    assert.equal(seenHeaders.length, 3, '5xx retried 3 times');
    for (const headers of seenHeaders) {
      assert.equal(headers?.Authorization, 'Bearer good-token');
      assert.equal(
        headers?.['ChatGPT-Account-ID'],
        undefined,
        'invalid account id must not become a header',
      );
    }
    assert.doesNotMatch(
      JSON.stringify({ headers: seenHeaders }),
      /EVIL/,
      'credential string must not surface',
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ── Codex-first order after rescore (hermetic override path) ────────────────

test('auto-codex: score sorts first; a higher-signal fallback (recency + deep links) outranks a thin Codex snippet', async () => {
  const deps: WebSearchDeps = {
    ...throwingDeps(),
    config: baseSearchConfig(),
    codexSearch: async () => [codexResult('https://example.com/a', 'A-codex', 'codex snippet')],
    braveSearch: async () => [
      {
        ...braveResult('https://example.com/b', 'B-brave', 'brave snippet'),
        age: '1 day ago',
        deepLinks: [{ title: 'l', url: 'https://example.com/b/l' }],
      },
    ],
  };
  // Override to codex+brave keeps the test hermetic (no always-on duckduckgo probe).
  const results = await searchWithBackends(
    'x',
    2,
    'moderate',
    deps,
    ['codex', 'brave'],
    false,
    true,
  );
  assert.equal(results.length, 2, 'both codex and fallback results survive');
  // Score sorts first: B carries recency + deep links so its combinedScore is
  // higher than the thin Codex snippet's. Codex only tiebreaks (near-)equal
  // scores and never jumps a lower-score Codex above a higher-score fallback.
  assert.equal(results[0]?.source, 'brave', 'higher-score fallback leads');
  assert.equal(results[0]?.url, 'https://example.com/b');
  assert.equal(results[1]?.url, 'https://example.com/a');
});

test('content truth: rich Exa full content beats a duplicate Codex snippet; source stays Exa and engines union discovery', async () => {
  const deps: WebSearchDeps = {
    ...throwingDeps(),
    config: baseSearchConfig(),
    codexSearch: async () => [
      codexResult('https://example.com/shared', 'A-codex', 'thin codex snippet'),
    ],
    exaSearch: async () => [
      exaResult(
        'https://www.example.com/shared/',
        'A-exa',
        'A long, full page body from Exa with substantially more detail than the thin Codex snippet.',
      ),
    ],
  };
  const results = await searchWithBackends('x', 3, 'moderate', deps, ['codex', 'exa'], false, true);
  assert.equal(results.length, 1, 'same normalized URL dedupes');
  const first = results[0] as SearchResult & { engines?: string[] };
  assert.equal(first.url, 'https://www.example.com/shared/');
  assert.equal(first.source, 'exa', 'source is the provider of the richer chosen content');
  assert.ok(first.description.length > 'thin codex snippet'.length, 'full content kept');
  assert.ok(first.engines?.includes('codex'), 'engines retain codex discovery');
  assert.ok(first.engines?.includes('exa'), 'engines include exa');
});

test('same-query merge (aiSummary=yes): richer Brave winner retains Exa generated summary/provider from same-URL duplicate', async () => {
  const deps: WebSearchDeps = {
    ...throwingDeps(),
    config: baseSearchConfig(),
    braveSearch: async () => [
      {
        ...braveResult(
          'https://example.com/shared',
          'Shared',
          'A long, rich full page body from Brave with substantially more detail than the thin Exa snippet — the richest clean representation for this URL.',
        ),
        contentKind: 'full',
      },
    ],
    exaSearch: async () => [
      {
        title: 'Shared',
        url: 'https://www.example.com/shared/',
        description: 'Thin exa snippet',
        position: 1,
        domain: 'example.com',
        source: 'exa',
        age: '2026-01-01',
        extraSnippet: null,
        deepLinks: null,
        contentKind: 'snippet',
        generatedSummary: 'Exa generated summary of the shared page.',
        generatedSummaryProvider: 'exa',
      },
    ],
  };
  const results = await searchWithBackends(
    'x',
    3,
    'moderate',
    deps,
    ['brave', 'exa'],
    false,
    true,
    undefined,
    undefined,
    'yes',
  );
  assert.equal(results.length, 1, 'same normalized URL dedupes to one');
  const first = results[0] as SearchResult & { engines?: string[] };
  assert.equal(first.source, 'brave', 'richer Brave content wins as source');
  assert.equal(
    first.generatedSummary,
    'Exa generated summary of the shared page.',
    'Exa summary retained on the richer winner that lacks one',
  );
  assert.equal(first.generatedSummaryProvider, 'exa', 'provider stays paired with its summary');
  assert.ok(first.engines?.includes('brave'), 'engines union keeps brave');
  assert.ok(first.engines?.includes('exa'), 'engines union keeps exa');
});

test('bounded preference: a rich Exa result cannot be starved out of the top limit by thin Codex snippets', async () => {
  const deps: WebSearchDeps = {
    ...throwingDeps(),
    config: baseSearchConfig(),
    codexSearch: async () => [
      codexResult('https://example.com/a', 'A-codex', 'ca'),
      codexResult('https://example.com/b', 'B-codex', 'cb'),
      codexResult('https://example.com/c', 'C-codex', 'cc'),
    ],
    exaSearch: async () => [
      exaResult(
        'https://example.com/rich',
        'Rich-Exa',
        'A substantially richer full-page Exa result with many more words of content that should not be buried below several thin Codex snippets.',
      ),
    ],
  };
  const results = await searchWithBackends('x', 3, 'moderate', deps, ['codex', 'exa'], false, true);
  assert.equal(results.length, 3, 'limited to three results');
  assert.equal(results[0]?.source, 'exa', 'rich Exa result leads over thin Codex snippets');
  assert.equal(results[0]?.url, 'https://example.com/rich');
});

test('Codex-only results are honestly labeled as snippet content', async () => {
  const deps: WebSearchDeps = {
    ...throwingDeps(),
    config: baseSearchConfig(),
    codexSearch: async () => [codexResult('https://example.com/a', 'A-codex', 'codex snippet')],
  };
  const results = await searchWithBackends('x', 1, 'moderate', deps, ['codex'], false, true);
  assert.equal(results[0]?.source, 'codex');
  assert.equal(results[0]?.contentKind, 'snippet', 'Codex returns a snippet, honestly labeled');
});
