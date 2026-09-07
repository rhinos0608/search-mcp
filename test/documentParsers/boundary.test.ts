import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parserCapability,
  runDocumentParser,
  type ParserLauncher,
} from '../../src/utils/documentParsers/boundary.js';

// Harness source for self-created temporary fixture when TS-compiled output
// is not present (source/tsx mode with .ts fixture that needs plain JS fork).
const HARNESS_JS = `import { stdin, stdout } from 'node:process';
const mode = process.argv[2] ?? 'success';
if (mode === 'hang') setInterval(() => {}, 1000);
let input = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { input += chunk; });
stdin.on('end', () => {
  if (mode === 'malformed') { stdout.write('{bad'); return; }
  if (mode === 'overflow') { stdout.write('x'.repeat(10000)); return; }
  if (mode === 'oversized') {
    stdout.write(JSON.stringify({ markdown: 'x'.repeat(2000), title: '', tables: [], warnings: [], images: [] }));
    return;
  }
  const request = JSON.parse(input);
  if (mode === 'exit-nonzero') {
    stdout.write(JSON.stringify({ markdown: 'ok', title: '', tables: [], warnings: [], images: [] }));
    process.exitCode = 1;
    return;
  }
  stdout.write(JSON.stringify({
    markdown: mode === 'unicode' ? 'é'.repeat(1000) : 'ok',
    title: '',
    tables: [],
    warnings: [],
    images: mode === 'image' ? [{ mime: 'image/png', page: 1, data: Buffer.from('image'.repeat(1000)).toString('base64') }] : [],
    inputBytes: Buffer.from(request.data, 'base64').length,
  }));
});
`;

let cachedTempFixture: string | undefined;

function resolveFixture(): string {
  const compiled = fileURLToPath(new URL('../fixtures/documentParserHarness.js', import.meta.url));
  if (existsSync(compiled)) return compiled;
  const mjs = fileURLToPath(new URL('../fixtures/documentParserHarness.mjs', import.meta.url));
  if (existsSync(mjs)) return mjs;
  if (cachedTempFixture && existsSync(cachedTempFixture)) return cachedTempFixture;
  const dir = mkdtempSync(path.join(tmpdir(), 'parser-harness-'));
  const file = path.join(dir, 'documentParserHarness.mjs');
  writeFileSync(file, HARNESS_JS);
  cachedTempFixture = file;
  return file;
}

const fixture = resolveFixture();
const launch =
  (mode: string): ParserLauncher =>
  (options) =>
    fork(fixture, [mode], { execArgv: [], silent: true, env: options.env });
const limits = { timeoutMs: 500, maxOutputBytes: 1000 };

test('pre-abort does not spawn parser', async () => {
  let spawned = false;
  await assert.rejects(
    runDocumentParser('pdf', new Uint8Array(), undefined, limits, AbortSignal.abort(), () => {
      spawned = true;
      throw new Error('spawned');
    }),
    /aborted/,
  );
  assert.equal(spawned, false);
});

test('timeout terminates hanging child and reports reason', async () => {
  await assert.rejects(
    runDocumentParser(
      'pdf',
      new Uint8Array(),
      undefined,
      { ...limits, timeoutMs: 20 },
      undefined,
      launch('hang'),
    ),
    /timeout/,
  );
});

test('abort terminates hanging child and reports reason', async () => {
  const controller = new AbortController();
  const pending = runDocumentParser(
    'pdf',
    new Uint8Array(),
    undefined,
    limits,
    controller.signal,
    launch('hang'),
  );
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('stdout overflow terminates child and reports reason', async () => {
  await assert.rejects(
    runDocumentParser('pdf', new Uint8Array(), undefined, limits, undefined, launch('overflow')),
    /overflow/,
  );
});

test('UTF-8 output stays valid when structured result fits cap', async () => {
  const result = await runDocumentParser(
    'pdf',
    new Uint8Array(),
    undefined,
    { timeoutMs: 500, maxOutputBytes: 3000 },
    undefined,
    launch('unicode'),
  );
  assert.equal(result.markdown.includes('�'), false);
});

test('valid oversized structured result rejects instead of being trimmed', async () => {
  await assert.rejects(
    runDocumentParser('pdf', new Uint8Array(), undefined, limits, undefined, launch('oversized')),
    /overflow/,
  );
});

test('combined JSON and image envelope stays within cap', async () => {
  const result = await runDocumentParser(
    'pdf',
    new Uint8Array(),
    undefined,
    { timeoutMs: 500, maxOutputBytes: 8000 },
    undefined,
    launch('image'),
  );
  const encoded = JSON.stringify({
    ...result,
    images: result.images.map((image) => ({
      ...image,
      data: Buffer.from(image.data).toString('base64'),
    })),
  });
  assert.ok(Buffer.byteLength(encoded) <= 8000);
});

test('nonzero child exit rejects valid protocol output', async () => {
  await assert.rejects(
    runDocumentParser(
      'pdf',
      new Uint8Array(),
      undefined,
      limits,
      undefined,
      launch('exit-nonzero'),
    ),
    /failed/,
  );
});

test('real spawn error rejects after close without waiting for exit', async () => {
  let closed = false;
  let exited = false;
  const started = Date.now();
  await assert.rejects(
    runDocumentParser('pdf', new Uint8Array(), undefined, limits, undefined, (options) => {
      const child = spawn('__missing_document_parser_executable__', [], {
        env: options.env,
        stdio: 'pipe',
      });
      child.once('exit', () => {
        exited = true;
      });
      child.once('close', () => {
        closed = true;
      });
      return child;
    }),
    /ENOENT/,
  );
  assert.equal(closed, true);
  assert.equal(exited, false);
  assert.ok(Date.now() - started < 1000);
});

test('malformed protocol rejects', async () => {
  await assert.rejects(
    runDocumentParser('pdf', new Uint8Array(), undefined, limits, undefined, launch('malformed')),
    /Unexpected token|invalid parser protocol/,
  );
});

test('capability reports process and V8 isolation, not network isolation', () => {
  assert.deepEqual(parserCapability, {
    processIsolation: 'enforced',
    networkIsolation: 'not_enforced',
    memoryIsolation: 'v8_heap_only',
  });
});
