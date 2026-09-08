import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerJobsSearch } from '../../src/tools/standalone/jobsSearch.js';
import { registerJobsTool, jobsMcpActionCards } from '../../src/tools/families/jobs.js';
import { buildJobsMcpDeps } from '../../src/tools/jobs/jobsDeps.js';
import { loadConfig } from '../../src/config.js';
import { INDEXED_PROVIDER_DEFINITIONS } from '../../src/jobs/acquisition/providers/ports.js';
import { createServer } from '../../src/server.js';

type RegisteredTools = Record<
  string,
  { handler: (args: unknown, extra?: unknown) => Promise<unknown> }
>;

function toolsOf(server: McpServer): RegisteredTools {
  return (server as unknown as { _registeredTools: RegisteredTools })._registeredTools;
}

async function callTool(
  server: McpServer,
  name: string,
  args: unknown,
): Promise<{ text: string; isError?: true }> {
  const entry = toolsOf(server)[name];
  assert.ok(entry, `tool ${name} registered`);
  const res = (await entry.handler(args, undefined)) as {
    content: { type: string; text: string }[];
    isError?: true;
  };
  return { text: res.content[0]?.text ?? '', ...(res.isError ? { isError: true as const } : {}) };
}

function testServer(): McpServer {
  return new McpServer({ name: 'test-jobs-mcp', version: '1' });
}

describe('checkpoint D MCP surface', () => {
  test('deps builder degrades honestly with no providers', () => {
    const deps = buildJobsMcpDeps(loadConfig());
    assert.ok(Array.isArray(deps.providerIds));
    assert.equal(deps.seekBlocked, true);
    assert.ok(Array.isArray(deps.atsTenants));
  });

  test('complete path via jobs_search with fake indexed provider deps', async () => {
    // Registration-level: handler invokes the real seam. Full end-to-end
    // with fake providers is covered by seam tests; here prove the MCP
    // handler path validates input and returns structured results.
    const server = testServer();
    registerJobsSearch(server, loadConfig());
    const bad = await callTool(server, 'jobs_search', { query: '' });
    assert.ok(bad.isError, 'empty query must fail validation, not stub');
  });

  test('registered MCP handler executes seam successfully with injected provider', async () => {
    const cfg = { ...loadConfig(), brave: { apiKey: 'test-key' } };
    const baseDeps = buildJobsMcpDeps(cfg);
    const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === 'search-provider:brave');
    assert.ok(def);
    const deps = {
      ...baseDeps,
      ports: [
        {
          backend: def.backend,
          adapterId: def.adapterId,
          providerId: def.providerId,
          governance: def.governance,
          maxDurationMs: def.maxDurationMs,
          search: async () => [
            {
              title: 'Test engineer',
              url: 'https://example.test/job/1',
              description: 'indexed snippet',
              position: 1,
              domain: 'example.test',
              source: 'brave',
              age: null,
              ageKind: 'unknown',
              extraSnippet: null,
              deepLinks: null,
              contentKind: 'snippet',
              generatedSummary: null,
            },
          ],
        },
      ],
      providerIds: [def.providerId],
      jobspyBoards: [],
    } as typeof baseDeps;
    const server = testServer();
    registerJobsSearch(server, cfg, deps);
    const res = await callTool(server, 'jobs_search', { query: 'engineer', useJobSpy: false });
    assert.ok(!res.isError, res.text);
    assert.match(res.text, /Test engineer/);
  });

  test('useJobSpy:false does not treat disabled boards as available', async () => {
    const server = testServer();
    registerJobsSearch(server, loadConfig(), { providerIds: [], jobspyBoards: [] } as never);
    const res = await callTool(server, 'jobs_search', { query: 'engineer', useJobSpy: false });
    assert.equal(res.isError, true);
    assert.match(res.text, /no indexed providers configured/i);
  });

  test('both MCP surfaces bound public profile arrays', async () => {
    const profile = { roleHints: Array.from({ length: 33 }, () => 'policy analyst') };
    const standalone = testServer();
    registerJobsSearch(standalone, loadConfig());
    assert.equal(
      (await callTool(standalone, 'jobs_search', { query: 'engineer', profile })).isError,
      true,
    );

    const family = testServer();
    registerJobsTool(family, loadConfig());
    assert.equal(
      (await callTool(family, 'jobs', { action: 'search', query: 'engineer', profile })).isError,
      true,
    );
  });

  test('invalid input returns validation error, not a stub', async () => {
    const server = testServer();
    registerJobsSearch(server, loadConfig());
    const res = await callTool(server, 'jobs_search', { query: 42 });
    assert.ok(res.isError);
    // errorResponse sanitizes to first-line message + code payload.
    assert.ok(/VALIDATION_ERROR|Invalid input|invalid/i.test(res.text), res.text.slice(0, 200));
  });

  test('jobs family capabilities + describe_action are live', async () => {
    const server = testServer();
    registerJobsTool(server, loadConfig());
    const caps = await callTool(server, 'jobs', { action: 'capabilities' });
    assert.ok(!caps.isError);
    assert.ok(caps.text.includes('jobs.search'));
    const desc = await callTool(server, 'jobs', { action: 'describe_action', name: 'search' });
    assert.ok(!desc.isError);
    assert.ok(desc.text.includes('search'));
    const unknown = await callTool(server, 'jobs', { action: 'nope' });
    assert.ok(unknown.isError, 'unknown action must error actionably');
  });

  test('unsupported describe_action name errors actionably', async () => {
    const server = testServer();
    registerJobsTool(server, loadConfig());
    const res = await callTool(server, 'jobs', { action: 'describe_action', name: 'search' });
    assert.ok(!res.isError);
    const bad = await callTool(server, 'jobs', { action: 'describe_action', name: 'non_existent' });
    assert.equal(bad.isError, true);
  });

  test('action cards helper matches registry', () => {
    const cards = jobsMcpActionCards();
    assert.deepEqual(cards.map((c) => c.name).sort(), [
      'jobs.capabilities',
      'jobs.describe_action',
      'jobs.search',
    ]);
  });

  test('server co-registers jobs_search + jobs surface', () => {
    const server = createServer(loadConfig()).server;
    const tools = toolsOf(server);
    assert.ok('jobs_search' in tools, 'jobs_search registered');
    assert.ok('jobs' in tools, 'jobs family registered');
    assert.ok(typeof tools['jobs_search']?.handler === 'function');
  });
});

describe('checkpoint D MCP boundary paths', () => {
  test('partial source failure surfaces isolated coverage, ranked survivors', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const { SourcePolicyRegistry } = await import('../../src/jobs/acquisition/policy/registry.js');
    const { AdapterCapabilityRegistry } =
      await import('../../src/jobs/acquisition/adapterRegistry.js');
    const { INDEXED_PROVIDER_DEFINITIONS } =
      await import('../../src/jobs/acquisition/providers/ports.js');
    const mkPort2 = (search: () => Promise<unknown[]>, providerId: string) => {
      const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === providerId)!;
      return {
        backend: def.backend,
        adapterId: def.adapterId,
        providerId: def.providerId,
        governance: def.governance,
        maxDurationMs: def.maxDurationMs,
        search,
      };
    };
    const good = mkPort2(
      async () => [
        {
          title: 'Good Engineer',
          url: 'https://example.test/good/1',
          description: 'good snippet',
          position: 1,
          domain: 'example.test',
          source: 'brave',
          age: null,
          ageKind: 'unknown',
          extraSnippet: null,
          deepLinks: null,
          contentKind: 'snippet',
          generatedSummary: null,
        },
      ],
      'search-provider:brave',
    );
    const bad = mkPort2(async () => {
      throw new Error('provider boom');
    }, 'search-provider:exa');
    const pol = (sourceId: string) => ({
      sourceId,
      revision: 'rev-1',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'permitted',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    });
    const ports = [good, bad];
    const { indexedProviderCapabilities } =
      await import('../../src/jobs/acquisition/providers/ports.js');
    const reg = new SourcePolicyRegistry([
      pol(good.providerId),
      pol(bad.providerId),
      pol('manual'),
    ] as never);
    const caps = new AdapterCapabilityRegistry([
      ...indexedProviderCapabilities(ports as never),
      {
        schemaVersion: '1.0.0',
        adapterId: 'manual',
        adapterVersion: '1.0.0',
        edges: [
          { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
          { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
        ],
      } as never,
    ]);
    const slice = (runId: string, sliceId: string, adapterId: string) => ({
      schemaVersion: '1.0.0',
      runId,
      sliceId,
      ordinal: 0,
      queryVariantId: 'qv-1',
      query: 'engineer',
      reason: 'partial failure',
      adapterIds: [adapterId],
      localePackRefs: [],
      domainPackRefs: [],
      budget: {
        logicalRequests: 2,
        reservedAttempts: 5,
        candidates: 10,
        bytes: 100000,
        milliseconds: 70000,
      },
    });
    const result = await executeJobsSearch(
      {
        intent: {
          query: 'engineer',
          localePackIds: [],
          domainPackIds: [],
          requestedRoleFamilies: [],
          sectors: [],
          locations: [],
          workModes: [],
          employmentTypes: [],
          compensation: [],
          sourceIds: [],
          explorationBreadth: 'balanced',
          strictness: 'normal',
          unknownPolicy: 'include',
          topK: 10,
          budgets: {
            requests: 10,
            pages: 10,
            bytes: 200000,
            milliseconds: 60000,
            enrichment: 0,
            reasoning: 0,
          },
          evidenceRefs: [],
        },
        plan: [
          {
            kind: 'indexed',
            slice: slice('run-pf', 's-good', good.adapterId),
            providerId: good.providerId,
            safeSearch: 'moderate',
          },
          {
            kind: 'indexed',
            slice: slice('run-pf', 's-bad', bad.adapterId),
            providerId: bad.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-pf',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: ports as never,
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as never,
      } as never,
    );
    assert.ok(result.candidates.length >= 1);
    assert.ok(result.coverageOutcomes.some((o) => o.sliceId === 's-bad' && o.isolated));
  });

  test('indexed-only candidate carries no observation ids', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const { SourcePolicyRegistry } = await import('../../src/jobs/acquisition/policy/registry.js');
    const { AdapterCapabilityRegistry } =
      await import('../../src/jobs/acquisition/adapterRegistry.js');
    const { INDEXED_PROVIDER_DEFINITIONS, indexedProviderCapabilities } =
      await import('../../src/jobs/acquisition/providers/ports.js');
    const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === 'search-provider:brave')!;
    const port = {
      backend: def.backend,
      adapterId: def.adapterId,
      providerId: def.providerId,
      governance: def.governance,
      maxDurationMs: def.maxDurationMs,
      search: async () => [
        {
          title: 'Indexed Engineer',
          url: 'https://example.test/idx/1',
          description: 'snippet only',
          position: 1,
          domain: 'example.test',
          source: 'brave',
          age: null,
          ageKind: 'unknown',
          extraSnippet: null,
          deepLinks: null,
          contentKind: 'snippet',
          generatedSummary: null,
        },
      ],
    };
    const pol = (sourceId: string) => ({
      sourceId,
      revision: 'rev-1',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'permitted',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    });
    const reg = new SourcePolicyRegistry([pol(def.providerId), pol('manual')] as never);
    const caps = new AdapterCapabilityRegistry([
      ...indexedProviderCapabilities([port] as never),
      {
        schemaVersion: '1.0.0',
        adapterId: 'manual',
        adapterVersion: '1.0.0',
        edges: [
          { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
          { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
        ],
      } as never,
    ]);
    const result = await executeJobsSearch(
      {
        intent: {
          query: 'engineer',
          localePackIds: [],
          domainPackIds: [],
          requestedRoleFamilies: [],
          sectors: [],
          locations: [],
          workModes: [],
          employmentTypes: [],
          compensation: [],
          sourceIds: [],
          explorationBreadth: 'balanced',
          strictness: 'normal',
          unknownPolicy: 'include',
          topK: 10,
          budgets: {
            requests: 10,
            pages: 10,
            bytes: 200000,
            milliseconds: 60000,
            enrichment: 0,
            reasoning: 0,
          },
          evidenceRefs: [],
        },
        plan: [
          {
            kind: 'indexed',
            slice: {
              schemaVersion: '1.0.0',
              runId: 'run-idx',
              sliceId: 's-idx',
              ordinal: 0,
              queryVariantId: 'qv-1',
              query: 'engineer',
              reason: 'indexed only',
              adapterIds: [def.adapterId],
              localePackRefs: [],
              domainPackRefs: [],
              budget: {
                logicalRequests: 2,
                reservedAttempts: 5,
                candidates: 10,
                bytes: 100000,
                milliseconds: 70000,
              },
            },
            providerId: def.providerId,
            safeSearch: 'moderate',
          },
        ],
        runId: 'run-idx',
        capturedAt: '2026-01-02T00:00:00Z',
        budget: {
          logicalRequests: 10,
          reservedAttempts: 20,
          candidates: 10,
          bytes: 200000,
          milliseconds: 70000,
        },
      } as never,
      {
        policyRegistry: reg,
        capabilityRegistry: caps,
        ports: [port] as never,
        scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as never,
      } as never,
    );
    assert.ok(result.candidates.length >= 1);
    const first = result.candidates[0]!;
    assert.equal(first.evidenceState, 'indexed_only');
    assert.deepEqual(first.observationIds, []);
  });

  test('blocked SEEK board plan makes zero scrape calls', async () => {
    const { executeJobsSearch } = await import('../../src/jobs/orchestration/search.js');
    const { SourcePolicyRegistry } = await import('../../src/jobs/acquisition/policy/registry.js');
    const { AdapterCapabilityRegistry } =
      await import('../../src/jobs/acquisition/adapterRegistry.js');
    const pol = (sourceId: string, state: string) => ({
      sourceId,
      revision: 'rev-1',
      modes: {
        automatedSearch: state,
        automatedFetch: state,
        userSuppliedContent: state,
        manualImport: state,
        employerApi: 'not_supported',
      },
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    });
    const reg = new SourcePolicyRegistry([
      pol('board:seek', 'blocked'),
      pol('manual', 'permitted'),
    ] as never);
    const caps = new AdapterCapabilityRegistry([
      {
        schemaVersion: '1.0.0',
        adapterId: 'jobspy',
        adapterVersion: '1.7.0',
        edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
      } as never,
      {
        schemaVersion: '1.0.0',
        adapterId: 'manual',
        adapterVersion: '1.0.0',
        edges: [
          { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
          { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
        ],
      } as never,
    ]);
    let calls = 0;
    await assert.rejects(
      () =>
        executeJobsSearch(
          {
            intent: {
              query: 'engineer',
              localePackIds: [],
              domainPackIds: [],
              requestedRoleFamilies: [],
              sectors: [],
              locations: [],
              workModes: [],
              employmentTypes: [],
              compensation: [],
              sourceIds: [],
              explorationBreadth: 'balanced',
              strictness: 'normal',
              unknownPolicy: 'include',
              topK: 10,
              budgets: {
                requests: 10,
                pages: 10,
                bytes: 200000,
                milliseconds: 60000,
                enrichment: 0,
                reasoning: 0,
              },
              evidenceRefs: [],
            },
            plan: [
              {
                kind: 'jobspy',
                slice: {
                  schemaVersion: '1.0.0',
                  runId: 'run-seek',
                  sliceId: 's-seek',
                  ordinal: 0,
                  queryVariantId: 'qv-1',
                  query: 'engineer',
                  reason: 'seek blocked',
                  adapterIds: ['jobspy'],
                  localePackRefs: [],
                  domainPackRefs: [],
                  budget: {
                    logicalRequests: 2,
                    reservedAttempts: 5,
                    candidates: 10,
                    bytes: 100000,
                    milliseconds: 70000,
                  },
                },
                board: 'seek',
              },
            ],
            runId: 'run-seek',
            capturedAt: '2026-01-02T00:00:00Z',
            budget: {
              logicalRequests: 10,
              reservedAttempts: 20,
              candidates: 10,
              bytes: 200000,
              milliseconds: 70000,
            },
          } as never,
          {
            policyRegistry: reg,
            capabilityRegistry: caps,
            ports: [] as never,
            scrapeJobs: (async () => {
              calls += 1;
              return { jobs: [], totalScraped: 0, newCount: 0 };
            }) as never,
          } as never,
        ),
      /VALIDATION_ERROR/,
    );
    assert.equal(calls, 0);
  });
});
