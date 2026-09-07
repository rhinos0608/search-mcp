import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProfileInput } from './contracts.js';

export const PROFILE_MAX_BYTES = 1_048_576;

interface FileIdentity {
  dev: number;
  ino: number;
}

interface FileSnapshot extends FileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}

export interface ProfileReaderFileSystem {
  lstat(path: string): ReturnType<typeof lstat>;
  realpath(path: string): ReturnType<typeof realpath>;
  open(path: string, flags: string | number): Promise<FileHandle>;
}

export interface TrustedProfileReaderOptions {
  trustedRoots: readonly string[];
  maxBytes?: number;
  fileSystem?: ProfileReaderFileSystem;
}

export interface TrustedProfileContent {
  content: string;
  metadata: {
    extension: '.txt' | '.md' | '.markdown' | '.csv' | '.json';
    contentType: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json';
    sizeBytes: number;
  };
}

const EXTENSION_TYPES: Record<
  TrustedProfileContent['metadata']['extension'],
  TrustedProfileContent['metadata']['contentType']
> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function fail(message: string): never {
  throw new Error(`Profile file rejected: ${message}`);
}

function snapshot(stats: Awaited<ReturnType<typeof lstat>>): FileSnapshot {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    nlink: Number(stats.nlink),
  };
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink
  );
}

function extension(path: string): TrustedProfileContent['metadata']['extension'] {
  const suffix = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (!(suffix in EXTENSION_TYPES)) fail('unsupported file extension');
  return suffix as TrustedProfileContent['metadata']['extension'];
}

function contained(path: string, root: string): boolean {
  const escaped = relative(root, path);
  return (
    escaped === '' || (escaped !== '..' && !escaped.startsWith(`..${sep}`) && !isAbsolute(escaped))
  );
}

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => part === '..');
}

function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path);
}

const defaultFileSystem: ProfileReaderFileSystem = { lstat, realpath, open };
const safeOpenFlags =
  typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_NONBLOCK === 'number'
    ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    : undefined;

async function safeLstat(fs: ProfileReaderFileSystem, path: string, message: string) {
  try {
    return await fs.lstat(path);
  } catch {
    fail(message);
  }
}

async function safeRealpath(
  fs: ProfileReaderFileSystem,
  path: string,
  message: string,
): Promise<string> {
  try {
    return (await fs.realpath(path)).toString();
  } catch {
    fail(message);
  }
}

export async function readTrustedProfileFile(
  input: Extract<ProfileInput, { kind: 'trusted_root_file' }>,
  options: TrustedProfileReaderOptions,
): Promise<TrustedProfileContent> {
  const fs = options.fileSystem ?? defaultFileSystem;
  const maxBytes = options.maxBytes ?? PROFILE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PROFILE_MAX_BYTES)
    fail('invalid byte limit');
  if (safeOpenFlags === undefined) fail('required filesystem safety is unavailable');
  if (options.trustedRoots.length === 0 || options.trustedRoots.some((root) => root.trim() === ''))
    fail('trusted roots are required');

  const requested = input.path.trim();
  if (hasUriScheme(requested)) fail('URI paths are not supported');
  if (hasTraversal(requested)) fail('path traversal is not supported');
  const ext = extension(requested);
  if (EXTENSION_TYPES[ext] !== input.contentType) fail('extension and content type do not match');

  const configuredHome = resolve(homedir());
  const canonicalHome = resolve(
    await safeRealpath(fs, configuredHome, 'home directory is unavailable'),
  );
  const canonicalSsh = resolve(canonicalHome, '.ssh');
  const roots: { path: string; identity: FileIdentity }[] = [];
  for (const configuredRoot of options.trustedRoots) {
    const configuredPath = resolve(configuredRoot);
    if (
      configuredPath === resolve('/') ||
      configuredPath === canonicalHome ||
      contained(configuredPath, canonicalSsh)
    )
      fail('trusted root is too broad or sensitive');
    const configuredStats = await safeLstat(fs, configuredPath, 'trusted root is unavailable');
    if (!configuredStats.isDirectory() || configuredStats.isSymbolicLink())
      fail('trusted root is not a directory');
    const root = await safeRealpath(fs, configuredPath, 'trusted root is unavailable');
    const rootPath = resolve(root);
    if (
      rootPath === resolve('/') ||
      rootPath === canonicalHome ||
      contained(rootPath, canonicalSsh)
    )
      fail('trusted root is too broad or sensitive');
    const stats = await safeLstat(fs, rootPath, 'trusted root is unavailable');
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('trusted root is not a directory');
    if (
      !sameIdentity(
        { dev: Number(configuredStats.dev), ino: Number(configuredStats.ino) },
        { dev: Number(stats.dev), ino: Number(stats.ino) },
      )
    )
      fail('trusted root identity changed');
    roots.push({ path: rootPath, identity: { dev: Number(stats.dev), ino: Number(stats.ino) } });
  }

  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : roots.map(({ path }) => resolve(path, requested));
  const selected = candidates.find((candidate) =>
    roots.some(({ path }) => contained(candidate, path)),
  );
  if (selected === undefined) fail('path is outside trusted roots');
  const rootEntry = roots.find(({ path }) => contained(selected, path));
  if (rootEntry === undefined) fail('path is outside trusted roots');
  const root = rootEntry.path;

  const parts = relative(root, selected).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const stats = await safeLstat(fs, current, 'file is unavailable');
    if (stats.isSymbolicLink()) fail('symbolic links are not supported');
    if (current !== selected && !stats.isDirectory()) fail('path contains a non-directory');
  }
  const canonicalCandidate = await safeRealpath(fs, selected, 'file is unavailable');
  if (canonicalCandidate !== selected || !contained(canonicalCandidate, root))
    fail('symbolic links are not supported');
  const beforeStats = await safeLstat(fs, selected, 'file is unavailable');
  const before = snapshot(beforeStats);
  if (!beforeStats.isFile() || beforeStats.isSymbolicLink() || before.nlink > 1)
    fail('path is not a regular file');
  if (before.size > maxBytes) fail('file exceeds byte limit');

  let handle: FileHandle | undefined;
  try {
    try {
      handle = await fs.open(selected, safeOpenFlags);
    } catch {
      fail('file cannot be opened');
    }
    let opened: FileSnapshot;
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.isSymbolicLink()) fail('path is not a regular file');
      opened = snapshot(openedStats);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Profile file rejected:')) throw error;
      fail('file cannot be inspected');
    }
    if (!sameFile(before, opened) || opened.nlink > 1) fail('file identity changed');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      let result;
      try {
        result = await handle.read(buffer, 0, buffer.length, null);
      } catch {
        fail('file cannot be read');
      }
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
      if (total > maxBytes) fail('file exceeds byte limit');
    }
    let after: FileSnapshot;
    try {
      const afterStats = await handle.stat();
      if (!afterStats.isFile() || afterStats.isSymbolicLink()) fail('file is not a regular file');
      after = snapshot(afterStats);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Profile file rejected:')) throw error;
      fail('file cannot be inspected');
    }
    const pathAfter = snapshot(await safeLstat(fs, selected, 'file identity changed'));
    const rootAfter = await safeLstat(fs, root, 'trusted root identity changed');
    const rootCanonicalAfter = await safeRealpath(fs, root, 'trusted root identity changed');
    const candidateAfter = await safeRealpath(fs, selected, 'file identity changed');
    if (
      !sameFile(before, after) ||
      !sameFile(before, pathAfter) ||
      pathAfter.nlink > 1 ||
      !sameIdentity(rootEntry.identity, {
        dev: Number(rootAfter.dev),
        ino: Number(rootAfter.ino),
      }) ||
      rootCanonicalAfter !== root ||
      candidateAfter !== selected ||
      !contained(candidateAfter, root)
    )
      fail('file identity changed');
    if (after.size > maxBytes || total > maxBytes || after.size !== total)
      fail('file changed while reading');
    const bytes = Buffer.concat(chunks);
    if (
      bytes.subarray(0, 4).equals(Buffer.from('%PDF')) ||
      bytes.subarray(0, 2).equals(Buffer.from('PK')) ||
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      fail('binary content is not supported');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('invalid UTF-8 content');
    }
    if (content.includes('\u0000')) fail('binary content is not supported');
    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch {
        fail('invalid JSON content');
      }
    }
    return {
      content,
      metadata: { extension: ext, contentType: input.contentType, sizeBytes: bytes.byteLength },
    };
  } finally {
    try {
      await handle?.close();
    } catch {
      if (handle) fail('file cannot be closed');
    }
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
