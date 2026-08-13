import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import type fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistry,
  validateRegistry,
  renderRegistry,
  verifySha256,
  writeGeneratedFileAtomic,
  findObsoleteGeneratedFiles,
  REGISTRY_FILE_NAME,
} from '../../src/domainFacts/build.js';
import type { AtomicFsOps } from '../../src/domainFacts/build.js';
import type { SourcePin } from '../../src/domainFacts/types.js';

const CISA =
  'Domain name,Domain type,Organization name,Suborganization name\n' +
  'anl.gov,Federal - Laboratory,Department of Energy,\n' +
  'whitehouse.gov,Federal - Executive,Executive Office of the President,\n';
const ROR = JSON.stringify([
  {
    id: 'https://ror.org/a',
    status: 'active',
    domains: ['Anl.gov', 'mit.edu'],
    types: ['facility'],
    names: [{ value: 'Argonne', types: ['ror_display', 'label'], lang: 'en' }],
  },
  {
    id: 'https://ror.org/b',
    status: 'active',
    domains: ['mit.edu'],
    types: ['education'],
    names: [{ value: 'MIT', types: ['ror_display', 'label'], lang: 'en' }],
  },
  {
    id: 'https://ror.org/c',
    status: 'inactive',
    domains: ['old.edu'],
    types: ['education'],
    names: [{ value: 'Old', types: ['ror_display', 'label'], lang: 'en' }],
  },
]);
const PINS: readonly SourcePin[] = [
  {
    id: 'cisa',
    name: 'C',
    url: 'u',
    version: 'v',
    sha256: 's',
    license: 'CC0',
    retrievedAt: '2026-01-01',
  },
];

test('merge: CISA ownership fact coexists with ROR fact (conflict provenance)', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  // anl.gov is both a CISA ownership fact and a ROR identity fact.
  assert.ok(reg.cisa.some((f) => f.domain === 'anl.gov' && f.org === 'Department of Energy'));
  assert.ok(reg.ror.some((f) => f.domain === 'anl.gov' && f.rorId === 'https://ror.org/a'));
  assert.ok(reg.cisa.some((f) => f.domain === 'whitehouse.gov'));
});

test('drops inactive/withdrawn and keeps both facts for shared domains', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  assert.ok(!reg.ror.some((f) => f.domain === 'old.edu'), 'inactive dropped');
  // mit.edu claimed by two distinct active orgs — both kept.
  assert.equal(reg.ror.filter((f) => f.domain === 'mit.edu').length, 2);
});

test('institutional gate: education promotes, facility does not', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  assert.ok(reg.institutionalDomains.includes('mit.edu'), 'education domain promotes');
  assert.ok(!reg.institutionalDomains.includes('anl.gov'), 'facility domain does not promote');
});

test('output is sorted deterministically', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  const cisaDoms = reg.cisa.map((f) => f.domain);
  const inst = [...reg.institutionalDomains];
  assert.deepEqual(cisaDoms, [...cisaDoms].sort());
  assert.deepEqual(inst, [...inst].sort());
});

test('render is byte-identical across runs and contains all three datasets', () => {
  const a = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  const b = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  assert.equal(a, b);
  assert.ok(a.includes('anl.gov'), 'CISA_ROWS data present');
  assert.ok(a.includes('mit.edu'), 'ROR_ROWS / INSTITUTIONAL_DOMAINS data present');
  assert.match(a, /export const CISA_ROWS/);
  assert.match(a, /export const ROR_ROWS/);
  assert.match(a, /export const INSTITUTIONAL_DOMAINS/);
  assert.match(a, /export const PROVENANCE/);
  assert.match(a, /export const REGISTRY_VERSION/);
});

test('validateRegistry rejects an empty registry', () => {
  const reg = buildRegistry({ cisaCsv: 'x,y\n', rorJson: '[]' }, PINS);
  assert.throws(() => validateRegistry(reg), /empty/);
});

test('validateRegistry rejects institutional domain missing from ROR facts', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  reg.institutionalDomains.push('nope.edu');
  assert.throws(() => validateRegistry(reg), /missing from ROR facts/);
});

test('validateRegistry rejects education ROR fact missing from institutionalDomains', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  reg.institutionalDomains = [];
  assert.throws(() => validateRegistry(reg), /missing from institutionalDomains/);
});

test('verifySha256 throws on mismatch, passes on match', () => {
  const data = Buffer.from('hello');
  const good = createHash('sha256').update(data).digest('hex');
  assert.doesNotThrow(() => verifySha256(data, good));
  assert.throws(() => verifySha256(data, '0'.repeat(64)), /SHA-256 mismatch/);
});

test('writeGeneratedFileAtomic writes the single file with exact content and no leftovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const content = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  const written = writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, content);
  assert.equal(written, join(dir, REGISTRY_FILE_NAME));
  assert.ok(existsSync(join(dir, REGISTRY_FILE_NAME)));
  assert.equal(readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8'), content);
  assert.deepEqual(readdirSync(dir), [REGISTRY_FILE_NAME]);
});

test('generator validates before writing — no partial output on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const runGenerator = (inputs: { cisaCsv: string; rorJson: string }): void => {
    const reg = buildRegistry(inputs, PINS);
    validateRegistry(reg); // throws before any write
    writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, renderRegistry(reg));
  };
  assert.throws(() => runGenerator({ cisaCsv: 'x,y\n', rorJson: '[]' }));
  assert.deepEqual(readdirSync(dir), []);
});

const realOps: AtomicFsOps = {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  existsSync,
};

test('publish failure before rename (temp write): old single file intact, no temp left behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const v1 = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v1);
  const originalBytes = readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8');

  const CISA_V2 = CISA + 'nasa.gov,Federal - Executive,NASA,\n';
  const v2 = renderRegistry(buildRegistry({ cisaCsv: CISA_V2, rorJson: ROR }, PINS));
  assert.notEqual(v2, v1);

  let renameCalled = false;
  const ops: AtomicFsOps = {
    ...realOps,
    writeSync: (): number => {
      throw new Error('injected write failure');
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike): void => {
      renameCalled = true;
      renameSync(from, to);
    },
  };

  assert.throws(
    () => writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v2, ops),
    /injected write failure/,
  );
  assert.equal(renameCalled, false, 'rename must never be reached when the temp write fails');
  assert.equal(
    readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8'),
    originalBytes,
    'previously published file untouched',
  );
  const leftovers = readdirSync(dir).filter((f) => f !== REGISTRY_FILE_NAME);
  assert.deepEqual(leftovers, [], 'no temp file left behind');
});

test('publish failure during rename: old single file intact, no temp left behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const v1 = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v1);
  const originalBytes = readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8');

  const CISA_V2 = CISA + 'nasa.gov,Federal - Executive,NASA,\n';
  const v2 = renderRegistry(buildRegistry({ cisaCsv: CISA_V2, rorJson: ROR }, PINS));
  assert.notEqual(v2, v1);

  const ops: AtomicFsOps = {
    ...realOps,
    renameSync: (): void => {
      throw new Error('injected rename failure');
    },
  };

  assert.throws(
    () => writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v2, ops),
    /injected rename failure/,
  );
  assert.equal(
    readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8'),
    originalBytes,
    'previously published file untouched — rename() either fully applies or leaves the destination unchanged',
  );
  const leftovers = readdirSync(dir).filter((f) => f !== REGISTRY_FILE_NAME);
  assert.deepEqual(leftovers, [], 'no temp file left behind after rename failure cleanup');
});

test('writeGeneratedFileAtomic loops through short writeSync calls and writes exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const content = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  const fullBuf = Buffer.from(content, 'utf8');
  assert.ok(fullBuf.length > 10, 'content must be long enough to exercise multiple short writes');

  const CHUNK = 7; // deliberately small and not a divisor of the content length
  let calls = 0;
  const shortWriteSync = (
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset?: number | null,
    length?: number | null,
  ): number => {
    calls += 1;
    const off = offset ?? 0;
    const len = Math.min(CHUNK, length ?? 0);
    return writeSync(fd, buffer, off, len);
  };
  const ops: AtomicFsOps = {
    ...realOps,
    writeSync: shortWriteSync as unknown as typeof writeSync,
  };

  const written = writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, content, ops);
  assert.ok(calls > 1, 'writeSync must be invoked more than once for a short-write injection');
  const finalBytes = readFileSync(written);
  assert.deepEqual(
    finalBytes,
    fullBuf,
    'final file bytes must exactly equal the full UTF-8 content',
  );
  assert.equal(readFileSync(written, 'utf8'), content);
});

test('writeGeneratedFileAtomic rejects zero-progress writeSync: old file intact, temp removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dff-'));
  const v1 = renderRegistry(buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS));
  writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v1);
  const originalBytes = readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8');

  const CISA_V2 = CISA + 'nasa.gov,Federal - Executive,NASA,\n';
  const v2 = renderRegistry(buildRegistry({ cisaCsv: CISA_V2, rorJson: ROR }, PINS));
  assert.notEqual(v2, v1);

  let renameCalled = false;
  const ops: AtomicFsOps = {
    ...realOps,
    writeSync: (): number => 0,
    renameSync: (from: fs.PathLike, to: fs.PathLike): void => {
      renameCalled = true;
      renameSync(from, to);
    },
  };

  assert.throws(
    () => writeGeneratedFileAtomic(dir, REGISTRY_FILE_NAME, v2, ops),
    /writeSync made no progress/,
  );
  assert.equal(
    renameCalled,
    false,
    'rename must never be reached when writeSync makes no progress',
  );
  assert.equal(
    readFileSync(join(dir, REGISTRY_FILE_NAME), 'utf8'),
    originalBytes,
    'previously published file untouched',
  );
  const leftovers = readdirSync(dir).filter((f) => f !== REGISTRY_FILE_NAME);
  assert.deepEqual(leftovers, [], 'no temp file left behind after zero-progress failure');
});

test('findObsoleteGeneratedFiles flags only unexpected *.generated.ts files', () => {
  const known = new Set(['build.ts', 'types.ts']);
  const entries = [
    REGISTRY_FILE_NAME,
    'institutional.generated.ts',
    'build.ts',
    'types.ts',
    '.pi-smartread.tags.cache',
    'README.md',
  ];
  assert.deepEqual(findObsoleteGeneratedFiles(entries, REGISTRY_FILE_NAME, known), [
    'institutional.generated.ts',
  ]);
});

test('findObsoleteGeneratedFiles ignores non-generated entries entirely', () => {
  const known = new Set(['build.ts']);
  const entries = [REGISTRY_FILE_NAME, 'build.ts', '.pi-smartread.tags.cache', 'notes.txt'];
  assert.deepEqual(findObsoleteGeneratedFiles(entries, REGISTRY_FILE_NAME, known), []);
});

test('renderer exposes CISA, ROR, and institutional datasets together from one build (no cross-dataset drift)', () => {
  const reg = buildRegistry({ cisaCsv: CISA, rorJson: ROR }, PINS);
  const rendered = renderRegistry(reg);
  // Every institutional domain in the render must also appear in ROR_ROWS in
  // the same render — proving both datasets came from one buildRegistry call
  // and one render pass, not two independently-generated files.
  for (const domain of reg.institutionalDomains) {
    assert.ok(
      rendered.includes(`[${JSON.stringify(domain).replace(/"/g, "'")}`),
      `institutional domain ${domain} must be present as a ROR row in the same render`,
    );
  }
});
