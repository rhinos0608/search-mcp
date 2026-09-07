import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractDocumentUrl } from '../src/utils/documentExtraction.js';
import type { SafeFetchResult } from '../src/httpGuards.js';
import { loadConfig } from '../src/config.js';

// Owned production paths for static assertion
const OWNED = [
  'src/crawl/spiders.ts',
  'src/tools/families/agenticBrowse.ts',
  'src/tools/semanticCrawl.ts',
  'src/tools/standalone/rss.ts',
  'src/tools/webRead.ts',
  'src/tools/webSearchDocEnrich.ts',
  'src/utils/documentExtraction.ts',
  'src/utils/externalRecovery.ts',
];

test('static: no native fetch() in owned production paths', () => {
  for (const p of OWNED) {
    const text = fs.readFileSync(p, 'utf8');
    // Match `fetch(` not preceded by safeFetch or DocumentFetch type; exclude safeFetch, DocumentFetch, fetchSafe
    // Raw native fetch would be `fetch(` or `globalThis.fetch` or `await fetch`
    // Check for raw fetch() not preceded by safeFetch etc.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (
        line.includes('safeFetch') ||
        line.includes('fetchSafe') ||
        line.includes('RecoveryFetch') ||
        line.includes('DocumentFetch')
      )
        continue;
      if (
        /\bfetch\s*\(/.test(line) &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*')
      ) {
        assert.fail(`Raw fetch() found in ${p}:${i + 1}: ${line.trim()}`);
      }
    }
  }
});

// Each injectable caller passes timeout/max-byte limits — typed bounded fake
type InspectFake = {
  calls: { url: string; timeoutMs?: number; maxBytes?: number }[];
  fn: (
    url: string,
    _init?: RequestInit,
    opts?: { timeoutMs?: number; maxBytes?: number },
  ) => Promise<SafeFetchResult>;
};

function makeInspectFake(
  responseBody = 'ok html <p>hello</p>',
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/html' },
): InspectFake {
  const calls: InspectFake['calls'] = [];
  const fn = async (
    url: string,
    _init?: RequestInit,
    opts?: { timeoutMs?: number; maxBytes?: number },
  ): Promise<SafeFetchResult> => {
    const entry: InspectFake['calls'][number] = { url };
    if (opts?.timeoutMs !== undefined) (entry as { timeoutMs: number }).timeoutMs = opts.timeoutMs;
    if (opts?.maxBytes !== undefined) (entry as { maxBytes: number }).maxBytes = opts.maxBytes;
    calls.push(entry);
    return {
      finalUrl: url,
      status,
      statusText: 'OK',
      headers: new Headers(headers),
      body: new TextEncoder().encode(responseBody),
      redirectCount: 0,
    };
  };
  return { calls, fn };
}

test('injectable callers pass bounded timeout/maxBytes', async () => {
  // documentExtraction: tryFetchHtml and tryFetchBytes via extractDocumentUrl text path
  const htmlFake = makeInspectFake(JSON.stringify({ hello: 'world' }), 200, {
    'content-type': 'application/json',
  });
  const res = await extractDocumentUrl('https://example.com/data.json', {
    fetchSafe: htmlFake.fn as unknown as Parameters<typeof extractDocumentUrl>[1] extends {
      fetchSafe?: infer F;
    }
      ? F
      : never,
    config: loadConfig(),
  });
  assert.equal(res.success, true);
  assert.ok(htmlFake.calls.length > 0, 'fetchSafe was called');
  for (const c of htmlFake.calls) {
    assert.ok(typeof c.timeoutMs === 'number' && c.timeoutMs > 0, `timeoutMs missing for ${c.url}`);
    assert.ok(typeof c.maxBytes === 'number' && c.maxBytes > 0, `maxBytes missing for ${c.url}`);
  }

  // externalRecovery fake
  const ext = await import('../src/utils/externalRecovery.js');
  const waybackFake = makeInspectFake(JSON.stringify([['timestamp'], ['20240101000000']]), 200, {
    'content-type': 'application/json',
  });
  // wayback will do 2 calls: CDX + snapshot; second with HTML body
  let callIdx = 0;
  const dualFake = async (
    url: string,
    _init?: RequestInit,
    opts?: { timeoutMs?: number; maxBytes?: number },
  ): Promise<SafeFetchResult> => {
    const e: InspectFake['calls'][number] = { url };
    if (opts?.timeoutMs !== undefined) (e as { timeoutMs: number }).timeoutMs = opts.timeoutMs;
    if (opts?.maxBytes !== undefined) (e as { maxBytes: number }).maxBytes = opts.maxBytes;
    waybackFake.calls.push(e);
    callIdx += 1;
    if (callIdx === 1) {
      return {
        finalUrl: url,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify([['timestamp'], ['20240101000000']])),
        redirectCount: 0,
      };
    }
    return {
      finalUrl: url,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: new TextEncoder().encode('<html><body>' + 'a'.repeat(200) + '</body></html>'),
      redirectCount: 0,
    };
  };
  const rec = await ext.attemptExternalRecovery(
    'https://example.com/page',
    dualFake as unknown as Parameters<typeof ext.attemptExternalRecovery>[1],
  );
  assert.equal(rec.source, 'wayback');
  for (const c of waybackFake.calls) {
    assert.ok(typeof c.timeoutMs === 'number' && c.timeoutMs > 0);
    assert.ok(typeof c.maxBytes === 'number' && c.maxBytes > 0);
  }
});

// PDF path crosses production child runner (real PDF bytes via bounded fake, not global fetch)
function buildPdf(text: string): Uint8Array {
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++)
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test('PDF path crosses production child runner via bounded DocumentFetch fake', async () => {
  const pdfBytes = buildPdf('Child Runner PDF');
  const cfg = {
    ...loadConfig(),
    documentParsing: { ...loadConfig().documentParsing, enabled: true },
  };
  const fake: (
    url: string,
    _init?: RequestInit,
    opts?: { timeoutMs?: number; maxBytes?: number },
  ) => Promise<SafeFetchResult> = async (url) => {
    // HTML tier probe for stripped extension
    if (url === 'https://example.com/report') {
      return {
        finalUrl: url,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: new TextEncoder().encode('not html'),
        redirectCount: 0,
      };
    }
    if (url === 'https://example.com/report.pdf') {
      return {
        finalUrl: url,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/pdf' }),
        body: pdfBytes,
        redirectCount: 0,
      };
    }
    throw new Error('unexpected url ' + url);
  };
  const result = await extractDocumentUrl('https://example.com/report.pdf', {
    config: cfg,
    fetchSafe: fake as unknown as Parameters<typeof extractDocumentUrl>[1] extends {
      fetchSafe?: infer F;
    }
      ? F
      : never,
  });
  assert.equal(result.success, true, JSON.stringify(result.warnings));
  assert.match(result.markdown, /Child Runner PDF/);
});

// Fixed-origin authenticated clients excluded — document exclusions
test('exclusions: fixed-origin clients not in owned set', () => {
  const excluded = [
    'src/tools/github',
    'src/tools/braveSearch',
    'src/tools/exaSearch',
    'src/browser',
  ];
  for (const e of excluded) {
    assert.ok(!OWNED.some((p) => p.startsWith(e)), `excluded ${e} should not be owned`);
  }
});
