import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetConfig, loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { semanticGitHubCode } from '../src/tools/semanticGitHubCode.js';
import type { GitHubCorpusDocument } from '../src/utils/githubCorpus.js';
import { buildMockResponse } from './helpers.js';

const DOCS: GitHubCorpusDocument[] = [
   {
      path: 'src/format.ts',
      url: 'https://github.com/owner/repo/blob/main/src/format.ts',
      content: `import fs from 'node:fs';

/** Format names for display. */
export function formatName(value: string): string {
  return value.trim().toLowerCase();
}

void fs.existsSync;
`,
   },
   {
      path: 'examples/format.ts',
      url: 'https://github.com/owner/repo/blob/main/examples/format.ts',
      content: `export function exampleOnly(): string {
  return 'demo';
}
`,
   },
   {
      path: 'src/format.py',
      url: 'https://github.com/owner/repo/blob/main/src/format.py',
      content: `def format_name(value: str) -> str:
    return value.strip().lower()
`,
   },
];

async function fetchCorpus(): Promise<GitHubCorpusDocument[]> {
   return DOCS;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
   process.env.EMBEDDING_SIDECAR_BASE_URL = 'https://embed.example.com';
   resetConfig();
   globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
         ? (JSON.parse(String(init.body)) as { texts?: string[]; input?: string[] })
         : {};
      const texts = body.texts ?? body.input ?? [];
      const embeddings = texts.map((text) => {
         const normalized = text.toLowerCase();
         if (normalized.includes('formatname') || normalized.includes('format names for display')) {
            return [1, 0, 0, 0];
         }
         if (normalized.includes('exampleonly')) {
            return [0, 1, 0, 0];
         }
         if (normalized.includes('format_name')) {
            return [0.8, 0.1, 0, 0];
         }
         return [0.2, 0.2, 0, 0];
      });
      return buildMockResponse({
         embeddings,
         model: 'test-embedding-model',
         modelRevision: 'test',
         dimensions: 4,
         mode: 'document',
         truncatedIndices: [],
      });
   };
});

afterEach(() => {
   globalThis.fetch = originalFetch;
   delete process.env.EMBEDDING_SIDECAR_BASE_URL;
   resetConfig();
});

test('semanticGitHubCode rejects malformed repo identifiers', async () => {
   await assert.rejects(async () => {
      await semanticGitHubCode({
         query: 'formatName',
         repo: 'not-a-valid-repo',
         preFilterByContent: true,
      });
   }, /owner\/repo/i);
});

test('semanticGitHubCode filters files and returns structured code results', async () => {
   const result = await semanticGitHubCode(
      {
         query: 'formatName',
         repo: 'owner/repo',
         language: 'typescript',
         fileFilter: ['src/'],
         includeContext: true,
         topK: 5,
         preFilterByContent: true,
      },
      { fetchCorpus },
   );

   assert.equal(result.profile, 'lexical-heavy');
   assert.equal(result.topKRequested, 5);
   assert.ok(result.topKDelivered > 0);
   assert.ok(result.results.length > 0);
   const first = result.results[0];
   assert.ok(first);
   assert.equal(first.path, 'src/format.ts');
   assert.equal(first.language, 'typescript');
   assert.equal(first.symbolName, 'formatName');
   assert.equal(first.symbolKind, 'function');
   assert.ok(first.startLine !== undefined);
   assert.ok(first.endLine !== undefined);
   assert.ok(first.startLine < first.endLine);
   assert.ok(first.text?.includes('formatName'));
   assert.ok(first.score.fused > 0);
});

test('semanticGitHubCode omits source text unless includeContext is requested', async () => {
   const result = await semanticGitHubCode(
      {
         query: 'formatName',
         repo: 'owner/repo',
         language: 'typescript',
         fileFilter: ['src/'],
         includeContext: false,
         preFilterByContent: true,
      },
      { fetchCorpus },
   );

   assert.ok(result.results.length > 0);
   assert.equal(result.results[0]?.text, undefined);
});

test('semanticGitHubCode returns controlled warning for empty corpora', async () => {
   const result = await semanticGitHubCode(
      {
         query: 'missing',
         repo: 'owner/repo',
         fileFilter: ['does-not-match/'],
         preFilterByContent: true,
      },
      { fetchCorpus },
   );

   assert.deepEqual(result.results, []);
   assert.ok(result.warnings.some((warning) => /No GitHub files matched/i.test(warning)));
});

test('semanticGitHubCode forwards maxFileBytes to corpus collection', async () => {
   let observedOptions: any;
   await semanticGitHubCode(
      {
         query: 'formatName',
         repo: 'owner/repo',
         maxFileBytes: 12_345,
      } as any,
      {
         fetchCorpus: async (options: any) => {
            observedOptions = options;
            return DOCS;
         },
      },
   );

   assert.equal(observedOptions?.maxFileBytes, 12_345);
});

test('github family is registered in the MCP server', () => {
   resetConfig();
   const { server } = createServer(loadConfig()) as unknown as {
      server: { _registeredTools?: Record<string, unknown> };
   };
   assert.ok(server._registeredTools?.github);
});
