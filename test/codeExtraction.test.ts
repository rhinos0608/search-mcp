import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/chunking.js';

test('chunkMarkdown extracts code block metadata with language', () => {
  const markdown = `# Example

Here is a Python class:

\`\`\`python
from dataclasses import dataclass
from typing import Optional, List

@dataclass
class Fibonacci:
    """Memoized Fibonacci sequence generator."""
    max_n: int
    _cache: Optional[dict] = None

    def __post_init__(self):
        if self._cache is None:
            self._cache = {0: 0, 1: 1}
        self._precompute()

    def _precompute(self) -> None:
        """Pre-compute all values up to max_n."""
        for n in range(2, self.max_n + 1):
            if n not in self._cache:
                self._cache[n] = self._cache[n - 1] + self._cache[n - 2]

    def get(self, n: int) -> int:
        if n < 0:
            raise ValueError("n must be non-negative")
        return self._cache.get(n, -1)

    def sequence(self) -> List[int]:
        return [self._cache[i] for i in range(self.max_n + 1)]

fib = Fibonacci(20)
print(fib.sequence())
\`\`\`
`;

  const chunks = chunkMarkdown(markdown, 'https://example.com');
  assert.ok(chunks.length >= 1);

  const codeChunk = chunks.find((c) => c.metadata?.codeFence === true);
  assert.ok(codeChunk !== undefined, 'Should find a chunk with codeFence metadata');
  assert.ok(codeChunk?.metadata?.codeBlocks !== undefined, 'Should have codeBlocks array');
  assert.ok(
    (codeChunk?.metadata?.codeBlocks?.length ?? 0) > 0,
    'Should have at least one code block',
  );

  const block = codeChunk?.metadata?.codeBlocks?.[0];
  assert.equal(block?.language, 'python');
  assert.ok((block?.length ?? 0) > 200, `Code block should be >= 200 chars, got ${block?.length}`);
});

test('chunkMarkdown skips short code blocks', () => {
  const markdown = `# Quick Example

\`\`\`javascript
console.log("hello");
\`\`\`
`;

  const chunks = chunkMarkdown(markdown, 'https://example.com');

  for (const chunk of chunks) {
    const codeBlocks = chunk.metadata?.codeBlocks;
    if (chunk.metadata?.codeFence === true) {
      assert.ok(
        codeBlocks === undefined || codeBlocks.length === 0,
        'Short code block should not appear in codeBlocks',
      );
    }
  }
});

test('chunkMarkdown extracts multiple code blocks', () => {
  const markdown = `# Multiple Examples

\`\`\`typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function hashFile(path: string): string {
  const content = readFileSync(path, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function listFiles(dir: string): string[] {
  const fs = require('fs');
  return fs.readdirSync(dir)
    .filter((f: string) => f.endsWith('.ts'))
    .map((f: string) => join(dir, f));
}

const dir = process.argv[2] || '.';
const files = listFiles(dir);
for (const file of files) {
  console.log(\`\${file}: \${hashFile(file)}\`);
}
\`\`\`

\`\`\`python
import hashlib
from pathlib import Path

def hash_file(path: str) -> str:
    content = Path(path).read_text()
    return hashlib.sha256(content.encode()).hexdigest()

def list_files(directory: str) -> list[str]:
    return [
        str(p) for p in Path(directory).rglob("*.py")
        if p.is_file()
    ]

def main():
    import sys
    directory = sys.argv[1] if len(sys.argv) > 1 else "."
    for file in list_files(directory):
        print(f"{file}: {hash_file(file)}")

if __name__ == "__main__":
    main()
\`\`\`
`;

  const chunks = chunkMarkdown(markdown, 'https://example.com');
  const codeChunk = chunks.find((c) => c.metadata?.codeFence === true);
  assert.ok(codeChunk !== undefined);

  const blocks = codeChunk?.metadata?.codeBlocks ?? [];
  assert.equal(
    blocks.length,
    2,
    'Should find two code blocks >= 300 chars',
  );
  assert.equal(blocks[0]?.language, 'typescript');
  assert.equal(blocks[1]?.language, 'python');
});

test('chunkMarkdown handles pages with no code blocks', () => {
  const markdown = `# Simple Page

This is just a regular page with some text.

- List item 1
- List item 2

**Bold text** and *italic text*.
`;

  const chunks = chunkMarkdown(markdown, 'https://example.com');
  for (const chunk of chunks) {
    assert.equal(chunk.metadata?.codeBlocks, undefined);
  }
});
