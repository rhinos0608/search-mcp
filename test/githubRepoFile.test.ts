import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getGitHubRepoFile } from '../src/tools/githubRepoFile.js';
import { resetTrackers } from '../src/rateLimit.js';
import { TRUNCATED_MARKER } from '../src/httpGuards.js';

// ── Test isolation ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetTrackers();
});

afterEach(() => {
  resetTrackers();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(
  body: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

/** Encode a string to base64 the way GitHub does. */
function btoa(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

// ── Basic file read ─────────────────────────────────────────────────────────

test('getGitHubRepoFile returns decoded content when raw=true', async () => {
  const fileContent = 'Hello, world!';
  const encoded = btoa(fileContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'hello.txt',
      path: 'hello.txt',
      sha: 'abc123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/hello.txt',
      url: 'https://api.github.com/repos/o/r/contents/hello.txt',
    });

  const result = await getGitHubRepoFile('o', 'r', 'hello.txt', 'main', true);

  assert.equal(result.name, 'hello.txt');
  assert.equal(result.path, 'hello.txt');
  assert.equal(result.sha, 'abc123');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.content, fileContent);
  assert.equal(result.truncated, false);
  assert.equal(result.isBinary, false);
  assert.equal(result.htmlUrl, 'https://github.com/o/r/blob/main/hello.txt');
});

test('getGitHubRepoFile emits a code element for decoded raw content', async () => {
  const fileContent = 'const answer: number = 42;';
  const encoded = btoa(fileContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'answer.ts',
      path: 'src/answer.ts',
      sha: 'abc123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/src/answer.ts',
      url: 'https://api.github.com/repos/o/r/contents/src/answer.ts',
    });

  const result = await getGitHubRepoFile('o', 'r', 'src/answer.ts', 'main', true);

  assert.equal(result.elements?.[0]?.type, 'code');
  const code = result.elements?.[0];
  if (code?.type === 'code') {
    assert.equal(code.language, 'typescript');
    assert.equal(code.content, fileContent);
  }
});

test('getGitHubRepoFile returns base64 when raw=false', async () => {
  const fileContent = 'Hello, world!';
  const encoded = btoa(fileContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'hello.txt',
      path: 'hello.txt',
      sha: 'abc123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/hello.txt',
      url: 'https://api.github.com/repos/o/r/contents/hello.txt',
    });

  const result = await getGitHubRepoFile('o', 'r', 'hello.txt', 'main', false);

  assert.equal(result.encoding, 'base64');
  assert.equal(result.content, encoded);
  assert.equal(result.isBinary, false);
});

test('getGitHubRepoFile emits code elements from decoded content when raw=false', async () => {
  const fileContent = 'print("hello")';
  const encoded = btoa(fileContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'hello.py',
      path: 'hello.py',
      sha: 'abc123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/hello.py',
      url: 'https://api.github.com/repos/o/r/contents/hello.py',
    });

  const result = await getGitHubRepoFile('o', 'r', 'hello.py', 'main', false);

  assert.equal(result.encoding, 'base64');
  assert.equal(result.content, encoded);
  assert.equal(result.elements?.[0]?.type, 'code');
  const code = result.elements?.[0];
  if (code?.type === 'code') {
    assert.equal(code.language, 'python');
    assert.equal(code.content, fileContent);
  }
});

test('getGitHubRepoFile returns base64 when raw=true but file is binary', async () => {
  // Binary content: "hello\x00world" (null byte in the middle)
  const binaryContent = 'hello\x00world';
  const encoded = btoa(binaryContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'binary.bin',
      path: 'binary.bin',
      sha: 'bin123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/binary.bin',
      url: 'https://api.github.com/repos/o/r/contents/binary.bin',
    });

  const result = await getGitHubRepoFile('o', 'r', 'binary.bin', 'main', true);

  assert.equal(result.encoding, 'base64');
  assert.equal(result.content, encoded);
  assert.equal(result.isBinary, true);
  assert.equal(result.truncated, false);
});

test('getGitHubRepoFile returns base64 for binary even when raw=false', async () => {
  const binaryContent = '\x89PNG\r\n\x1a\n';
  const encoded = btoa(binaryContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'image.png',
      path: 'image.png',
      sha: 'png123',
      size: encoded.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/image.png',
      url: 'https://api.github.com/repos/o/r/contents/image.png',
    });

  const result = await getGitHubRepoFile('o', 'r', 'image.png', 'main', false);

  assert.equal(result.encoding, 'base64');
  assert.equal(result.content, encoded);
  assert.equal(result.isBinary, true);
});

test('getGitHubRepoFile without branch param omits ref', async () => {
  let fetchedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    return buildMockResponse({
      name: 'foo.txt',
      path: 'foo.txt',
      sha: 'sha1',
      size: 10,
      encoding: 'base64',
      content: btoa('foo'),
      html_url: 'https://github.com/o/r/blob/main/foo.txt',
      url: 'https://api.github.com/repos/o/r/contents/foo.txt',
    });
  };

  await getGitHubRepoFile('o', 'r', 'foo.txt', undefined, true);

  assert.ok(fetchedUrl!.includes('repos/o/r/contents/foo.txt'));
  assert.ok(!fetchedUrl!.includes('?ref='));
});

test('getGitHubRepoFile with branch param includes ref', async () => {
  let fetchedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    return buildMockResponse({
      name: 'bar.txt',
      path: 'bar.txt',
      sha: 'sha2',
      size: 10,
      encoding: 'base64',
      content: btoa('bar'),
      html_url: 'https://github.com/o/r/blob/develop/bar.txt',
      url: 'https://api.github.com/repos/o/r/contents/bar.txt?ref=develop',
    });
  };

  await getGitHubRepoFile('o', 'r', 'bar.txt', 'develop', true);

  assert.ok(fetchedUrl!.includes('?ref=develop'));
});

// ── Directory rejection ─────────────────────────────────────────────────────

test('getGitHubRepoFile throws validationError when path is a directory', async () => {
  globalThis.fetch = async () =>
    buildMockResponse([
      {
        name: 'src',
        path: 'src',
        type: 'dir',
        sha: 'dir-sha',
        html_url: 'https://github.com/o/r/tree/main/src',
        url: 'https://api.github.com/repos/o/r/contents/src?ref=main',
      },
    ]);

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'src', 'main'),
    (err: unknown) => {
      return (
        err instanceof Error &&
        /directory/i.test(err.message) &&
        /github_repo_tree/i.test(err.message)
      );
    },
  );
});

// ── Submodule rejection ─────────────────────────────────────────────────────

test('getGitHubRepoFile throws validationError when path is a submodule', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'submodule',
      path: 'submodule',
      type: 'submodule',
      sha: 'sub-sha',
      html_url: 'https://github.com/o/r/tree/main/submodule',
      url: 'https://api.github.com/repos/o/r/contents/submodule?ref=main',
    });

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'submodule', 'main'),
    (err: unknown) => {
      return err instanceof Error && /submodule/i.test(err.message);
    },
  );
});

// ── Symlink following ───────────────────────────────────────────────────────

test('getGitHubRepoFile follows symlink and returns target file content', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: symlink entry
      return buildMockResponse({
        name: 'link.txt',
        path: 'link.txt',
        type: 'symlink',
        sha: 'sym-sha',
        size: 10,
        encoding: 'base64',
        content: btoa('actual.txt'),
        html_url: 'https://github.com/o/r/blob/main/link.txt',
        url: 'https://api.github.com/repos/o/r/contents/link.txt?ref=main',
      });
    } else {
      // Second call: target file
      return buildMockResponse({
        name: 'actual.txt',
        path: 'actual.txt',
        type: 'file',
        sha: 'target-sha',
        size: 20,
        encoding: 'base64',
        content: btoa('real content here'),
        html_url: 'https://github.com/o/r/blob/main/actual.txt',
        url: 'https://api.github.com/repos/o/r/contents/actual.txt?ref=main',
      });
    }
  };

  const result = await getGitHubRepoFile('o', 'r', 'link.txt', 'main', true);

  assert.equal(callCount, 2);
  assert.equal(result.name, 'actual.txt');
  assert.equal(result.content, 'real content here');
  assert.equal(result.truncated, false);
  assert.equal(result.isBinary, false);
});

// ── Symlink edge cases ────────────────────────────────────────────────────────

test('getGitHubRepoFile throws validationError when symlink points to a directory', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: symlink entry
      return buildMockResponse({
        name: 'link-to-dir',
        path: 'link-to-dir',
        type: 'symlink',
        sha: 'sym-sha',
        size: 5,
        encoding: 'base64',
        content: btoa('subdir'),
        html_url: 'https://github.com/o/r/blob/main/link-to-dir',
        url: 'https://api.github.com/repos/o/r/contents/link-to-dir?ref=main',
      });
    } else {
      // Second call: target is a directory
      return buildMockResponse([{ name: 'file.txt', path: 'subdir/file.txt', type: 'file' }]);
    }
  };

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'link-to-dir', 'main'),
    (err: unknown) => {
      return err instanceof Error && /directory/i.test(err.message);
    },
  );
});

test('getGitHubRepoFile throws notFoundError when symlink points to a non-existent file', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: symlink entry
      return buildMockResponse({
        name: 'dead-link',
        path: 'dead-link',
        type: 'symlink',
        sha: 'sym-sha',
        size: 20,
        encoding: 'base64',
        content: btoa('nonexistent/deep/path.txt'),
        html_url: 'https://github.com/o/r/blob/main/dead-link',
        url: 'https://api.github.com/repos/o/r/contents/dead-link?ref=main',
      });
    } else {
      // Second call: target not found
      return buildMockResponse({ message: 'Not Found' }, { status: 404 });
    }
  };

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'dead-link', 'main'),
    (err: unknown) => {
      return err instanceof Error && /not found/i.test(err.message);
    },
  );
});

test('getGitHubRepoFile throws validationError when symlink chain exceeds max depth', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    // All calls return a symlink pointing to another symlink (circular/too-deep chain)
    return buildMockResponse({
      name: `link${callCount}.txt`,
      path: `link${callCount}.txt`,
      type: 'symlink',
      sha: `sym-sha-${callCount}`,
      size: 10,
      encoding: 'base64',
      content: btoa(`next-link${callCount}.txt`),
      html_url: `https://github.com/o/r/blob/main/link${callCount}.txt`,
      url: `https://api.github.com/repos/o/r/contents/link${callCount}.txt?ref=main`,
    });
  };

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'link1.txt', 'main'),
    (err: unknown) => {
      return (
        err instanceof Error && /cycle|circular|depth/i.test(err.message) && /5/i.test(err.message)
      );
    },
  );

  assert.ok(callCount > 1, 'Should have followed several links before failing');
});

// ── Oversized file truncation ────────────────────────────────────────────────

test('getGitHubRepoFile truncates files larger than 50 KB', async () => {
  // Build a file larger than 50 KB
  const largeContent = 'x'.repeat(60 * 1024);
  const encoded = btoa(largeContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'large.txt',
      path: 'large.txt',
      sha: 'large-sha',
      size: largeContent.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/large.txt',
      url: 'https://api.github.com/repos/o/r/contents/large.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'large.txt', 'main', true);

  assert.equal(result.truncated, true);
  assert.ok(result.content.length < encoded.length, 'Content should be shorter than full base64');
  assert.ok(result.content.endsWith(TRUNCATED_MARKER), 'Content should end with truncation marker');
  assert.equal(result.elements?.[0]?.type, 'code');
  const code = result.elements?.[0];
  if (code?.type === 'code') {
    assert.equal(code.truncated, true);
    assert.ok((code.originalLength ?? 0) > 50_000);
    assert.ok(code.content.endsWith(TRUNCATED_MARKER));
  }
});

test('getGitHubRepoFile truncates large text file returned as base64 (raw=false)', async () => {
  // Build a file larger than 50 KB
  const largeContent = 'x'.repeat(60 * 1024);
  const encoded = btoa(largeContent);

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'large.txt',
      path: 'large.txt',
      sha: 'large-sha',
      size: largeContent.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/large.txt',
      url: 'https://api.github.com/repos/o/r/contents/large.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'large.txt', 'main', false);

  assert.equal(result.truncated, true);
  assert.equal(result.encoding, 'base64', 'Should return base64 when raw=false');
  // The returned base64 should be shorter than the original
  assert.ok(
    result.content.length < encoded.length,
    `Expected truncated base64 (${result.content.length} chars) < original (${encoded.length} chars)`,
  );
  // Decoding the truncated base64 should yield the truncated text with marker
  const decoded = Buffer.from(result.content, 'base64').toString('utf-8');
  assert.ok(
    decoded.endsWith(TRUNCATED_MARKER),
    'Decoded content should end with truncation marker',
  );
  assert.equal(result.elements?.[0]?.type, 'code');
  const code = result.elements?.[0];
  if (code?.type === 'code') {
    assert.equal(code.truncated, true);
    assert.equal(code.originalLength, decoded.length);
    assert.ok(code.content.endsWith(TRUNCATED_MARKER));
  }
});

test('getGitHubRepoFile truncates large binary file returned as base64', async () => {
  // Build binary content larger than 50 KB using actual binary data (PNG header pattern)
  const chunkSize = 60 * 1024;
  const largeBinaryBuffer = Buffer.alloc(chunkSize);
  for (let i = 0; i < chunkSize; i++) {
    largeBinaryBuffer[i] = i % 256;
  }
  const largeBinary = largeBinaryBuffer.toString('latin1');
  const encoded = largeBinaryBuffer.toString('base64');

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'large.bin',
      path: 'large.bin',
      sha: 'large-bin-sha',
      size: largeBinary.length,
      encoding: 'base64',
      content: encoded,
      html_url: 'https://github.com/o/r/blob/main/large.bin',
      url: 'https://api.github.com/repos/o/r/contents/large.bin?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'large.bin', 'main', true);

  assert.equal(result.truncated, true);
  assert.equal(result.encoding, 'base64', 'Should return base64 for binary');
  assert.equal(result.isBinary, true, 'Should be marked as binary');
  // The returned base64 should be shorter than the original
  assert.ok(
    result.content.length < encoded.length,
    `Expected truncated base64 (${result.content.length} chars) < original (${encoded.length} chars)`,
  );
  // Remove the truncation marker to get the pure base64 content
  const base64WithoutMarker = result.content.slice(0, -TRUNCATED_MARKER.length);
  // Decoding the truncated base64 should yield the original bytes (up to truncation point)
  const decoded = Buffer.from(base64WithoutMarker, 'base64');
  // The decoded bytes should exactly match the original bytes up to the truncation point
  const expectedTruncLen = 50_000 - (50_000 % 3);
  assert.equal(
    decoded.length,
    expectedTruncLen,
    `Expected decoded length ${expectedTruncLen}, got ${decoded.length}`,
  );
  const originalSlice = largeBinaryBuffer.slice(0, expectedTruncLen);
  assert.ok(
    decoded.equals(originalSlice),
    'Decoded bytes should match original bytes up to truncation point',
  );
});

// ── 404 handling ───────────────────────────────────────────────────────────

test('getGitHubRepoFile throws notFoundError on 404', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'nonexistent.txt', 'main'),
    (err: unknown) => {
      return err instanceof Error && /not found/i.test(err.message);
    },
  );
});

// ── 403 large file handling ─────────────────────────────────────────────────

test('getGitHubRepoFile throws validationError with raw URL on 403 for large file', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      { message: 'This file is too large' },
      { status: 403, statusText: 'Forbidden' },
    );

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'large.bin', 'main'),
    (err: unknown) => {
      return (
        err instanceof Error &&
        /raw\.githubusercontent\.com/i.test(err.message) &&
        /large\.bin/i.test(err.message)
      );
    },
  );
});

// ── Rate limit handling ─────────────────────────────────────────────────────

test('getGitHubRepoFile throws rateLimitError on 429', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      { message: 'Rate limit exceeded' },
      { status: 429, statusText: 'Too Many Requests' },
    );

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'file.txt', 'main'),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

test('getGitHubRepoFile throws rateLimitError on 403', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });

  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'file.txt', 'main'),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

// ── URL encoding ────────────────────────────────────────────────────────────

test('getGitHubRepoFile encodes path segments individually preserving slashes', async () => {
  let fetchedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    return buildMockResponse({
      name: 'file.ts',
      path: 'src/lib/file.ts',
      sha: 'sha1',
      size: 100,
      encoding: 'base64',
      content: btoa('code'),
      html_url: 'https://github.com/o/r/blob/main/src/lib/file.ts',
      url: 'https://api.github.com/repos/o/r/contents/src/lib/file.ts?ref=main',
    });
  };

  await getGitHubRepoFile('owner', 'repo', 'src/lib/file.ts', 'main', true);

  // URL must contain "src/lib/file.ts" with literal slashes
  assert.ok(
    fetchedUrl!.includes('src/lib/file.ts'),
    `Expected "src/lib/file.ts" in URL but got: ${fetchedUrl}`,
  );
  assert.ok(
    !fetchedUrl!.includes('src%2Flib'),
    `Found "src%2Flib" (should not encode internal slashes) in URL: ${fetchedUrl}`,
  );
});

test('getGitHubRepoFile encodes special characters in path', async () => {
  let fetchedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    return buildMockResponse({
      name: 'file #1.txt',
      path: 'docs/file #1.txt',
      sha: 'sha1',
      size: 10,
      encoding: 'base64',
      content: btoa('hello'),
      html_url: 'https://github.com/o/r/blob/main/docs/file%20%231.txt',
      url: 'https://api.github.com/repos/o/r/contents/docs/file%20%231.txt?ref=main',
    });
  };

  await getGitHubRepoFile('o', 'r', 'docs/file #1.txt', 'main', true);

  // The space and # should be encoded
  assert.ok(
    fetchedUrl!.includes('docs/file%20%231.txt'),
    `Expected encoded path in URL but got: ${fetchedUrl}`,
  );
});

// ── Line range tests ─────────────────────────────────────────────────────────

test('getGitHubRepoFile slices lines with offset and limit', async () => {
  const lines = ['line0', 'line1', 'line2', 'line3', 'line4', 'line5'];
  const content = lines.join('\n');

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, 2, 3);

  assert.equal(result.content, 'line2\nline3\nline4');
  assert.equal(result.totalLines, 6);
  assert.equal(result.lineOffset, 2);
  assert.equal(result.lineLimit, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.encoding, 'utf-8');
});

test('getGitHubRepoFile reads from offset to end when limit is omitted', async () => {
  const content = 'a\nb\nc\nd\ne';

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, 3);

  assert.equal(result.content, 'd\ne');
  assert.equal(result.totalLines, 5);
  assert.equal(result.lineOffset, 3);
  assert.equal(result.lineLimit, null);
  assert.equal(result.hasMore, false);
});

test('getGitHubRepoFile reads first N lines when only limit is specified', async () => {
  const content = 'a\nb\nc\nd\ne';

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, undefined, 2);

  assert.equal(result.content, 'a\nb');
  assert.equal(result.totalLines, 5);
  assert.equal(result.lineOffset, 0);
  assert.equal(result.lineLimit, 2);
  assert.equal(result.hasMore, true);
});

test('getGitHubRepoFile returns empty content when offset exceeds total lines', async () => {
  const content = 'a\nb';

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, 10, 5);

  assert.equal(result.content, '');
  assert.equal(result.totalLines, 2);
  assert.equal(result.lineOffset, 10);
  assert.equal(result.lineLimit, 5);
  assert.equal(result.hasMore, false);
});

test('getGitHubRepoFile handles CRLF line endings in line ranges', async () => {
  const content = 'line0\r\nline1\r\nline2\r\nline3';

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, 1, 2);

  // Should normalize to LF in output
  assert.equal(result.content, 'line1\nline2');
  assert.equal(result.totalLines, 4);
});

test('getGitHubRepoFile throws validationError for line range with raw=false', async () => {
  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'file.txt', 'main', false, 0, 10),
    (err: unknown) => {
      return (
        err instanceof Error && /line ranges/i.test(err.message) && /raw=true/i.test(err.message)
      );
    },
  );
});

test('getGitHubRepoFile throws validationError when both line and byte ranges specified', async () => {
  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, 0, 10, 0, 100),
    (err: unknown) => {
      return err instanceof Error && /both/i.test(err.message) && /line ranges/i.test(err.message);
    },
  );
});

test('getGitHubRepoFile throws validationError for negative offset', async () => {
  await assert.rejects(
    async () => getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, -1, 10),
    (err: unknown) => {
      return err instanceof Error && /offset must be/i.test(err.message);
    },
  );
});

// ── Byte range tests ─────────────────────────────────────────────────────────

test('getGitHubRepoFile fetches byte range via raw.githubusercontent.com', async () => {
  let fetchedUrl: string | undefined;
  let fetchedHeaders: Headers | undefined;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes('api.github.com')) {
      return buildMockResponse({
        name: 'file.txt',
        path: 'file.txt',
        sha: 'sha1',
        size: 100,
        encoding: 'base64',
        content: btoa('abcdefghijklmnopqrstuvwxyz'),
        html_url: 'https://github.com/o/r/blob/main/file.txt',
        url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
      });
    }
    // raw.githubusercontent.com call
    fetchedUrl = urlStr;
    fetchedHeaders = new Headers(init?.headers);
    return new Response('klmnopqrst', {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'content-range': 'bytes 10-19/100',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  };

  const result = await getGitHubRepoFile(
    'o',
    'r',
    'file.txt',
    'main',
    true,
    undefined,
    undefined,
    10,
    10,
  );

  assert.ok(fetchedUrl!.includes('raw.githubusercontent.com'));
  assert.equal(fetchedHeaders!.get('Range'), 'bytes=10-19');
  assert.equal(result.content, 'klmnopqrst');
  assert.equal(result.byteOffset, 10);
  assert.equal(result.byteLimit, 10);
  assert.equal(result.hasMore, true); // 19 < 99 (totalBytes - 1)
  assert.equal(result.totalLines, 1); // 'klmnopqrst' has no newline
});

test('getGitHubRepoFile byte range with only byteOffset sends open-ended Range', async () => {
  let fetchedHeaders: Headers | undefined;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes('api.github.com')) {
      return buildMockResponse({
        name: 'file.txt',
        path: 'file.txt',
        sha: 'sha1',
        size: 100,
        encoding: 'base64',
        content: btoa('abcdefghijklmnopqrstuvwxyz'),
        html_url: 'https://github.com/o/r/blob/main/file.txt',
        url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
      });
    }
    fetchedHeaders = new Headers(init?.headers);
    return new Response('klmnopqrstuvwxyz', {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'content-range': 'bytes 10-/100',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  };

  await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true, undefined, undefined, 10, undefined);

  assert.equal(fetchedHeaders!.get('Range'), 'bytes=10-');
});

// ── Large file fallback for line ranges ─────────────────────────────────────

test('getGitHubRepoFile falls back to raw.githubusercontent.com for line range on 403 large file', async () => {
  let callCount = 0;

  globalThis.fetch = async (url: string | URL | Request) => {
    callCount++;
    const urlStr = url.toString();
    if (urlStr.includes('api.github.com')) {
      return new Response(JSON.stringify({ message: 'This file is too large' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'application/json' },
      });
    }
    // raw.githubusercontent.com fallback
    return new Response('line0\nline1\nline2\nline3\nline4', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  };

  const result = await getGitHubRepoFile('o', 'r', 'large.txt', 'main', true, 1, 3);

  // 3 calls: initial API fetch, re-fetch for 403 error text, raw.githubusercontent.com fallback
  assert.equal(callCount, 3);
  assert.equal(result.content, 'line1\nline2\nline3');
  assert.equal(result.totalLines, 5);
  assert.equal(result.lineOffset, 1);
  assert.equal(result.hasMore, true);
});

// ── Metadata fields ──────────────────────────────────────────────────────────

test('getGitHubRepoFile includes totalLines and hasMore for default read', async () => {
  const content = 'line1\nline2\nline3';

  globalThis.fetch = async () =>
    buildMockResponse({
      name: 'file.txt',
      path: 'file.txt',
      sha: 'sha1',
      size: content.length,
      encoding: 'base64',
      content: btoa(content),
      html_url: 'https://github.com/o/r/blob/main/file.txt',
      url: 'https://api.github.com/repos/o/r/contents/file.txt?ref=main',
    });

  const result = await getGitHubRepoFile('o', 'r', 'file.txt', 'main', true);

  assert.equal(result.totalLines, 3);
  assert.equal(result.lineOffset, 0);
  assert.equal(result.lineLimit, null);
  assert.equal(result.hasMore, false);
  assert.equal(result.byteOffset, null);
  assert.equal(result.byteLimit, null);
  assert.equal(result.truncated, false);
});
