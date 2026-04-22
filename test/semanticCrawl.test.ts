import { describe, it } from 'node:test';
import assert from 'node:assert';
import { embedTexts } from '../src/tools/semanticCrawl.js';

describe('embedTexts', () => {
  it('throws when sidecar is unreachable', async () => {
    await assert.rejects(
      () => embedTexts('http://localhost:54321', '', ['hello'], 'document', 256),
      (err: Error) => err.message.includes('unreachable') || err.message.includes('fetch failed'),
    );
  });
});
