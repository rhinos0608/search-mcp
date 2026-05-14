import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptConfig, decryptConfig } from '../../src/config/crypto.js';

const PASS = 'test-password-32-chars-long-padded!!';
const CFG = { hello: 'world', secret: 'abc123' };

test('round-trip: encrypt then decrypt yields original object', () => {
  const buf = encryptConfig(CFG, PASS);
  const result = decryptConfig(buf, PASS);
  assert.deepEqual(result, CFG);
});

test('encrypted buffer starts with SM magic bytes', () => {
  const buf = encryptConfig(CFG, PASS);
  assert.equal(buf[0], 0x53);
  assert.equal(buf[1], 0x4d);
  assert.equal(buf[2], 0x01);
});

test('two encryptions of same data differ (random nonce)', () => {
  const a = encryptConfig(CFG, PASS);
  const b = encryptConfig(CFG, PASS);
  assert.notDeepEqual(a, b);
});

test('wrong password throws', () => {
  const buf = encryptConfig(CFG, PASS);
  assert.throws(() => decryptConfig(buf, 'wrong-password'));
});

test('tampered ciphertext throws', () => {
  const buf = encryptConfig(CFG, PASS);
  const lastIdx = buf.length - 1;
  const lastByte = buf[lastIdx];
  if (lastByte !== undefined) {
    buf[lastIdx] = lastByte ^ 0xff; // flip last byte
  }
  assert.throws(() => decryptConfig(buf, PASS));
});

test('backward compat: decrypts old pbkdf2 format', async () => {
  const { createCipheriv, pbkdf2Sync, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(PASS, salt, 100_000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(CFG), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const oldBuf = Buffer.concat([salt, iv, authTag, ct]);

  const result = decryptConfig(oldBuf, PASS);
  assert.deepEqual(result, CFG);
});
