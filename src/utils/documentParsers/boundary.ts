import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ParsedDocument } from './types.js';

export interface ParserLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxInputBytes?: number;
}
export interface ParserCapability {
  processIsolation: 'enforced';
  networkIsolation: 'not_enforced';
  memoryIsolation: 'v8_heap_only';
}
export const parserCapability: ParserCapability = {
  processIsolation: 'enforced',
  networkIsolation: 'not_enforced',
  memoryIsolation: 'v8_heap_only',
};

function capUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
  const lead = bytes[end - 1] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (width > 1 && end + width > maxBytes) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const MAX_PROTOCOL_OVERHEAD_BYTES = 4 * 1024;

function encodedSize(value: ParsedDocument): number {
  return Buffer.byteLength(
    JSON.stringify({
      markdown: value.markdown,
      title: value.title,
      tables: value.tables,
      warnings: value.warnings,
      images: value.images.map((image) => ({
        mime: image.mime,
        page: image.page,
        data: Buffer.from(image.data).toString('base64'),
      })),
    }),
  );
}

/** Reject complete protocol envelopes that exceed cap, including JSON/base64 overhead. */
function assertDocumentWithinLimit(value: ParsedDocument, maxBytes: number): void {
  if (encodedSize(value) > maxBytes) throw new Error('document parser overflow');
}

export interface ParserLaunchOptions {
  runner: string;
  execArgv: string[];
  env: NodeJS.ProcessEnv;
}
export type ParserLauncher = (options: ParserLaunchOptions) => ChildProcess;

export async function runDocumentParser(
  kind: 'pdf' | 'office',
  data: Uint8Array,
  ext: string | undefined,
  limits: ParserLimits,
  signal?: AbortSignal,
  launcher: ParserLauncher = ({ runner, execArgv, env }) =>
    fork(runner, [], { execArgv, silent: true, env }),
): Promise<ParsedDocument> {
  if ((limits.maxInputBytes ?? 10 * 1024 * 1024) < data.byteLength)
    throw new Error('parser input exceeds limit');
  if (signal?.aborted) throw new Error('document parser aborted');
  const jsRunner = fileURLToPath(new URL('./runner.js', import.meta.url));
  const tsRunner = fileURLToPath(new URL('./runner.ts', import.meta.url));
  const runner = existsSync(jsRunner) ? jsRunner : tsRunner;
  const execArgv = runner.endsWith('.ts')
    ? ['--max-old-space-size=256', '--import', 'tsx/esm']
    : ['--max-old-space-size=256'];

  return new Promise((resolve, reject) => {
    const child = launcher({
      runner,
      execArgv,
      env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let reason: 'timeout' | 'abort' | 'overflow' | 'error' | undefined;
    let childError: Error | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      terminate('timeout');
    }, limits.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin?.removeAllListeners();
      try {
        child.disconnect();
      } catch {
        /* already disconnected */ void 0;
      }
    };
    const finish = (error?: Error, value?: ParsedDocument): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new Error('document parser failed'));
    };
    const terminate = (why: 'timeout' | 'abort' | 'overflow' | 'error'): void => {
      if (settled || reason) return;
      reason = why;
      try {
        child.kill('SIGTERM');
      } catch {
        /* process already gone */ void 0;
      }
      hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */ void 0;
        }
      }, 250);
    };
    const onAbort = (): void => {
      terminate('abort');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout.push(bytes);
      // Allow bounded protocol overhead before parsing structured output.
      const outputBytes = Buffer.concat(stdout).byteLength;
      if (outputBytes > limits.maxOutputBytes + MAX_PROTOCOL_OVERHEAD_BYTES) {
        terminate('overflow');
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.concat(stderr).byteLength > 65536) {
        child.stderr?.destroy();
      }
    });
    child.on('error', (error) => {
      childError ??= error instanceof Error ? error : new Error('document parser failed');
      terminate('error');
    });
    child.stdin?.on('error', (error) => {
      childError ??= error instanceof Error ? error : new Error('document parser failed');
      terminate('error');
    });
    child.once('close', (code, signal) => {
      if (reason) {
        finish(
          reason === 'error'
            ? (childError ?? new Error('document parser failed'))
            : new Error(`document parser ${reason === 'abort' ? 'aborted' : reason}`),
        );
        return;
      }
      if (code !== 0 || signal !== null) {
        finish(
          new Error(
            stderr.length
              ? capUtf8(Buffer.concat(stderr).toString('utf8'), 4096)
              : 'document parser failed',
          ),
        );
        return;
      }
      const output = Buffer.concat(stdout).toString('utf8');
      try {
        const value = JSON.parse(output) as Partial<ParsedDocument> & { error?: string };
        if (typeof value.error === 'string') throw new Error(value.error);
        if (
          typeof value.markdown !== 'string' ||
          typeof value.title !== 'string' ||
          !Array.isArray(value.tables) ||
          !Array.isArray(value.warnings)
        ) {
          throw new Error('invalid parser protocol');
        }
        const result: ParsedDocument = {
          markdown: value.markdown,
          title: value.title,
          tables: value.tables.map(String),
          warnings: value.warnings.map(String),
          images: (value.images ?? []).flatMap((image) => {
            const item = image as { mime?: unknown; page?: unknown; data?: unknown };
            return typeof item.data === 'string'
              ? [
                  {
                    mime: typeof item.mime === 'string' ? item.mime : 'application/octet-stream',
                    page: typeof item.page === 'number' ? item.page : 0,
                    data: Buffer.from(item.data, 'base64'),
                  },
                ]
              : [];
          }),
        };
        assertDocumentWithinLimit(result, limits.maxOutputBytes);
        finish(undefined, result);
      } catch (error) {
        finish(
          new Error(
            error instanceof Error && error.message === 'document parser overflow'
              ? 'document parser overflow'
              : error instanceof SyntaxError
                ? 'invalid parser protocol'
                : error instanceof Error
                  ? error.message
                  : 'invalid parser protocol',
          ),
        );
      }
    });
    child.stdin?.end(JSON.stringify({ kind, ext, data: Buffer.from(data).toString('base64') }));
  });
}
