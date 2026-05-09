import test from 'node:test';
import assert from 'node:assert/strict';
import { resetConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { semanticGitHubCode } from '../src/tools/semanticGitHubCode.js';
import type { GitHubCorpusDocument } from '../src/utils/githubCorpus.js';

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

test('semanticGitHubCode rejects malformed repo identifiers', async () => {
   await assert.rejects(async () => {
      await semanticGitHubCode({
         query: 'formatName',
         repo: 'not-a-valid-repo',
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
      },
      { fetchCorpus },
   );

   assert.equal(result.profile, 'lexical-heavy');
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
   const server = createServer() as unknown as { _registeredTools?: Record<string, unknown> };
   assert.ok(server._registeredTools?.github);
});
