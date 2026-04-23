// scripts/download-model.ts
// Downloads the ONNX cross-encoder model + tokenizer from Hugging Face.
// Run: npx tsx scripts/download-model.ts

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_REPO = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODEL_DIR = join(import.meta.dirname, '..', 'models');
const FILES = [
  { hfPath: 'onnx/model.onnx', localPath: 'model.onnx' },
  { hfPath: 'tokenizer.json', localPath: 'tokenizer.json' },
];

async function download() {
  mkdirSync(MODEL_DIR, { recursive: true });

  for (const file of FILES) {
    const localPath = join(MODEL_DIR, file.localPath);
    if (existsSync(localPath)) {
      console.log(`  ✓ ${file.localPath} already exists, skipping`);
      continue;
    }

    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${file.hfPath}`;
    console.log(`  ↓ Downloading ${file.hfPath}...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buf);
    console.log(`  ✓ Saved ${file.localPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  console.log('\nDone. Model files in:', MODEL_DIR);
}

download().catch((err) => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
