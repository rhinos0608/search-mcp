import { test, mock } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchResult } from '../src/types.js';
import {
  computeFetchLimit,
  writeWebSearchArtifact,
  buildArtifactNotice,
  safePathText,
  assembleWebSearchResponse,
  sweepArtifacts,
  startArtifactSweeper,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_SWEEP_INTERVAL_MS,
} from '../src/tools/webSearchArtifact.js';
import type { ArtifactFs, ArtifactStats } from '../src/tools/webSearchArtifact.js';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Example title',
    url: 'https://example.com/page',
    description: 'First sentence about the result. Second sentence with more detail.',
    position: 1,
    domain: 'example.com',
    source: 'brave',
    age: null,
    extraSnippet: null,
    deepLinks: null,
    ...overrides,
  };
}

function fakeStats(
  opts: { size?: number; mtimeMs?: number; mode?: number; dir?: boolean; link?: boolean } = {},
): ArtifactStats {
  const size = opts.size ?? 0;
  const mtimeMs = opts.mtimeMs ?? 0;
  const mode = opts.mode ?? 0o600;
  const isDir = opts.dir ?? false;
  const isLink = opts.link ?? false;
  return {
    size,
    mtimeMs,
    mode,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
    isFile: () => !isDir && !isLink,
  };
}

function makeTempDir(prefix = 'ws-art-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function countFiles(dir: string): number {
  return readdirSync(dir).filter((n) => n.endsWith('.md')).length;
}

test('computeFetchLimit is bounded headroom capped at 50', () => {
  assert.strictEqual(computeFetchLimit(10), 15);
  assert.strictEqual(computeFetchLimit(1), 2);
  assert.strictEqual(computeFetchLimit(50), 50);
  assert.strictEqual(computeFetchLimit(40), 50);
});

test('writeWebSearchArtifact creates a 0700 dir and 0600 file with a UUID-only name', () => {
  const dir = makeTempDir();
  try {
    const res = writeWebSearchArtifact('hello world', { baseDir: dir });
    assert.ok(res.path, 'path returned');
    assert.ok(res.complete, 'fits under cap');
    assert.match(res.path, /\/[0-9a-f-]{36}\.md$/, 'filename is a random UUID only');
    assert.strictEqual(res.path, join(dir, res.path.split('/').pop() ?? ''));
    // Directory is 0700 and the file is 0600.
    assert.strictEqual(statSync(dir).mode & 0o777, 0o700);
    assert.strictEqual(statSync(res.path).mode & 0o777, 0o600);
    assert.strictEqual(readFileSync(res.path, 'utf8'), 'hello world');
    // No temp files left behind.
    assert.ok(!readdirSync(dir).some((n) => n.startsWith('tmp-')), 'no temp files remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hostile content never influences the artifact filename', () => {
  const dir = makeTempDir();
  try {
    const hostile =
      '<script>alert(1)</script> .. / ../../etc/passwd [x](javascript:evil) `rm -rf` * _ | \u0000';
    const res = writeWebSearchArtifact(hostile, { baseDir: dir });
    assert.ok(res.path);
    assert.match(
      res.path,
      /\/[0-9a-f-]{36}\.md$/,
      'filename remains a UUID despite hostile content',
    );
    // The file content is the hostile payload verbatim (no shell/fs impact).
    assert.strictEqual(readFileSync(res.path, 'utf8'), hostile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two writes produce unique artifact ids', () => {
  const dir = makeTempDir();
  try {
    const a = writeWebSearchArtifact('aaa', { baseDir: dir });
    const b = writeWebSearchArtifact('bbb', { baseDir: dir });
    assert.ok(a.path && b.path);
    assert.notStrictEqual(a.path, b.path);
    assert.strictEqual(countFiles(dir), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired artifacts are cleaned up by TTL', () => {
  const dir = makeTempDir();
  try {
    const old = writeWebSearchArtifact('old', { baseDir: dir });
    const fresh = writeWebSearchArtifact('fresh', { baseDir: dir });
    assert.ok(old.path && fresh.path);
    assert.strictEqual(countFiles(dir), 2);
    // Age the first artifact beyond a 1h TTL using its real mtime.
    const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old.path, aged, aged);
    // A later write with a 1h TTL evicts the aged artifact and keeps the recent one.
    const latest = writeWebSearchArtifact('latest', { baseDir: dir, ttlMs: 60 * 60 * 1000 });
    assert.ok(latest.path);
    const names = readdirSync(dir).filter((n) => n.endsWith('.md'));
    assert.ok(!names.includes(old.path.split('/').pop() ?? ''), 'aged artifact evicted');
    assert.ok(names.includes(fresh.path.split('/').pop() ?? ''), 'fresh artifact retained');
    assert.ok(names.includes(latest.path.split('/').pop() ?? ''), 'new artifact present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maxFiles capacity evicts oldest artifacts', () => {
  const dir = makeTempDir();
  try {
    const first = writeWebSearchArtifact('one', { baseDir: dir, maxFiles: 2 });
    const second = writeWebSearchArtifact('two', { baseDir: dir, maxFiles: 2 });
    const third = writeWebSearchArtifact('three', { baseDir: dir, maxFiles: 2 });
    assert.ok(first.path && second.path && third.path);
    assert.strictEqual(countFiles(dir), 2);
    const names = readdirSync(dir).filter((n) => n.endsWith('.md'));
    assert.ok(!names.includes(first.path.split('/').pop() ?? ''), 'oldest evicted');
    assert.ok(names.includes(second.path.split('/').pop() ?? ''));
    assert.ok(names.includes(third.path.split('/').pop() ?? ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact content is truncated to the hard byte cap and reports incomplete', () => {
  const dir = makeTempDir();
  try {
    const big = 'x'.repeat(2000);
    const res = writeWebSearchArtifact(big, { baseDir: dir, maxArtifactBytes: 1000 });
    assert.ok(res.path);
    assert.strictEqual(res.complete, false, 'hit hard cap reported');
    const written = readFileSync(res.path, 'utf8');
    assert.strictEqual(Buffer.byteLength(written, 'utf8'), 1000);
    assert.strictEqual(written, 'x'.repeat(1000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write failure returns a null path and assemble emits an unavailable notice with artifactWritten=false', () => {
  const dir = makeTempDir();
  try {
    const failingFs: ArtifactFs = {
      mkdirSync: () => undefined,
      lstatSync: () => fakeStats({ dir: true }),
      chmodSync: () => undefined,
      writeFileSync: () => {
        throw new Error('disk full');
      },
      renameSync: () => undefined,
      readdirSync: () => [],
      unlinkSync: () => undefined,
    };
    const res = writeWebSearchArtifact('data', { baseDir: dir, fs: failingFs });
    assert.strictEqual(res.path, null);

    const notice = buildArtifactNotice(res, 1, 2);
    assert.match(notice, /Full results unavailable/);

    const results = [makeResult(), makeResult()];
    const assembled = assembleWebSearchResponse(results, {
      limit: 1,
      writeArtifact: () => ({ path: null, complete: false }),
    });
    // Fix 7: a failed write (null path) must report artifactWritten = false.
    assert.strictEqual(assembled.artifactWritten, false);
    assert.match(assembled.text, /Full results unavailable \(overflow artifact write failed\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('count overflow emits one unified Showing N of M notice with the artifact path', () => {
  const dir = makeTempDir();
  try {
    const results = [makeResult(), makeResult(), makeResult()];
    const assembled = assembleWebSearchResponse(results, {
      limit: 2,
      writeArtifact: (content) => writeWebSearchArtifact(content, { baseDir: dir }),
    });
    assert.strictEqual(assembled.artifactWritten, true);
    assert.match(assembled.text, /⚠ Showing 2 of 3 results\. Full results: \/.*\.md/);
    // The vague legacy truncation line is gone from the assembled output.
    assert.ok(!assembled.text.includes('Content truncated at output budget'), 'no vague line');
    assert.ok(
      !assembled.text.includes('Full results saved to overflow artifact'),
      'legacy notice gone',
    );
    assert.strictEqual(countFiles(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeArtifact:false suppresses the artifact write and omits the path', () => {
  const dir = makeTempDir();
  try {
    const results = [makeResult(), makeResult(), makeResult()];
    const assembled = assembleWebSearchResponse(results, {
      limit: 1,
      writeArtifact: false,
    });
    assert.strictEqual(assembled.artifactWritten, false, 'no artifact written');
    assert.match(assembled.text, /⚠ Showing 1 of 3 results\.$/);
    assert.ok(!assembled.text.includes('Full results:'), 'no path in the notice');
    assert.strictEqual(countFiles(dir), 0, 'no artifact file created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no artifact when neither count nor bytes truncate', () => {
  const results = [makeResult({ description: 'Only one sentence.' })];
  const assembled = assembleWebSearchResponse(results, { limit: 5 });
  assert.strictEqual(assembled.artifactWritten, false);
  assert.ok(!assembled.text.includes('overflow artifact'), 'no artifact notice');
  assert.match(assembled.text, /Only one sentence\. \[1-1\]/);
});

test('count overflow writes an artifact and appends a notice with the path', () => {
  const dir = makeTempDir();
  try {
    const results = [makeResult(), makeResult(), makeResult()];
    const assembled = assembleWebSearchResponse(results, {
      limit: 2,
      writeArtifact: (content) => writeWebSearchArtifact(content, { baseDir: dir }),
    });
    assert.strictEqual(assembled.artifactWritten, true);
    assert.match(assembled.text, /Showing 2 of 3 results\. Full results: .*\.md/);
    // The returned block respects the default total budget.
    assert.ok(Buffer.byteLength(assembled.text, 'utf8') <= 192 * 1024);
    assert.strictEqual(countFiles(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('byte-truncated preview still writes a complete artifact', () => {
  const dir = makeTempDir();
  try {
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i + 1} with detailed content.`,
    ).join(' ');
    const results = [makeResult({ description: long, contentKind: 'snippet' })];
    const assembled = assembleWebSearchResponse(results, {
      limit: 1,
      totalBudgetBytes: 4 * 1024,
      writeArtifact: (content) => writeWebSearchArtifact(content, { baseDir: dir }),
    });
    assert.strictEqual(assembled.artifactWritten, true);
    // The inline preview is snippet-capped, but the artifact holds the full body.
    const fullText = readFileSync(
      join(dir, readdirSync(dir).filter((n) => n.endsWith('.md'))[0] ?? ''),
      'utf8',
    );
    assert.ok(fullText.includes('Sentence 40 with detailed content.'), 'full body in artifact');
    assert.ok(
      !assembled.text.includes('Sentence 40 with detailed content.'),
      'inline preview is capped',
    );
    assert.ok(
      Buffer.byteLength(assembled.text, 'utf8') <= 4 * 1024,
      'preview + notice within budget',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notice reserves budget so preview plus notice stays within the total budget', () => {
  const results = Array.from({ length: 25 }, (_, i) =>
    makeResult({ description: `Result ${i + 1} with enough content to matter.` }),
  );
  const totalBudget = 8 * 1024;
  const assembled = assembleWebSearchResponse(results, {
    limit: 20,
    totalBudgetBytes: totalBudget,
    writeArtifact: () => ({ path: '/tmp/example-uuid.md', complete: true }),
  });
  assert.strictEqual(assembled.artifactWritten, true);
  assert.ok(
    Buffer.byteLength(assembled.text, 'utf8') <= totalBudget,
    'notice reserved within budget',
  );
  assert.match(assembled.text, /Showing 20 of 25 results\. Full results: \/tmp\/example-uuid\.md/);
});

test('exact reconstruction: artifact file byte-for-byte equals the full rendering', () => {
  const dir = makeTempDir();
  try {
    const results = [
      makeResult({ description: 'First para. Second para sentence.\n\nNext block. Another.' }),
      makeResult(),
    ];
    let captured = '';
    const assembled = assembleWebSearchResponse(results, {
      limit: 1,
      writeArtifact: (content) => {
        captured = content;
        return writeWebSearchArtifact(content, { baseDir: dir });
      },
    });
    assert.strictEqual(assembled.artifactWritten, true);
    const files = readdirSync(dir).filter((n) => n.endsWith('.md'));
    assert.strictEqual(files.length, 1);
    const onDisk = readFileSync(join(dir, files[0] ?? ''), 'utf8');
    assert.strictEqual(onDisk, captured, 'written content matches what was captured');
    assert.ok(onDisk.includes('Next block.'), 'full headroom present in artifact');
    assert.ok(onDisk.includes('## [2]'), 'second result section present in artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hard-cap hit on the full render reports complete=false in the notice', () => {
  const results = [makeResult(), makeResult()];
  const assembled = assembleWebSearchResponse(results, {
    limit: 1,
    writeArtifact: () => ({ path: '/tmp/uuid.md', complete: false }),
  });
  assert.strictEqual(assembled.artifactWritten, true);
  assert.match(assembled.text, /\(truncated at the hard cap\)/);
});

test('safePathText escapes markdown-significant path characters', () => {
  assert.strictEqual(safePathText('/tmp/a[b].md'), '/tmp/a\\[b\\].md');
  assert.strictEqual(safePathText('/tmp/a_b[c].md'), '/tmp/a\\_b\\[c\\].md');
});

test('pre-existing permissive base dir is re-chmodded to 0700 and file is 0600 (real fs)', () => {
  const dir = makeTempDir();
  try {
    chmodSync(dir, 0o777); // simulate an existing permissive directory
    const res = writeWebSearchArtifact('secret', { baseDir: dir });
    assert.ok(res.path, 'write succeeds');
    assert.strictEqual(statSync(dir).mode & 0o777, 0o700, 'existing dir hardened to 0700');
    assert.strictEqual(statSync(res.path).mode & 0o777, 0o600, 'file is 0600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked base directory is rejected (fail closed) (real fs)', () => {
  const real = makeTempDir();
  const link = makeTempDir();
  try {
    symlinkSync(real, join(link, 'base'));
    const res = writeWebSearchArtifact('data', { baseDir: join(link, 'base') });
    assert.strictEqual(res.path, null, 'symlink base refused');
    assert.strictEqual(countFiles(real), 0, 'no artifact written into symlink target');
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(link, { recursive: true, force: true });
  }
});

test('temp leftovers are cleaned and unexpected entries safely ignored during scan', () => {
  const dir = makeTempDir();
  try {
    // Pre-create a stale temp and an unrelated file (e.g. a hidden tag cache).
    writeFileSync(join(dir, 'tmp-stale.md'), 'leftover', { mode: 0o600 });
    writeFileSync(join(dir, '.pi-smartread.tags.cache'), 'irrelevant');
    const res = writeWebSearchArtifact('data', { baseDir: dir });
    assert.ok(res.path, 'write succeeds');
    const names = readdirSync(dir);
    assert.ok(!names.includes('tmp-stale.md'), 'stale temp removed');
    assert.ok(names.includes('.pi-smartread.tags.cache'), 'unexpected entry ignored, not deleted');
    assert.strictEqual(countFiles(dir), 1, 'only the new artifact counts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capacity bypass is refused when unlink fails (fake fs, exact regression)', () => {
  const entries = ['old.md'];
  const fakeFs: ArtifactFs = {
    mkdirSync: () => undefined,
    lstatSync: (p) => {
      const name = p.split('/').pop() ?? '';
      if (name === 'old.md') return fakeStats({ size: 100, mtimeMs: 1, mode: 0o600 });
      if (name.startsWith('tmp-')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return fakeStats({ size: 0, mtimeMs: 1, mode: 0o600 });
    },
    chmodSync: () => undefined,
    writeFileSync: () => undefined,
    renameSync: (_from, to) => {
      entries.push(to.split('/').pop() ?? '');
    },
    readdirSync: () => [...entries],
    unlinkSync: () => {
      throw new Error('EACCES: cannot delete'); // capacity eviction always fails
    },
  };
  const res = writeWebSearchArtifact('new data', {
    baseDir: '/fake/base',
    fs: fakeFs,
    maxFiles: 1,
    now: 1000,
    ttlMs: 100000, // keep old.md live so the capacity eviction (not TTL) is what fails
  });
  assert.strictEqual(res.path, null, 'refuses new artifact when over cap after failed eviction');
});

test('full-render formatter truncation is reflected as truncated in the notice (fix 5)', () => {
  // A single sentence larger than the formatter's 1 MiB full-render cap.
  const huge = 'x'.repeat(ARTIFACT_MAX_BYTES + 5000) + '.';
  const results = [makeResult({ description: huge, contentKind: 'full' })];
  const assembled = assembleWebSearchResponse(results, {
    limit: 1,
    // Writer claims complete; only the formatter truncated.
    writeArtifact: () => ({ path: '/tmp/uuid.md', complete: true }),
  });
  assert.strictEqual(assembled.artifactWritten, true);
  assert.match(
    assembled.text,
    /\(truncated at the hard cap\)/,
    'formatter truncation shown as truncated',
  );
  assert.ok(!assembled.text.includes('(complete)'), 'never falsely claims complete');
});

test('notice that alone exceeds the total budget never pushes the response past the budget', () => {
  const longPath = '/tmp/' + 'a'.repeat(120) + '.md';
  const results = [makeResult(), makeResult()];
  const totalBudget = 20;
  const assembled = assembleWebSearchResponse(results, {
    limit: 1,
    totalBudgetBytes: totalBudget,
    writeArtifact: () => ({ path: longPath, complete: true }),
  });
  assert.ok(
    Buffer.byteLength(assembled.text, 'utf8') <= totalBudget,
    `output ${Buffer.byteLength(assembled.text, 'utf8')} > ${totalBudget}`,
  );
  assert.ok(
    !assembled.text.includes(longPath),
    'oversized path-bearing notice replaced by bounded generic note',
  );
});

test('no false claim of complete when the writer truncated and the formatter did not', () => {
  const results = [makeResult(), makeResult()];
  const assembled = assembleWebSearchResponse(results, {
    limit: 1,
    writeArtifact: () => ({ path: '/tmp/uuid.md', complete: false }),
  });
  assert.strictEqual(assembled.artifactWritten, true);
  assert.match(assembled.text, /\(truncated at the hard cap\)/);
});

test('temp write uses the exclusive wx flag so it never follows an existing temp (TOCTOU fix)', () => {
  const seen: Array<{ flag?: string; mode?: number }> = [];
  const fakeFs: ArtifactFs = {
    mkdirSync: () => undefined,
    lstatSync: (p) => {
      const name = p.split('/').pop() ?? '';
      if (name.endsWith('.md')) return fakeStats({ size: 0, mtimeMs: 1, mode: 0o600 });
      return fakeStats({ dir: true, mode: 0o700 });
    },
    chmodSync: () => undefined,
    writeFileSync: (_p, _data, opts) => {
      seen.push(opts ?? {});
    },
    renameSync: () => undefined,
    readdirSync: () => [],
    unlinkSync: () => undefined,
  };
  const res = writeWebSearchArtifact('data', { baseDir: '/fake/base', fs: fakeFs });
  assert.ok(res.path, 'write reports success');
  assert.strictEqual(seen.length, 1, 'one temp write attempted');
  assert.strictEqual(seen[0]?.flag, 'wx', 'exclusive create flag used');
  assert.strictEqual(seen[0]?.mode, 0o600);
});

test('temp EEXIST (existing temp/symlink) fails closed: no artifact, target untouched', () => {
  let tmpWriteExclusive = false;
  const fakeFs: ArtifactFs = {
    mkdirSync: () => undefined,
    lstatSync: (p) => {
      const name = p.split('/').pop() ?? '';
      if (name.endsWith('.md')) return fakeStats({ size: 0, mtimeMs: 1, mode: 0o600 });
      return fakeStats({ dir: true, mode: 0o700 });
    },
    chmodSync: () => undefined,
    writeFileSync: (_p, _data, opts) => {
      if (opts?.flag === 'wx') {
        tmpWriteExclusive = true;
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
    },
    renameSync: () => {
      assert.fail('rename must not run when the temp write fails');
    },
    readdirSync: () => [],
    unlinkSync: () => undefined,
  };
  const res = writeWebSearchArtifact('data', { baseDir: '/fake/base', fs: fakeFs });
  assert.strictEqual(res.path, null, 'no artifact on EEXIST');
  assert.ok(tmpWriteExclusive, 'exclusive temp write attempted and failed on existing entry');
});

test('sweepArtifacts removes expired artifacts', () => {
  const dir = makeTempDir();
  try {
    const fresh = writeWebSearchArtifact('fresh', { baseDir: dir });
    const stale = writeWebSearchArtifact('stale', { baseDir: dir });
    assert.ok(fresh.path && stale.path, 'two artifacts written');

    const now = Date.now();
    // Age the stale file beyond the TTL; keep the fresh one live.
    utimesSync(stale.path, now / 1000, (now - 2 * 60 * 60 * 1000) / 1000);
    utimesSync(fresh.path, now / 1000, now / 1000);

    sweepArtifacts({ baseDir: dir, ttlMs: 60 * 60 * 1000, now });
    assert.strictEqual(countFiles(dir), 1, 'expired artifact removed');
    assert.strictEqual(readdirSync(dir)[0], fresh.path.split('/').pop(), 'live artifact kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepArtifacts evicts over-capacity artifacts oldest first', () => {
  const dir = makeTempDir();
  try {
    const a = writeWebSearchArtifact('a', { baseDir: dir });
    const b = writeWebSearchArtifact('b', { baseDir: dir });
    const c = writeWebSearchArtifact('c', { baseDir: dir });
    assert.ok(a.path && b.path && c.path, 'three artifacts written');

    const now = Date.now();
    // Give each a distinct live mtime so eviction order is deterministic.
    utimesSync(a.path, now / 1000, (now - 3000) / 1000); // oldest
    utimesSync(b.path, now / 1000, (now - 2000) / 1000);
    utimesSync(c.path, now / 1000, (now - 1000) / 1000); // newest

    sweepArtifacts({ baseDir: dir, maxFiles: 2, now });
    const remaining = readdirSync(dir).filter((n) => n.endsWith('.md'));
    // Standalone sweep uses inclusive capacity: exactly maxFiles live artifacts
    // are kept (oldest evicted first).
    assert.strictEqual(remaining.length, 2, 'exactly maxFiles artifacts remain after sweep');
    const names = remaining.map((n) => n);
    assert.ok(!names.includes(a.path.split('/').pop() ?? ''), 'oldest (a) evicted first');
    assert.ok(names.includes(c.path.split('/').pop() ?? ''), 'newest (c) kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepArtifacts handles an empty artifact directory', () => {
  const dir = makeTempDir();
  try {
    assert.doesNotThrow(() => sweepArtifacts({ baseDir: dir }));
    assert.strictEqual(countFiles(dir), 0, 'still empty after sweep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startArtifactSweeper runs an immediate sweep then a repeating interval', () => {
  let sweepCount = 0;
  const fakeFs: ArtifactFs = {
    mkdirSync: () => undefined,
    lstatSync: () => fakeStats({ dir: true, mode: 0o700 }),
    chmodSync: () => undefined,
    writeFileSync: () => undefined,
    renameSync: () => undefined,
    readdirSync: () => {
      sweepCount += 1;
      return [];
    },
    unlinkSync: () => undefined,
  };

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const timer = startArtifactSweeper({ baseDir: '/fake/base', fs: fakeFs });
    assert.strictEqual(sweepCount, 1, 'immediate startup sweep ran once');

    mock.timers.tick(ARTIFACT_SWEEP_INTERVAL_MS);
    assert.strictEqual(sweepCount, 2, 'interval fired a second sweep');

    // A second interval pass confirms the timer repeats, not just one shot.
    mock.timers.tick(ARTIFACT_SWEEP_INTERVAL_MS);
    assert.strictEqual(sweepCount, 3, 'interval repeats on subsequent passes');

    clearInterval(timer);
  } finally {
    mock.timers.reset();
  }
});
