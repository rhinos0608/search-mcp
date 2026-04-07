#!/usr/bin/env npx tsx
/**
 * Decrypt config.enc → stdout (for verification).
 *
 * Usage:
 *   npx tsx scripts/decrypt-config.ts              # prompts for password
 *   SEARCH_MCP_CONFIG_KEY=secret npx tsx scripts/decrypt-config.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ENC_PATH = join(process.cwd(), 'config.enc');

async function getPassword(): Promise<string> {
  const envKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  if (envKey) return envKey;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('Enter decryption password: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  if (!existsSync(ENC_PATH)) {
    console.error('Error: config.enc not found. Run encrypt-config.ts first.');
    process.exit(1);
  }

  const password = await getPassword();
  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }

  const buf = readFileSync(ENC_PATH);

  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const authTag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);

  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Output to stdout so it can be piped
  process.stdout.write(decrypted.toString('utf8') + '\n');
}

main().catch((err) => {
  console.error('Decryption failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
