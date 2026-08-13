import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractZipEntry, readJsonFromRorZip } from '../../src/domainFacts/zip.js';

// Minimal CRC-32 (ISO-HDLC) for building test zips.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Buffer; method: 0 | 8 }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const nameB = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc32(e.data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameB, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc32(e.data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, eocd]);
}

const JSON_DATA = Buffer.from('{"a":[{"status":"active"}]}');
const CSV_DATA = Buffer.from('domain,type\nx.gov,test');

test('extracts stored (method 0) zip entries', () => {
  const zip = buildZip([{ name: 'x.json', data: JSON_DATA, method: 0 }]);
  const out = extractZipEntry(zip, (n) => n.endsWith('.json'));
  assert.ok(out);
  assert.equal(out.toString('utf8'), JSON_DATA.toString('utf8'));
});

test('extracts deflate (method 8) zip entries', () => {
  const zip = buildZip([{ name: 'x.json', data: JSON_DATA, method: 8 }]);
  const out = extractZipEntry(zip, (n) => n.endsWith('.json'));
  assert.ok(out);
  assert.equal(out.toString('utf8'), JSON_DATA.toString('utf8'));
});

test('readJsonFromRorZip picks the .json entry among others', () => {
  const zip = buildZip([
    { name: 'v2.7-2026-05-12-ror-data.csv', data: CSV_DATA, method: 8 },
    { name: 'v2.7-2026-05-12-ror-data.json', data: JSON_DATA, method: 8 },
  ]);
  assert.equal(readJsonFromRorZip(zip).toString('utf8'), JSON_DATA.toString('utf8'));
});

test('returns null when no entry matches', () => {
  const zip = buildZip([{ name: 'a.csv', data: CSV_DATA, method: 0 }]);
  assert.equal(
    extractZipEntry(zip, (n) => n.endsWith('.json')),
    null,
  );
});

test('ignores EOCD signatures embedded inside a valid ZIP comment', () => {
  const base = buildZip([{ name: 'x.json', data: JSON_DATA, method: 0 }]);
  const eocdStart = base.length - 22;

  // A comment containing a bogus EOCD signature whose own comment-length
  // field does not end at the file end. The scanner must skip it and keep
  // scanning until the real EOCD (whose comment length we patch to match).
  const comment = Buffer.alloc(64, 0);
  comment.writeUInt32LE(0x06054b50, 42); // fake EOCD_SIG inside the comment
  comment[62] = 0xff; // bogus comment-length bytes so the fake boundary mismatches
  comment[63] = 0xff;

  const zip = Buffer.concat([base, comment]);
  zip.writeUInt16LE(comment.length, eocdStart + 20); // real EOCD comment length

  const out = extractZipEntry(zip, (n) => n.endsWith('.json'));
  assert.ok(out);
  assert.equal(out.toString('utf8'), JSON_DATA.toString('utf8'));
});
