import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { logger } from '../src/logger.js';
import {
  configureInstrumentation,
  endSpan,
  resetInstrumentation,
  startRun,
  startSpan,
  completeRun,
} from '../src/rag/instrumentation.js';
import { jobErrorCode, jobTelemetry } from '../src/utils/jobTelemetry.js';
import { filterByPathPrefix, filterSafeUrls, pagesToCorpus } from '../src/tools/semanticCrawl.js';

test('job telemetry contains lengths and counts, never input values', () => {
  const fields = jobTelemetry({
    query: 'QUERY-PII-unique',
    location: ['LOCATION-PII-unique', '/private/path-PII-unique'],
  });
  assert.deepEqual(fields, { queryLength: 16, locationCount: 2, locationLength: 43 });
  assert.equal(JSON.stringify(fields).includes('PII-unique'), false);
});

test('RAG logger output excludes query and thrown error text', () => {
  const output: string[] = [];
  const methods = ['info', 'debug', 'warn', 'error'] as const;
  const originals = methods.map((method) => [method, logger[method]] as const);
  for (const method of methods) {
    logger[method] = ((fields: unknown, message?: string) => {
      output.push(JSON.stringify({ fields, message }));
    }) as (typeof logger)[typeof method];
  }

  try {
    configureInstrumentation({ enabled: true, emitToLogger: true, logLevel: 'debug' });
    const run = startRun('job', 'QUERY-PII-unique');
    const span = startSpan(run.runId, 'crawl', { url: 'URL-PII-unique' });
    endSpan(span, 'failed', 'ERROR-PII-unique');
    completeRun(run.runId, { path: 'PATH-PII-unique' });
    const serialized = output.join('\n');
    assert.equal(serialized.includes('PII-unique'), false);
    assert.match(serialized, /queryLength/);
    assert.match(serialized, /errorCode/);
  } finally {
    for (const [method, original] of originals) logger[method] = original;
    resetInstrumentation();
  }
});

test('semantic crawl logger fields exclude raw input and error payloads', async () => {
  const output: string[] = [];
  const methods = ['info', 'debug', 'warn', 'error'] as const;
  const originals = methods.map((method) => [method, logger[method]] as const);
  for (const method of methods) {
    logger[method] = ((fields: unknown, message?: string) => {
      output.push(JSON.stringify({ fields, message }));
    }) as (typeof logger)[typeof method];
  }

  try {
    filterSafeUrls(['https://blocked-PII-unique.example/path-PII-unique', 'not-a-url-PII-unique'], {
      enabled: true,
      blockedDomains: ['blocked-PII-unique.example'],
      trustedDomains: [],
    });
    filterByPathPrefix([], 'not-a-seed-PII-unique');
    pagesToCorpus(
      [
        {
          url: 'https://page-PII-unique.example/path-PII-unique',
          success: true,
          markdown: 'content',
          title: null,
          description: null,
          links: [],
          statusCode: 404,
          errorMessage: 'error-PII-unique',
        },
      ],
      false,
    );
    assert.equal(output.join('\\n').includes('PII-unique'), false);
  } finally {
    for (const [method, original] of originals) logger[method] = original;
  }
});

test('process logger calls have no forbidden dynamic fields', async () => {
  const files = [
    'src/tools/standalone/rss.ts',
    'src/tools/semanticCrawl.ts',
    'src/tools/families/semanticCrawl.ts',
    'src/tools/registry.ts',
    'src/crawl/spiders.ts',
  ];
  const forbiddenField =
    /(?:^|[,{}]\s*)(?:err|error|message|stack|cause|url|hostname|path|seed(?:Path)?|query|corpusId|trust)(?![A-Za-z0-9_$])\s*:/;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(
      /logger\.(?:info|debug|warn|error)\(\s*(\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s*,/g,
    )) {
      const fields = match[1] ?? '';
      assert.equal(fields.startsWith('{'), true, `${file}: logger fields must be object`);
      if (fields.includes('jobTelemetry(')) continue;
      assert.equal(forbiddenField.test(fields), false, `${file}: forbidden logger field`);
    }
  }
});

test('telemetry error code is stable and does not expose message', () => {
  const error = new Error('ERROR-PII-unique');
  assert.equal(jobErrorCode(error), 'ERROR');
  assert.equal(JSON.stringify({ errorCode: jobErrorCode(error) }).includes('PII-unique'), false);
});
