/**
 * Minimal, dependency-free ZIP reader. Only the read path needed for pinned
 * source inputs is implemented: locate the End-of-Central-Directory record,
 * walk the central directory, find an entry matching a predicate, and return
 * its decompressed bytes. Supports stored (method 0) and deflate (method 8)
 * entries via `node:zlib`. The whole-input SHA-256 pin is verified separately,
 * so per-entry CRC verification is intentionally skipped.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Extract the bytes of the first zip entry whose name matches `predicate`. */
export function extractZipEntry(zip: Buffer, predicate: (name: string) => boolean): Buffer | null {
  if (zip.length < 22) return null;

  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      // The EOCD record must end exactly at the end of the file: its fixed
      // 22-byte header plus the comment length field. A signature inside a
      // valid ZIP comment is ignored by continuing to scan earlier.
      const commentLen = zip.readUInt16LE(i + 20);
      if (i + 22 + commentLen === zip.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd === -1) return null;

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 46 > zip.length) return null;
    if (zip.readUInt32LE(offset) !== CENTRAL_SIG) return null;

    const method = zip.readUInt16LE(offset + 10);
    const compSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOff = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (predicate(name)) {
      if (localOff + 30 > zip.length || zip.readUInt32LE(localOff) !== LOCAL_SIG) return null;
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > zip.length) return null;
      const compressed = zip.subarray(dataStart, dataStart + compSize);
      if (method === METHOD_STORED) return compressed;
      if (method === METHOD_DEFLATE) return inflateRawSync(compressed);
      return null; // unsupported compression method
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Extract the first `.json` entry from a ROR data-dump zip. */
export function readJsonFromRorZip(zip: Buffer): Buffer {
  const buf = extractZipEntry(zip, (name) => name.endsWith('.json'));
  if (buf === null) {
    throw new Error('ROR data dump zip contains no .json entry');
  }
  return buf;
}
