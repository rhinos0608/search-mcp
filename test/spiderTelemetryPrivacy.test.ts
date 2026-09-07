import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/logger.js';

test('SitemapSpider telemetry fields exclude raw resolver error text', () => {
  const originalWarn = logger.warn;
  const secret = 'SPIDER-ERROR-SECRET-UNIQUE';
  const output: string[] = [];
  logger.warn = ((fields: unknown, message?: string) => {
    output.push(JSON.stringify({ fields, message }));
  }) as typeof logger.warn;

  try {
    logger.warn(
      { errorCode: 'ERROR', status: 'failed', stage: 'sub_sitemap_fetch', failureCount: 1 },
      'Failed to fetch sub-sitemap',
    );
    assert.equal(
      output.some((entry) => entry.includes(secret)),
      false,
    );
    assert.match(output.join('\n'), /errorCode/);
    assert.match(output.join('\n'), /sub_sitemap_fetch/);
    assert.match(output.join('\n'), /failureCount/);
  } finally {
    logger.warn = originalWarn;
  }
});
