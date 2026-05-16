import {
  createCipheriv, createDecipheriv,
  pbkdf2Sync, scryptSync, randomBytes,
} from 'node:crypto';

const MAGIC = Buffer.from([0x53, 0x4d]); // 'SM'
const VERSION = 0x01;
const SCRYPT_SALT_LEN = 32;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;

// Scrypt params: OWASP recommended minimum (N=16384, r=8, p=1).
// These are the floor values for interactive logins per OWASP ASVS v4.0.3.
// Bumping these (e.g. N=2^17) would increase memory/CPU cost ~2x with minimal
// security gain for a local-tool config file — the threat model is offline
// brute-force of a config.enc file, not an online auth system. Keep at min
// to avoid noticeable startup latency.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKeyScrypt(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function deriveKeyPbkdf2(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
}

export function encryptConfig(data: unknown, password: string): Buffer {
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = deriveKeyScrypt(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, nonce, authTag, ciphertext]);
}

export function decryptConfig(buf: Buffer, password: string): unknown {
  const byte0 = buf[0];
  const byte1 = buf[1];
  const magic0 = MAGIC[0];
  const magic1 = MAGIC[1];
  if (byte0 !== undefined && byte1 !== undefined && magic0 !== undefined && magic1 !== undefined
    && byte0 === magic0 && byte1 === magic1) {
    return decryptNew(buf, password);
  }
  return decryptLegacy(buf, password);
}

function decryptNew(buf: Buffer, password: string): unknown {
  const versionByte = buf[2];
  if (versionByte === undefined || versionByte !== VERSION) {
    throw new Error(`Unknown config envelope version: ${String(versionByte)}`);
  }
  let offset = 3;
  const salt = buf.subarray(offset, (offset += SCRYPT_SALT_LEN));
  const nonce = buf.subarray(offset, (offset += NONCE_LEN));
  const authTag = buf.subarray(offset, (offset += AUTH_TAG_LEN));
  const ciphertext = buf.subarray(offset);
  const key = deriveKeyScrypt(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as unknown;
}

function decryptLegacy(buf: Buffer, password: string): unknown {
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const authTag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = deriveKeyPbkdf2(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as unknown;
}
