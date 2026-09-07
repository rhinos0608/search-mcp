import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm, symlink, writeFile, link } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readTrustedProfileFile } from '../../src/jobs/profile/reader.js';

const input = (
  path: string,
  contentType: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json' = 'text/plain',
) => ({
  kind: 'trusted_root_file' as const,
  path,
  contentType,
  sizeBytes: 1,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-reader-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('reads bounded UTF-8 text only from explicit trusted root', async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'profile.txt'), 'TypeScript engineer', 'utf8');
    const result = await readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root] });
    assert.equal(result.content, 'TypeScript engineer');
    assert.deepEqual(result.metadata, {
      extension: '.txt',
      contentType: 'text/plain',
      sizeBytes: 19,
    });
  } finally {
    await cleanup();
  }
});

test('rejects empty roots, URI paths, traversal, and HOME fallback', async () => {
  await assert.rejects(() => readTrustedProfileFile(input('profile.txt'), { trustedRoots: [] }));
  await assert.rejects(() =>
    readTrustedProfileFile(input('file:///tmp/profile.txt'), { trustedRoots: ['/tmp'] }),
  );
  await assert.rejects(() =>
    readTrustedProfileFile(input('../profile.txt'), { trustedRoots: ['/tmp'] }),
  );
  await assert.rejects(() =>
    readTrustedProfileFile(input('profile.txt'), {
      trustedRoots: [join(tmpdir(), 'missing-profile-root')],
    }),
  );
});

test('rejects symlink ancestors, final symlink, and outside paths', async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'profile-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'linked-dir'));
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    await assert.rejects(() =>
      readTrustedProfileFile(input('linked-dir/secret.txt'), { trustedRoots: [root] }),
    );
    await assert.rejects(() =>
      readTrustedProfileFile(input('linked.txt'), { trustedRoots: [root] }),
    );
    await assert.rejects(() =>
      readTrustedProfileFile(input(join(outside, 'secret.txt')), { trustedRoots: [root] }),
    );
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects size growth, binary/NUL, invalid UTF-8, and type mismatch', async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'large.txt'), '1234567890', 'utf8');
    await assert.rejects(() =>
      readTrustedProfileFile(input('large.txt'), { trustedRoots: [root], maxBytes: 5 }),
    );
    await writeFile(join(root, 'binary.txt'), Buffer.from([0x41, 0]));
    await assert.rejects(() =>
      readTrustedProfileFile(input('binary.txt'), { trustedRoots: [root] }),
    );
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(() =>
      readTrustedProfileFile(input('invalid.txt'), { trustedRoots: [root] }),
    );
    await writeFile(join(root, 'data.json'), '{}', 'utf8');
    await assert.rejects(() =>
      readTrustedProfileFile(input('data.json', 'text/plain'), { trustedRoots: [root] }),
    );
  } finally {
    await cleanup();
  }
});

test('rejects replacement detected after safe open', async () => {
  const { root, cleanup } = await fixture();
  try {
    const path = join(root, 'profile.txt');
    await writeFile(path, 'profile', 'utf8');
    let candidateStats = 0;
    const fileSystem = {
      lstat: async (target: string) => {
        const stats = await fs.lstat(target);
        if (target.endsWith('profile.txt') && ++candidateStats === 2) {
          Object.defineProperty(stats, 'ino', { value: Number(stats.ino) + 1 });
        }
        return stats;
      },
      realpath: fs.realpath,
      open: fs.open,
    };
    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root], fileSystem }),
    );
  } finally {
    await cleanup();
  }
});

test('rejects filesystem root, HOME, and .ssh self-grants', async () => {
  await assert.rejects(() => readTrustedProfileFile(input('profile.txt'), { trustedRoots: ['/'] }));
  await assert.rejects(() =>
    readTrustedProfileFile(input('profile.txt'), { trustedRoots: [homedir()] }),
  );
  await assert.rejects(() =>
    readTrustedProfileFile(input('profile.txt'), {
      trustedRoots: [join(homedir(), '.ssh', 'nested')],
    }),
  );
});

test('rejects canonical HOME aliases before candidate access', async () => {
  const { root, cleanup } = await fixture();
  try {
    const configuredHome = homedir();
    const configuredAlias = root.toUpperCase();
    const canonicalHome = '/tmp/Canonical-Home';
    const candidateAccesses: string[] = [];
    const fileSystem = {
      lstat: async (target: string) => {
        if (target === configuredAlias) return fs.lstat(root);
        candidateAccesses.push(target);
        return fs.lstat(target);
      },
      realpath: async (target: string) => {
        if (target === configuredHome || target === configuredAlias) return canonicalHome;
        return fs.realpath(target);
      },
      open: fs.open,
    };

    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), {
        trustedRoots: [configuredAlias],
        fileSystem,
      }),
    );
    assert.deepEqual(candidateAccesses, []);
  } finally {
    await cleanup();
  }
});

test('rejects hardlink aliases and sanitizes open errors', async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'profile-hardlink-'));
  try {
    const source = join(outside, 'secret.txt');
    const alias = join(root, 'profile.txt');
    await writeFile(source, 'secret', 'utf8');
    await link(source, alias);
    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root] }),
    );
    await writeFile(join(root, 'open-target.txt'), 'secret', 'utf8');
    const errorPath = join(root, 'open-target.txt');
    const fileSystem = {
      lstat: fs.lstat,
      realpath: fs.realpath,
      open: async () => {
        throw new Error(`open failed for ${errorPath}`);
      },
    };
    await assert.rejects(
      () => readTrustedProfileFile(input('open-target.txt'), { trustedRoots: [root], fileSystem }),
      (error: Error) => error.message === 'Profile file rejected: file cannot be opened',
    );
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects injected trusted-root replacement', async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'profile.txt'), 'profile', 'utf8');
    const canonicalRoot = await fs.realpath(root);
    let rootChecks = 0;
    const fileSystem = {
      lstat: async (target: string) => {
        const stats = await fs.lstat(target);
        if (target === canonicalRoot && ++rootChecks >= 2) throw new Error('root replaced');
        return stats;
      },
      realpath: fs.realpath,
      open: fs.open,
    };
    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root], fileSystem }),
    );
  } finally {
    await cleanup();
  }
});

test('rejects root replacement before candidate access', async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'profile-root-replacement-'));
  try {
    await writeFile(join(root, 'profile.txt'), 'profile', 'utf8');
    await writeFile(join(outside, 'profile.txt'), 'outside', 'utf8');
    let opens = 0;
    let candidateBytes = 0;
    const fileSystem = {
      lstat: fs.lstat,
      realpath: async (target: string) => (target === root ? outside : fs.realpath(target)),
      open: async (target: string, flags: string | number) => {
        opens += 1;
        const handle = await fs.open(target, flags);
        const read = handle.read.bind(handle);
        handle.read = async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          candidateBytes += result.bytesRead;
          return result;
        };
        return handle;
      },
    };

    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root], fileSystem }),
    );
    assert.equal(opens, 0);
    assert.equal(candidateBytes, 0);
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects injected ancestor replacement', async () => {
  const { root, cleanup } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'profile-ancestor-'));
  try {
    const path = join(root, 'profile.txt');
    await writeFile(path, 'profile', 'utf8');
    await writeFile(join(outside, 'profile.txt'), 'outside', 'utf8');
    const canonicalPath = await fs.realpath(path);
    let candidateRealpaths = 0;
    const fileSystem = {
      lstat: fs.lstat,
      realpath: async (target: string) => {
        if (target === canonicalPath && ++candidateRealpaths > 0)
          return join(outside, 'profile.txt');
        return fs.realpath(target);
      },
      open: fs.open,
    };
    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root], fileSystem }),
    );
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects deterministic in-place mutation during read', async () => {
  const { root, cleanup } = await fixture();
  try {
    const path = join(root, 'profile.txt');
    await writeFile(path, 'profile', 'utf8');
    let mutated = false;
    const fileSystem = {
      lstat: fs.lstat,
      realpath: fs.realpath,
      open: async (target: string, flags: string | number) => {
        const handle = await fs.open(target, flags);
        const read = handle.read.bind(handle);
        handle.read = async (...args: Parameters<typeof handle.read>) => {
          if (!mutated) {
            mutated = true;
            await writeFile(target, 'changed', 'utf8');
          }
          return read(...args);
        };
        return handle;
      },
    };
    await assert.rejects(() =>
      readTrustedProfileFile(input('profile.txt'), { trustedRoots: [root], fileSystem }),
    );
  } finally {
    await cleanup();
  }
});

test('validates JSON and allows markdown and csv', async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, 'data.json'), '{"role":"engineer"}', 'utf8');
    assert.equal(
      (
        await readTrustedProfileFile(input('data.json', 'application/json'), {
          trustedRoots: [root],
        })
      ).content,
      '{"role":"engineer"}',
    );
    await writeFile(join(root, 'notes.md'), '# Profile', 'utf8');
    assert.equal(
      (await readTrustedProfileFile(input('notes.md', 'text/markdown'), { trustedRoots: [root] }))
        .content,
      '# Profile',
    );
    await writeFile(join(root, 'roles.csv'), 'role,level', 'utf8');
    assert.equal(
      (await readTrustedProfileFile(input('roles.csv', 'text/csv'), { trustedRoots: [root] }))
        .content,
      'role,level',
    );
  } finally {
    await cleanup();
  }
});
