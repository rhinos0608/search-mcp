import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/chunking.js';
import { chunksFromCodeFiles, chunksFromCodeFilesAsync } from '../src/rag/adapters/code.js';

function loadFixture(name: string): string {
  return readFileSync(path.join(process.cwd(), 'test/fixtures/code', name), 'utf8');
}

test('chunkMarkdown preserves code fence context metadata', () => {
  const chunks = chunkMarkdown(loadFixture('sample.md'), 'https://example.com/sample.md') as Array<{
    content: string;
    metadata?: { contextBefore?: string; contextAfter?: string };
  }>;

  const codeChunk = chunks.find((chunk) => chunk.content.includes('renderLabel'));
  assert.ok(codeChunk);
  assert.ok(codeChunk?.metadata?.contextBefore?.includes('code examples'));
  assert.ok(codeChunk?.metadata?.contextAfter?.includes('Some text between code blocks'));
});

test('chunksFromCodeFiles respects symbol boundaries and keeps source text', () => {
  const chunks = chunksFromCodeFiles([
    {
      path: 'test/fixtures/code/sample.ts',
      content: loadFixture('sample.ts'),
      url: 'https://example.com/sample.ts',
    },
  ]);

  assert.ok(chunks.length > 0);
  const helper = chunks.find((chunk) => chunk.metadata?.symbolName === 'buildMessage');
  assert.ok(helper);
  assert.ok(helper?.text.includes('buildMessage'));
  assert.equal(helper?.metadata?.path, 'test/fixtures/code/sample.ts');
  assert.equal(helper?.metadata?.language, 'typescript');
  assert.ok((helper?.metadata?.startLine as number) < (helper?.metadata?.endLine as number));
});

test('chunksFromCodeFilesAsync uses tree-sitter metadata and splits long symbols monotonically', async () => {
  const body = Array.from({ length: 12 }, (_, index) => `  console.log(${index});`).join('\n');
  const content = `import fs from 'node:fs';

/** large symbol */
export function largeSymbol(): void {
${body}
}

void fs.existsSync;
`;

  const chunks = await chunksFromCodeFilesAsync(
    [
      {
        path: 'src/large.ts',
        content,
        url: 'https://example.com/src/large.ts',
      },
    ],
    { maxLinesPerChunk: 5 },
  );

  const symbolChunks = chunks.filter((chunk) => chunk.metadata?.symbolName === 'largeSymbol');
  assert.ok(symbolChunks.length > 1);

  let previousEnd = 0;
  for (const chunk of symbolChunks) {
    assert.equal(chunk.metadata?.symbolKind, 'function');
    assert.equal(chunk.metadata?.path, 'src/large.ts');
    assert.ok(chunk.text.includes('console.log') || chunk.text.includes('largeSymbol'));
    const startLine = chunk.metadata?.startLine as number;
    const endLine = chunk.metadata?.endLine as number;
    assert.ok(startLine <= endLine);
    assert.ok(startLine > previousEnd);
    previousEnd = endLine;
  }

  assert.equal(symbolChunks[0]?.metadata?.splitIndex, 0);
  assert.equal(symbolChunks.at(-1)?.metadata?.splitTotal, symbolChunks.length);
});
