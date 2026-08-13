import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichDocumentSnippets,
  THIN_SNIPPET_CHAR_THRESHOLD,
  discoverPdfLinks,
} from '../src/tools/webSearchDocEnrich.js';
import { loadConfig } from '../src/config.js';
import type { SearchConfig } from '../src/config.js';
import type { SearchResult } from '../src/types.js';

/** Build a minimal SearchResult for a snippet-positioned URL. */
function makeResult(url: string, position: number): SearchResult {
  return {
    title: `Title ${position}`,
    url,
    description: `Snippet for ${url}`,
    position,
    domain: 'example.com',
    source: 'searxng',
    age: null,
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet',
  };
}

/** Config clone with documentParsing forced to a specific enabled/maxEnrich. */
function configWithDocumentParsing(enabled: boolean, maxEnrich: number): SearchConfig {
  const base = loadConfig();
  return {
    ...base,
    documentParsing: { ...base.documentParsing, enabled, maxEnrich },
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Install a URL-keyed fetch mock; records every requested URL and throws on
 * any un-mocked call. Returns restore + the recorded call list.
 */
function withFetchMock(responses: Record<string, Response | (() => Response)>): {
  calls: string[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    calls.push(url);
    const entry = responses[url];
    if (entry === undefined) throw new Error('unexpected fetch: ' + url);
    return typeof entry === 'function' ? entry() : entry;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const HTML_RESPONSE = (text: string) =>
  new Response(
    `<html><head><title>Full Doc</title></head><body><article><p>${text}</p></article></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } },
  );

test('enrichDocumentSnippets: disabled config returns results unchanged and never fetches', async () => {
  const cfg = configWithDocumentParsing(false, 3);
  const results = [makeResult('https://example.com/a.pdf', 1)];
  const mock = withFetchMock({});

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.strictEqual(out, results, 'disabled → same array reference, unchanged');
    assert.equal(out[0]?.contentKind, 'snippet');
    assert.equal(out[0]?.description, 'Snippet for https://example.com/a.pdf');
    assert.equal(mock.calls.length, 0, 'disabled → no fetch (no network)');
  } finally {
    mock.restore();
  }
});

// ── PDF discovery (unit) ───────────────────────────────────────────────────

test('discoverPdfLinks: finds same-domain markdown PDF links', () => {
  const markdown = 'See the [system card](https://cdn.example.com/report.pdf) for details.';
  const links = discoverPdfLinks(markdown, 'https://example.com/blog', 5);
  assert.equal(links.length, 1);
  assert.equal(links[0], 'https://cdn.example.com/report.pdf');
});

test('discoverPdfLinks: finds bare PDF URLs', () => {
  const markdown = 'Download https://example.com/data.pdf for raw data.';
  const links = discoverPdfLinks(markdown, 'https://example.com/page', 5);
  assert.equal(links.length, 1);
  assert.equal(links[0], 'https://example.com/data.pdf');
});

test('discoverPdfLinks: cross-domain PDFs are excluded', () => {
  const markdown =
    'See [report](https://other.com/report.pdf) and [local](https://example.com/local.pdf).';
  const links = discoverPdfLinks(markdown, 'https://example.com/page', 5);
  assert.equal(links.length, 1);
  assert.equal(links[0], 'https://example.com/local.pdf');
});

test('discoverPdfLinks: deduplicates same URL', () => {
  const markdown =
    '[a](https://example.com/a.pdf) and also [a again](https://example.com/a.pdf) and [b](https://example.com/b.pdf)';
  const links = discoverPdfLinks(markdown, 'https://example.com/page', 5);
  assert.equal(links.length, 2);
  assert.equal(links[0], 'https://example.com/a.pdf');
  assert.equal(links[1], 'https://example.com/b.pdf');
});

test('discoverPdfLinks: respects maxLinks cap', () => {
  const markdown =
    '[1](https://example.com/1.pdf) [2](https://example.com/2.pdf) [3](https://example.com/3.pdf)';
  const links = discoverPdfLinks(markdown, 'https://example.com/page', 2);
  assert.equal(links.length, 2);
});

test('discoverPdfLinks: resolves relative PDF links against parent URL', () => {
  const markdown = 'See the [report](/docs/report.pdf) for details.';
  const links = discoverPdfLinks(markdown, 'https://example.com/blog/post', 5);
  assert.equal(links.length, 1);
  assert.equal(links[0], 'https://example.com/docs/report.pdf');
});

test('discoverPdfLinks: ignores non-PDF links', () => {
  const markdown =
    'See the [page](https://example.com/page.html) and [image](https://example.com/img.png).';
  const links = discoverPdfLinks(markdown, 'https://example.com', 5);
  assert.equal(links.length, 0);
});

test('discoverPdfLinks: returns empty for invalid parent URL', () => {
  const links = discoverPdfLinks('[pdf](https://example.com/a.pdf)', 'not a url', 5);
  assert.equal(links.length, 0);
});

// ── PDF discovery (integration) ────────────────────────────────────────────

test('enrichDocumentSnippets: PDF link in enriched HTML is discovered and appended', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [makeResult('https://example.com/blog/intro', 1)];
  // The HTML page contains a same-domain PDF link; the PDF itself returns
  // a minimal valid PDF that pdf-parse can extract text from.
  const minimalPdf = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n' +
      '4 0 obj << /Length 44 >> stream\n' +
      'BT /F1 12 Tf 100 700 Td (System Card Content) Tj ET\n' +
      'endstream endobj\n' +
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
      'xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n' +
      '0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n' +
      '0000000360 00000 n \n' +
      'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n421\n%%EOF',
    'utf-8',
  );
  const mock = withFetchMock({
    'https://example.com/blog/intro': HTML_RESPONSE(
      'Full page body. See the <a href="/system-card.pdf">system card</a>.',
    ),
    'https://example.com/system-card.pdf': new Response(minimalPdf, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 2, 'original + appended PDF result');
    assert.equal(out[0]?.contentKind, 'full', 'original enriched to full');
    assert.equal(out[1]?.contentKind, 'full', 'appended PDF is full');
    assert.match(out[1]?.title ?? '', /\[PDF\] Title 1/);
    assert.equal(out[1]?.url, 'https://example.com/system-card.pdf');
    assert.match(out[1]?.description ?? '', /System Card Content/);
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: PDF already in results is not duplicated', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [
    makeResult('https://example.com/blog/intro', 1),
    {
      ...makeResult('https://example.com/system-card.pdf', 2),
      contentKind: 'full' as const,
    },
  ];
  const mock = withFetchMock({
    'https://example.com/blog/intro': HTML_RESPONSE(
      'Full page body. See the <a href="/system-card.pdf">system card</a>.',
    ),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 2, 'no extra result — PDF already present');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: cross-domain PDF link is not appended', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [makeResult('https://example.com/blog/intro', 1)];
  const mock = withFetchMock({
    'https://example.com/blog/intro': HTML_RESPONSE(
      'Full page body. See the <a href="https://cdn.other.com/report.pdf">report</a>.',
    ),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 1, 'cross-domain PDF not appended');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: doc-URL snippet within window is enriched, length/order preserved', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [
    makeResult('https://example.com/a.pdf', 1),
    makeResult('https://example.com/plain', 2),
    makeResult('https://example.com/c.md', 3),
  ];
  // a.pdf → HTML fallback https://example.com/a; c.md → text fetched directly.
  const mock = withFetchMock({
    'https://example.com/a': HTML_RESPONSE('Parsed full content A'),
    'https://example.com/c.md': new Response('# Markdown C', {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 3, 'array length preserved');
    assert.equal(out[0]?.url, results[0]?.url, 'order preserved (index 0)');
    assert.equal(out[1]?.url, results[1]?.url, 'order preserved (index 1)');
    assert.equal(out[2]?.url, results[2]?.url, 'order preserved (index 2)');
    assert.equal(out[0]?.contentKind, 'full');
    assert.match(out[0]?.description ?? '', /Parsed full content A/);
    assert.equal(out[1]?.contentKind, 'snippet', 'non-doc result untouched');
    assert.equal(out[2]?.contentKind, 'full');
    assert.match(out[2]?.description ?? '', /# Markdown C/);
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: cap respected (maxEnrich=1, two qualifying docs → only one enriched)', async () => {
  const cfg = configWithDocumentParsing(true, 1);
  const results = [
    makeResult('https://example.com/a.pdf', 1),
    makeResult('https://example.com/b.pdf', 2),
  ];
  const mock = withFetchMock({
    'https://example.com/a': HTML_RESPONSE('Parsed content A'),
    'https://example.com/b': HTML_RESPONSE('Parsed content B'),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out[0]?.contentKind, 'full', 'first qualifying doc enriched');
    assert.equal(out[1]?.contentKind, 'snippet', 'second qualifying doc not enriched (cap)');
    // Only the first doc's HTML fallback should have been fetched.
    assert.ok(mock.calls.includes('https://example.com/a'));
    assert.ok(!mock.calls.includes('https://example.com/b'), 'cap → second doc never fetched');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: window respected (qualifying doc beyond limit not enriched)', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  // In-window results carry long descriptions so they are not thin HTML;
  // the qualifying doc sits beyond the limit window.
  const longUrl = (p: string) => `https://example.com/${'w'.repeat(300)}${p}`;
  const results = [
    makeResult(longUrl('1'), 1),
    makeResult(longUrl('2'), 2),
    makeResult('https://example.com/a.pdf', 3),
  ];
  const mock = withFetchMock({
    'https://example.com/a': HTML_RESPONSE('Parsed content A'),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 2);
    assert.equal(out.length, 3);
    assert.equal(out[2]?.contentKind, 'snippet', 'doc beyond limit window not enriched');
    assert.equal(out[2]?.description, 'Snippet for https://example.com/a.pdf');
    assert.equal(mock.calls.length, 0, 'window → qualifying doc beyond limit never fetched');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: failure isolated (unsupported result keeps original snippet intact)', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [makeResult('https://example.com/b.pdf', 1)];
  const mock = withFetchMock({
    // HTML fallback yields nothing; PDF bytes fail to parse → unsupported.
    'https://example.com/b': new Response('not html', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
    'https://example.com/b.pdf': new Response('garbage not a pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.contentKind, 'snippet', 'failed extraction leaves contentKind intact');
    assert.equal(
      out[0]?.description,
      'Snippet for https://example.com/b.pdf',
      'failed extraction leaves original description intact',
    );
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: thin HTML snippet is full-page enriched to full', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [makeResult('https://example.com/blog/intro', 1)];
  const mock = withFetchMock({
    'https://example.com/blog/intro': HTML_RESPONSE('Full page body text for the thin result'),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.contentKind, 'full', 'thin HTML enriched to full');
    assert.match(out[0]?.description ?? '', /Full page body text/);
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: non-thin HTML snippet (desc >= threshold) is not enriched, no fetch', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const longUrl = `https://example.com/${'x'.repeat(THIN_SNIPPET_CHAR_THRESHOLD * 2)}`;
  const results = [makeResult(longUrl, 1)];
  assert.ok(results[0]!.description.length >= THIN_SNIPPET_CHAR_THRESHOLD, 'fixture is not thin');
  const mock = withFetchMock({});

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out[0]?.contentKind, 'snippet', 'non-thin HTML left alone');
    assert.equal(out[0]?.description, `Snippet for ${longUrl}`);
    assert.equal(mock.calls.length, 0, 'non-thin HTML never fetched');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: thin HTML with unavailable/non-HTML page keeps original snippet', async () => {
  const cfg = configWithDocumentParsing(true, 3);
  const results = [makeResult('https://example.com/blog/empty', 1)];
  const mock = withFetchMock({
    // content-type is not HTML → extractHtmlPage returns null → unchanged.
    'https://example.com/blog/empty': new Response('nope', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.contentKind, 'snippet');
    assert.equal(out[0]?.description, 'Snippet for https://example.com/blog/empty');
  } finally {
    mock.restore();
  }
});

test('enrichDocumentSnippets: shared cap bounds doc-URL + thin HTML in rank order', async () => {
  const cfg = configWithDocumentParsing(true, 1);
  const results = [
    makeResult('https://example.com/blog/intro', 1), // thin HTML, rank 1
    makeResult('https://example.com/a.pdf', 2), // doc URL, rank 2
  ];
  const mock = withFetchMock({
    'https://example.com/blog/intro': HTML_RESPONSE('First rank HTML body'),
    'https://example.com/a': HTML_RESPONSE('Doc fallback body'),
  });

  try {
    const out = await enrichDocumentSnippets(results, cfg, 10);
    assert.equal(out[0]?.contentKind, 'full', 'rank-1 thin HTML enriched');
    assert.equal(out[1]?.contentKind, 'snippet', 'rank-2 doc beyond cap not enriched');
    assert.ok(mock.calls.includes('https://example.com/blog/intro'));
    assert.ok(!mock.calls.includes('https://example.com/a'), 'cap honored across kinds');
  } finally {
    mock.restore();
  }
});
