import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocumentUrl } from '../src/utils/documentExtraction.js';
import { isDocumentUrl } from '../src/utils/documentUtils.js';
import { loadConfig } from '../src/config.js';

/**
 * Build a tiny but valid single-page PDF with correct xref offsets. This is
 * deterministic and parseable by pdf-parse v2 (verified against parsePdf).
 */
function buildPdf(text: string): ArrayBuffer {
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
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Build a config clone with documentParsing.enabled forced to a value. */
function configWithDocumentParsing(enabled: boolean): ReturnType<typeof loadConfig> {
  const base = loadConfig();
  return {
    ...base,
    documentParsing: { ...base.documentParsing, enabled },
  };
}

test('text-like document URLs are routed as document URLs', () => {
  assert.equal(isDocumentUrl('https://example.com/data.json'), true);
  assert.equal(isDocumentUrl('https://example.com/notes.md'), true);
  assert.equal(isDocumentUrl('https://example.com/report.pdf'), true);
});

test('document extraction returns unsupported for binary document URLs without fetching', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('unexpected');
  }) as typeof fetch;

  try {
    const config = configWithDocumentParsing(false);
    const result = await extractDocumentUrl('https://example.com/report.pdf', { config });
    assert.equal(result.success, false);
    assert.equal(result.unsupported, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// REGRESSION: with documentParsing.enabled=false, a .pdf URL returns
// unsupported and performs NO fetch at all (including no HTML fallback probe).
test('regression: documentParsing disabled → .pdf returns unsupported with no fetch', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1;
    return new Response('should not be fetched: ' + requestUrl(input));
  }) as typeof fetch;

  try {
    const config = configWithDocumentParsing(false);
    const result = await extractDocumentUrl('https://example.com/report.pdf', { config });
    assert.equal(result.success, false);
    assert.equal(result.unsupported, true);
    assert.equal(calls, 0, 'disabled mode must not issue any fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// enabled=true: a .pdf URL is parsed via parsePdf → success + markdown + images present.
test('documentParsing enabled → .pdf URL parses to markdown with images field', async () => {
  const originalFetch = globalThis.fetch;
  const pdfBytes = buildPdf('Hello PDF World');
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    requested.push(url);
    // HTML-first tier probes the stripped-extension landing page → non-HTML.
    if (url === 'https://example.com/report') {
      return new Response('not html', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url === 'https://example.com/report.pdf') {
      return new Response(pdfBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    throw new Error('unexpected fetch: ' + url);
  }) as typeof fetch;

  try {
    const config = configWithDocumentParsing(true);
    const result = await extractDocumentUrl('https://example.com/report.pdf', { config });
    assert.equal(result.success, true);
    assert.equal(result.unsupported, false);
    assert.match(result.markdown, /Hello PDF World/);
    assert.ok(result.images !== undefined, 'images field must be present on PDF success');
    assert.deepEqual(Array.from(result.images), []);
    assert.ok(requested.includes('https://example.com/report'), 'HTML tier was attempted');
    assert.ok(requested.includes('https://example.com/report.pdf'), 'PDF bytes were fetched');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// enabled=true: a scan-only image format has no text tier → remains unsupported
// after HTML fallback yields nothing.
test('documentParsing enabled → image/scan-only formats remain unsupported', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === 'https://example.com/img') {
      return new Response('not html', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    throw new Error('unexpected fetch: ' + url);
  }) as typeof fetch;

  try {
    const config = configWithDocumentParsing(true);
    const result = await extractDocumentUrl('https://example.com/img.png', { config });
    assert.equal(result.success, false);
    assert.equal(result.unsupported, true);
    assert.ok(result.warnings.length > 0, 'warnings collected across tiers');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// enabled=true: a failing PDF fetch (all tiers yield nothing) → unsupported,
// so downstream Crawl4AI/Wayback fallbacks are preserved.
test('documentParsing enabled → failing document returns unsupported (fallbacks preserved)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === 'https://example.com/broken') {
      return new Response('not html', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url === 'https://example.com/broken.pdf') {
      return new Response('garbage not a pdf', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    throw new Error('unexpected fetch: ' + url);
  }) as typeof fetch;

  try {
    const config = configWithDocumentParsing(true);
    const result = await extractDocumentUrl('https://example.com/broken.pdf', { config });
    assert.equal(result.success, false);
    assert.equal(result.unsupported, true);
    assert.ok(result.warnings.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document extraction formats JSON text documents as markdown code fences', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"name":"search-mcp","ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const result = await extractDocumentUrl('https://example.com/data.json');
    assert.equal(result.success, true);
    assert.equal(result.unsupported, false);
    assert.match(result.markdown, /^```json/);
    assert.match(result.markdown, /"name": "search-mcp"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
