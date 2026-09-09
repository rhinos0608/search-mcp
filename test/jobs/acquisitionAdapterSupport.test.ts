import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ACQUISITION_ADAPTER_SUPPORT_VERSION,
  ACQUISITION_ID_MAX_PARTS,
  ACQUISITION_ID_MAX_PREIMAGE_BYTES,
  acquiredContentHash,
  deterministicAcquisitionId,
  normalizeHttpUrlMetadata,
} from '../../src/jobs/acquisition/adapterSupport.js';
import { ACQUISITION_CONTRACT_VERSION } from '../../src/jobs/acquisition/contracts.js';

// test-boundary helper keeps exported API as string while exercising runtime typeof guard
const normalizeHttpUrlMetadataLoose = (
  input: unknown,
): ReturnType<typeof normalizeHttpUrlMetadata> => normalizeHttpUrlMetadata(input as string);

// constants
test('ACQUISITION_ADAPTER_SUPPORT_VERSION is 1.0.0', () => {
  assert.equal(ACQUISITION_ADAPTER_SUPPORT_VERSION, '1.0.0');
});

test('ACQUISITION_ID_MAX_PARTS is 32', () => {
  assert.equal(ACQUISITION_ID_MAX_PARTS, 32);
});

test('ACQUISITION_ID_MAX_PREIMAGE_BYTES is 32768', () => {
  assert.equal(ACQUISITION_ID_MAX_PREIMAGE_BYTES, 32768);
});

// exact static import specifier allowlist
test('adapterSupport static imports allowlist node:crypto + ./contracts.js only; no dynamic import/fetch/console/random', () => {
  const p = path.resolve('src/jobs/acquisition/adapterSupport.ts');
  const src = fs.readFileSync(p, 'utf8');

  // extract static import specifiers: import ... from '...'
  const staticImportRe = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(src)) !== null) {
    specifiers.push(m[1]!);
  }
  // allowlist exactly these two
  const allow = new Set(['node:crypto', './contracts.js']);
  for (const s of specifiers) {
    assert.ok(allow.has(s), `unexpected static import specifier ${s}`);
  }
  assert.ok(specifiers.includes('node:crypto'), 'must import node:crypto');
  assert.ok(specifiers.includes('./contracts.js'), 'must import ./contracts.js');

  // reject dynamic import
  assert.equal(/\bimport\s*\(/.test(src), false, 'should not contain dynamic import()');

  // reject direct fetch / console / randomUUID / Math.random / crypto.getRandom / randomBytes etc - strictly scoped to this file
  // We check that source does not call fetch(, console., randomUUID(, Math.random(, crypto.random
  assert.equal(/\bfetch\s*\(/.test(src), false, 'should not contain fetch(');
  assert.equal(/\bconsole\./.test(src), false, 'should not contain console.');
  // randomUUID as function call/identifier - source only imports createHash, not randomUUID
  assert.equal(src.includes('randomUUID'), false, 'should not contain randomUUID');
  assert.equal(src.includes('Math.random'), false, 'should not contain Math.random');
  assert.equal(src.includes('crypto.random'), false, 'should not contain crypto.random');

  // note: this check is scoped to this file only and does not claim transitive isolation of dependencies
});

// deterministic IDs

test('deterministicAcquisitionId is deterministic', () => {
  const a = deterministicAcquisitionId('candidate', ['a', 'b']);
  const b = deterministicAcquisitionId('candidate', ['a', 'b']);
  assert.equal(a, b);
});

test('deterministicAcquisitionId matches exact spec: kind + colon + lowercase sha256 hex of JSON.stringify([VERSION, ...parts])', () => {
  const parts: string[] = ['foo', 'bar/baz'];
  const payload = JSON.stringify([ACQUISITION_CONTRACT_VERSION, ...parts]);
  const expected = `candidate:${createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(deterministicAcquisitionId('candidate', parts), expected);
  const expected2 = `evidence:${createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(deterministicAcquisitionId('evidence', parts), expected2);
});

test('deterministicAcquisitionId zero parts accepted', () => {
  const parts: string[] = [];
  const payload = JSON.stringify([ACQUISITION_CONTRACT_VERSION, ...parts]);
  const expected = `candidate:${createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(deterministicAcquisitionId('candidate', parts), expected);
  assert.equal(
    deterministicAcquisitionId('evidence', []),
    `evidence:${createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase()}`,
  );
});

test('deterministicAcquisitionId preserves exact originals including empty, whitespace, unicode, controls, >256 chars', () => {
  const big = 'a'.repeat(300);
  const parts = ['', ' ', '  trim  ', 'café — €\u2603', '\n\t\r\u0000', big];
  const payload = JSON.stringify([ACQUISITION_CONTRACT_VERSION, ...parts]);
  const expected = `listing:${createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(deterministicAcquisitionId('listing', parts), expected);
  // ensure empty and whitespace distinct
  assert.notEqual(
    deterministicAcquisitionId('candidate', ['']),
    deterministicAcquisitionId('candidate', [' ']),
  );
  assert.notEqual(
    deterministicAcquisitionId('candidate', ['a']),
    deterministicAcquisitionId('candidate', ['a ']),
  );
});

test('deterministicAcquisitionId copies validated array', () => {
  const parts = ['a', 'b'];
  const id1 = deterministicAcquisitionId('candidate', parts);
  parts.push('c');
  const id2 = deterministicAcquisitionId('candidate', ['a', 'b']);
  assert.equal(id1, id2);
  // mutating original after call should not affect prior id
});

test('reordered parts differ', () => {
  const a = deterministicAcquisitionId('candidate', ['a', 'b']);
  const b = deterministicAcquisitionId('candidate', ['b', 'a']);
  assert.notEqual(a, b);
});

test('ambiguous parts differ via JSON array encoding', () => {
  const a = deterministicAcquisitionId('candidate', ['a', 'b']);
  const b = deterministicAcquisitionId('candidate', ['a,b']);
  assert.notEqual(a, b);
  assert.notEqual(
    deterministicAcquisitionId('candidate', ['ab', 'c']),
    deterministicAcquisitionId('candidate', ['a', 'bc']),
  );
});

test('different kind prefix produces different id even with same hash', () => {
  const a = deterministicAcquisitionId('candidate', ['x']);
  const b = deterministicAcquisitionId('evidence', ['x']);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('candidate:'));
  assert.ok(b.startsWith('evidence:'));
});

test('deterministicAcquisitionId output within W3-A bounds (kind:64hex lowercase)', () => {
  const id = deterministicAcquisitionId('observation', ['part1']);
  assert.match(id, /^(candidate|evidence|envelope|listing|observation):[0-9a-f]{64}$/);
  assert.ok(id.length <= 256);
});

test('deterministicAcquisitionId 32 parts accepted, 33 rejected', () => {
  const parts32 = Array.from({ length: 32 }, (_, i) => `p${i}`);
  const id = deterministicAcquisitionId('candidate', parts32);
  assert.match(id, /^candidate:[0-9a-f]{64}$/);
  const parts33 = [...parts32, 'extra'];
  assert.throws(() => deterministicAcquisitionId('candidate', parts33 as string[]), {
    name: 'RangeError',
    message: 'acquisition ID parts exceed limit',
  });
});

test('deterministicAcquisitionId serialized byte boundary 32768 accepted 32769 rejected (ascii)', () => {
  // single part ascii: payload length = 12 + k (derived)
  const kAccept = 32756; // 12+32756=32768
  const kReject = 32757; // 12+32757=32769
  const partAccept = 'a'.repeat(kAccept);
  const partReject = 'a'.repeat(kReject);
  const payloadAccept = JSON.stringify([ACQUISITION_CONTRACT_VERSION, partAccept]);
  const payloadReject = JSON.stringify([ACQUISITION_CONTRACT_VERSION, partReject]);
  assert.equal(Buffer.byteLength(payloadAccept, 'utf8'), 32768);
  assert.equal(Buffer.byteLength(payloadReject, 'utf8'), 32769);
  // accepted
  const id = deterministicAcquisitionId('candidate', [partAccept]);
  assert.match(id, /^candidate:[0-9a-f]{64}$/);
  // rejected with exact message
  assert.throws(() => deterministicAcquisitionId('candidate', [partReject]), {
    name: 'RangeError',
    message: 'acquisition ID preimage exceeds limit',
  });
});

test('deterministicAcquisitionId byte boundary accounts for JSON escape expansion', () => {
  // part with one quote char adds extra escape byte in serialized payload
  // payload with '\"'+'a'*32754 => 32768; with 32755 =>32769
  const partAccept = '"' + 'a'.repeat(32754);
  const partReject = '"' + 'a'.repeat(32755);
  const payloadAccept = JSON.stringify([ACQUISITION_CONTRACT_VERSION, partAccept]);
  const payloadReject = JSON.stringify([ACQUISITION_CONTRACT_VERSION, partReject]);
  assert.equal(Buffer.byteLength(payloadAccept, 'utf8'), 32768);
  assert.equal(Buffer.byteLength(payloadReject, 'utf8'), 32769);
  assert.doesNotThrow(() => deterministicAcquisitionId('candidate', [partAccept]));
  assert.throws(() => deterministicAcquisitionId('candidate', [partReject]), {
    name: 'RangeError',
    message: 'acquisition ID preimage exceeds limit',
  });
  // also unicode multi-byte: emoji is 4 UTF-8 bytes but JSON keeps literal, still counts
  const emojiPart = 'a'.repeat(32752) + '😀'; // emoji 4 bytes, but JSON length: payload = 12 + 32752 + 4? Actually emoji in JSON is 2 code units but Buffer counts 4 bytes
  // verify byte length differs from code unit length
  const payloadEmoji = JSON.stringify([ACQUISITION_CONTRACT_VERSION, emojiPart]);
  assert.ok(Buffer.byteLength(payloadEmoji, 'utf8') !== payloadEmoji.length);
});

test('deterministicAcquisitionId runtime-invalid exact errors and no secret echo', () => {
  // kind non-string
  let err1: unknown;
  try {
    (deterministicAcquisitionId as unknown as (k: unknown, p: unknown) => string)(
      123 as unknown as string,
      [],
    );
    assert.fail('expected throw');
  } catch (e) {
    err1 = e;
  }
  assert.equal((err1 as Error).name, 'TypeError');
  assert.equal((err1 as Error).message, 'acquisition artifact kind must be a string');
  assert.ok(!(err1 as Error).message.includes('123'));

  // invalid kind
  const badKind = 'secret-kind-xyz';
  let err2: unknown;
  try {
    deterministicAcquisitionId(badKind as unknown as 'candidate', []);
    assert.fail('expected throw');
  } catch (e) {
    err2 = e;
  }
  assert.equal((err2 as Error).name, 'RangeError');
  assert.equal((err2 as Error).message, 'invalid acquisition artifact kind');
  assert.ok(!(err2 as Error).message.includes(badKind));
  assert.ok(!(err2 as Error).message.includes('secret'));

  // non-array parts
  assert.throws(
    () =>
      (deterministicAcquisitionId as unknown as (k: unknown, p: unknown) => string)(
        'candidate',
        'not-array' as unknown as string[],
      ),
    { name: 'TypeError', message: 'acquisition ID parts must be an array' },
  );
  assert.throws(
    () =>
      (deterministicAcquisitionId as unknown as (k: unknown, p: unknown) => string)(
        'candidate',
        null as unknown as string[],
      ),
    {
      name: 'TypeError',
      message: 'acquisition ID parts must be an array',
    },
  );

  // non-string part
  const secret = 'TOP-SECRET';
  let err3: unknown;
  try {
    (deterministicAcquisitionId as unknown as (k: unknown, p: unknown) => string)('candidate', [
      'a',
      123 as unknown as string,
    ]);
    assert.fail('expected throw');
  } catch (e) {
    err3 = e;
  }
  assert.equal((err3 as Error).name, 'TypeError');
  assert.equal((err3 as Error).message, 'acquisition ID parts must contain only strings');
  assert.ok(!(err3 as Error).message.includes(secret));
  assert.ok(!(err3 as Error).message.includes('123'));

  // >32 already tested, but check message not leaking index
  const many = Array.from({ length: 33 }, () => 'x');
  let err4: unknown;
  try {
    deterministicAcquisitionId('candidate', many);
    assert.fail('expected throw');
  } catch (e) {
    err4 = e;
  }
  assert.equal((err4 as Error).name, 'RangeError');
  assert.equal((err4 as Error).message, 'acquisition ID parts exceed limit');
  assert.ok(!(err4 as Error).message.includes('33'));

  // oversized preimage no echo
  const big = 'a'.repeat(32757);
  let err5: unknown;
  try {
    deterministicAcquisitionId('candidate', [big]);
    assert.fail('expected throw');
  } catch (e) {
    err5 = e;
  }
  assert.equal((err5 as Error).name, 'RangeError');
  assert.equal((err5 as Error).message, 'acquisition ID preimage exceeds limit');
  assert.ok(!(err5 as Error).message.includes(big));
  assert.equal((err5 as Error & { cause?: unknown }).cause, undefined);
});

// content hash

test('acquiredContentHash is sha256: + lowercase hex of exact UTF-8 content', () => {
  const content = 'hello world';
  const expected = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(acquiredContentHash(content), expected);
});

test('acquiredContentHash exactness: known vector empty string', () => {
  assert.equal(
    acquiredContentHash(''),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('acquiredContentHash exactness: unicode preserved', () => {
  const s = 'café — €';
  const expected = `sha256:${createHash('sha256').update(s, 'utf8').digest('hex').toLowerCase()}`;
  assert.equal(acquiredContentHash(s), expected);
  assert.notEqual(acquiredContentHash(s), acquiredContentHash(s + ' '));
});

test('acquiredContentHash bounds and format', () => {
  const h = acquiredContentHash('any');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.ok(h.length <= 256);
  assert.equal(h, h.toLowerCase());
});

// URL - new non-throwing contract

test('normalizeHttpUrlMetadata returns undefined for runtime non-string without throwing', () => {
  assert.equal(normalizeHttpUrlMetadataLoose(null), undefined);
  assert.equal(normalizeHttpUrlMetadataLoose(undefined), undefined);
  assert.equal(normalizeHttpUrlMetadataLoose(123), undefined);
  assert.equal(normalizeHttpUrlMetadataLoose({}), undefined);
  assert.doesNotThrow(() => normalizeHttpUrlMetadataLoose(null));
});

test('normalizeHttpUrlMetadata rejects credentials -> undefined', () => {
  assert.equal(normalizeHttpUrlMetadata('https://user:pass@example.com/a'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://user@example.com/a'), undefined);
});

test('normalizeHttpUrlMetadata rejects non-http schemes -> undefined', () => {
  assert.equal(normalizeHttpUrlMetadata('ftp://example.com/a'), undefined);
  assert.equal(normalizeHttpUrlMetadata('ws://example.com/a'), undefined);
  assert.equal(normalizeHttpUrlMetadata('mailto:a@b.com'), undefined);
  assert.equal(normalizeHttpUrlMetadata('javascript:alert(1)'), undefined);
});

test('normalizeHttpUrlMetadata rejects malformed -> undefined', () => {
  assert.equal(normalizeHttpUrlMetadata('not a url'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://'), undefined);
  assert.equal(normalizeHttpUrlMetadata(''), undefined);
  assert.equal(normalizeHttpUrlMetadata('   '), undefined);
});

test('normalizeHttpUrlMetadata rejects oversized input >8192 -> undefined', () => {
  const big = `https://example.com/${'a'.repeat(8200)}`;
  assert.ok(big.length > 8192);
  assert.equal(normalizeHttpUrlMetadata(big), undefined);
  const big2 = 'https://example.com/' + 'a'.repeat(8173);
  assert.ok(big2.length > 8192);
  assert.equal(normalizeHttpUrlMetadata(big2), undefined);
  // code-unit bound on trimmed rawUrl as well
  const big3 = '  ' + `https://example.com/${'a'.repeat(8193)}` + '  ';
  assert.equal(normalizeHttpUrlMetadata(big3), undefined);
});

test('normalizeHttpUrlMetadata rejects hostname >253 -> undefined', () => {
  const host = `${'a'.repeat(254)}.com`;
  assert.ok(host.length > 253);
  assert.equal(normalizeHttpUrlMetadata(`https://${host}/a`), undefined);
});

test('normalizeHttpUrlMetadata removes fragment', () => {
  const m = normalizeHttpUrlMetadata('https://example.com/a#section');
  assert.ok(m !== undefined);
  assert.equal(m.canonicalUrl.includes('#'), false);
  assert.equal(m.canonicalUrl, 'https://example.com/a');
});

test('normalizeHttpUrlMetadata preserves meaningful query', () => {
  const m = normalizeHttpUrlMetadata('https://example.com/a?foo=1&bar=2#frag');
  assert.ok(m !== undefined);
  assert.equal(m.canonicalUrl, 'https://example.com/a?foo=1&bar=2');
  assert.ok(m.canonicalUrl.includes('foo=1'));
});

test('normalizeHttpUrlMetadata allows benign keys like jobCode/postcode and rejects sensitive keys', () => {
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?jobCode=123') !== undefined);
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?postcode=2000') !== undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?token=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?api_key=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?code=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?auth_code=abc'), undefined);
});

test('normalizeHttpUrlMetadata rejects camelCase credential params and retains existing forms', () => {
  // camelCase credential compounds must be rejected
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?accessToken=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?authCode=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?clientSecret=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?AccessToken=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?bearerToken=abc'), undefined);
  // existing separator forms still rejected
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?access_token=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?client-secret=abc'), undefined);
  assert.equal(normalizeHttpUrlMetadata('https://example.com/a?authCode=abc'), undefined);
  // benign camelCase compounds with non-credential prefixes stay allowed
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?jobCode=123') !== undefined);
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?postcode=2000') !== undefined);
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?authority=nsw') !== undefined);
  assert.ok(normalizeHttpUrlMetadata('https://example.com/a?clientId=123') !== undefined);
});

test('normalizeHttpUrlMetadata lowercases normalizedHost', () => {
  const m = normalizeHttpUrlMetadata('https://EXAMPLE.COM/Path');
  assert.ok(m !== undefined);
  assert.equal(m.normalizedHost, 'example.com');
});

test('normalizeHttpUrlMetadata determinism and trim', () => {
  const a = normalizeHttpUrlMetadata('  https://example.com/a  ');
  const b = normalizeHttpUrlMetadata('https://example.com/a');
  assert.deepEqual(a, b);
  assert.equal(a!.rawUrl, 'https://example.com/a');
});

test('normalizeHttpUrlMetadata canonicalUrl within W3-A bounds', () => {
  const m = normalizeHttpUrlMetadata('https://example.com/a?x=1');
  assert.ok(m !== undefined);
  assert.ok(m.canonicalUrl.length <= 8192);
  assert.ok(m.normalizedHost.length <= 253);
  assert.ok(m.rawUrl.length <= 8192);
});

test('normalizeHttpUrlMetadata WHATWG oracle exact cases table-driven', () => {
  const cases: Array<{
    input: string;
    expected: { rawUrl: string; canonicalUrl: string; normalizedHost: string };
  }> = [
    {
      input: 'http://127.000.000.001:80/a',
      expected: {
        rawUrl: 'http://127.000.000.001:80/a',
        canonicalUrl: 'http://127.0.0.1/a',
        normalizedHost: '127.0.0.1',
      },
    },
    {
      input: 'http://[2001:0db8::1]:80/a',
      expected: {
        rawUrl: 'http://[2001:0db8::1]:80/a',
        canonicalUrl: 'http://[2001:db8::1]/a',
        normalizedHost: '[2001:db8::1]',
      },
    },
    {
      input: 'https://example.com:443/a',
      expected: {
        rawUrl: 'https://example.com:443/a',
        canonicalUrl: 'https://example.com/a',
        normalizedHost: 'example.com',
      },
    },
    {
      input: 'https://example.com:8443/a',
      expected: {
        rawUrl: 'https://example.com:8443/a',
        canonicalUrl: 'https://example.com:8443/a',
        normalizedHost: 'example.com',
      },
    },
    {
      input: 'https://bücher.example/a',
      expected: {
        rawUrl: 'https://bücher.example/a',
        canonicalUrl: 'https://xn--bcher-kva.example/a',
        normalizedHost: 'xn--bcher-kva.example',
      },
    },
  ];
  for (const { input, expected } of cases) {
    const actual = normalizeHttpUrlMetadata(input);
    assert.deepStrictEqual(actual, expected);
    assert.ok(Object.isFrozen(actual));
  }
});

test('normalizeHttpUrlMetadata private/loopback accepted metadata', () => {
  const loop = normalizeHttpUrlMetadata('http://127.0.0.1/a');
  assert.ok(loop !== undefined);
  assert.equal(loop.normalizedHost, '127.0.0.1');
  const priv = normalizeHttpUrlMetadata('http://192.168.1.10/a');
  assert.ok(priv !== undefined);
  const priv10 = normalizeHttpUrlMetadata('http://10.0.0.1/a');
  assert.ok(priv10 !== undefined);
});

test('normalizeHttpUrlMetadata frozen mutation', () => {
  const m = normalizeHttpUrlMetadata('https://example.com/a');
  assert.ok(m !== undefined);
  assert.ok(Object.isFrozen(m));
  // attempt mutation should not change
  try {
    (m as unknown as Record<string, string>).rawUrl = 'hacked';
  } catch {
    // in strict mode assignment to frozen throws TypeError - acceptable since path is still non-throwing for caller? but mutation attempt should not succeed
  }
  assert.equal(m.rawUrl, 'https://example.com/a');
});

test('normalizeHttpUrlMetadata entire path non-throwing', () => {
  const inputs: unknown[] = [
    null,
    undefined,
    123,
    {},
    [],
    '',
    '   ',
    'not url',
    'https://user:pass@example.com/a',
    'ftp://example.com',
    `https://example.com/${'a'.repeat(8200)}`,
  ];
  for (const inp of inputs) {
    assert.doesNotThrow(() => {
      const res = normalizeHttpUrlMetadataLoose(inp);
      assert.ok(res === undefined || typeof res === 'object');
    });
  }
});

test('normalizeHttpUrlMetadata no network side effects where testable – multiple calls do not fetch', () => {
  const url = 'https://example.com/a';
  const m1 = normalizeHttpUrlMetadata(url);
  const m2 = normalizeHttpUrlMetadata(url);
  assert.deepEqual(m1, m2);
});

test('no random IDs in source – deterministicAcquisitionId does not use random', () => {
  void randomUUID;
  const a = deterministicAcquisitionId('listing', ['stable']);
  const b = deterministicAcquisitionId('listing', ['stable']);
  assert.equal(a, b);
});
