import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerJobsSearch } from '../../src/tools/standalone/jobsSearch.js';
import { mapPublicProfile } from '../../src/tools/jobs/profileMapping.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../src/jobs/packs/nswPublicAdmin.domain.js';
import { loadConfig } from '../../src/config.js';

const tools = (server: McpServer) =>
  (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;

test('fix1 profile maps only exact pack role/capability terms', () => {
  const mapped = mapPublicProfile(
    { roleHints: ['policy analyst'], capabilities: ['research'] },
    NSW_PUBLIC_ADMIN_DOMAIN_PACK,
  );
  assert.equal(mapped.profileInput.profile.roleHints?.[0]?.termId, 'policy-analyst');
  assert.equal(mapped.profileInput.profile.capabilities?.[0]?.termId, 'research');
  assert.equal(mapped.allowedTermRefs.size, 2);
  assert.throws(() =>
    mapPublicProfile({ roleHints: ['invented role'] }, NSW_PUBLIC_ADMIN_DOMAIN_PACK),
  );
});

test('fix1 no-provider default remains actionable even when JobSpy defaults true', async () => {
  const server = new McpServer({ name: 'fix1', version: '1' });
  registerJobsSearch(server, loadConfig(), {
    providerIds: [],
    jobspyBoards: [],
  } as never);
  const result = (await tools(server).jobs_search!.handler({ query: 'engineer' })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /no indexed providers configured/i);
});
