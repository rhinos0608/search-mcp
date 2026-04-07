#!/usr/bin/env npx tsx
/**
 * Encrypt config.json → config.enc using AES-256-GCM.
 *
 * Usage:
 *   npx tsx scripts/encrypt-config.ts              # prompts for password
 *   SEARCH_MCP_CONFIG_KEY=secret npx tsx scripts/encrypt-config.ts
 *
 * File format (binary):
 *   [16 bytes salt][12 bytes IV][16 bytes auth tag][...ciphertext]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createCipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CONFIG_PATH = join(process.cwd(), 'config.json');
const ENC_PATH = join(process.cwd(), 'config.enc');

async function getPassword(): Promise<string> {
  const envKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  if (envKey) return envKey;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('Enter encryption password: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    console.error('Error: config.json not found. Copy config.example.json to config.json and fill in your keys.');
    process.exit(1);
  }

  const plaintext = readFileSync(CONFIG_PATH, 'utf8');

  // Validate JSON
  try {
    JSON.parse(plaintext);
  } catch {
    console.error('Error: config.json is not valid JSON.');
    process.exit(1);
  }

  const password = await getPassword();
  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha512');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Write: salt + iv + authTag + ciphertext
  const output = Buffer.concat([salt, iv, authTag, encrypted]);
  writeFileSync(ENC_PATH, output);

  console.error(`Encrypted config.json → config.enc (${output.length} bytes)`);
  console.error('Set SEARCH_MCP_CONFIG_KEY in your environment to decrypt at runtime.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
