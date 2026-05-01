import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { duckduckgoSearch } from '../src/tools/duckduckgoSearch.js';

const originalFetch = globalThis.fetch;

const DEFAULT_CONFIG = { region: 'us-en', safeSearch: 'moderate' };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── HTML Parsing ─────────────────────────────────────────────────────────────

test('parses a valid DuckDuckGo Lite HTML response', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header">
    <td><a href="https://example.com/page" rel="nofollow">Example <b>Title</b></a></td>
  </tr>
  <tr class="result-snippet">
    <td>A <b>description</b> of the result page.</td>
  </tr>
  <tr class="result-url">
    <td>example.com</td>
  </tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'test-parse',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Example Title');
  assert.equal(results[0]!.url, 'https://example.com/page');
  assert.equal(results[0]!.description, 'A description of the result page.');
  assert.equal(results[0]!.domain, 'example.com');
  assert.equal(results[0]!.source, 'duckduckgo');
});

test('parses multiple results from a single response', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header"><td><a href="https://one.com" rel="nofollow">One</a></td></tr>
  <tr class="result-snippet"><td>First result</td></tr>
  <tr class="result-url"><td>one.com</td></tr>
</table>
<div>some ads</div>
<table class="result">
  <tr class="result-header"><td><a href="https://two.com" rel="nofollow">Two</a></td></tr>
  <tr class="result-snippet"><td>Second result</td></tr>
  <tr class="result-url"><td>two.com</td></tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'multi-parse',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, 'One');
  assert.equal(results[1]!.title, 'Two');
});

test('respects the limit parameter', async () => {
  globalThis.fetch = async () => {
    const parts = [''];
    for (let i = 1; i <= 10; i++) {
      parts.push(
        `<table class="result">
  <tr class="result-header"><td><a href="https://r${i}.com" rel="nofollow">Result ${i}</a></td></tr>
  <tr class="result-snippet"><td>Desc ${i}</td></tr>
  <tr class="result-url"><td>r${i}.com</td></tr>
</table>`,
      );
    }
    return new Response(`<html>${parts.join('')}</html>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  const results = await duckduckgoSearch(
    'limit-parse',
    5,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 5);
});

test('positions are sequential starting from 1', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header"><td><a href="https://a.com" rel="nofollow">A</a></td></tr>
  <tr class="result-snippet"><td>desc a</td></tr>
  <tr class="result-url"><td>a.com</td></tr>
</table>
<table class="result">
  <tr class="result-header"><td><a href="https://b.com" rel="nofollow">B</a></td></tr>
  <tr class="result-snippet"><td>desc b</td></tr>
  <tr class="result-url"><td>b.com</td></tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'position-parse',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results[0]!.position, 1);
  assert.equal(results[1]!.position, 2);
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

test('skips results with no resolvable URL', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header"><td><b>Bad Result</b></td></tr>
  <tr class="result-snippet"><td>Has no link</td></tr>
  <tr class="result-url"><td>also-empty.com</td></tr>
</table>
<table class="result">
  <tr class="result-header"><td><a href="https://good.com" rel="nofollow">Good</a></td></tr>
  <tr class="result-snippet"><td>Has a link</td></tr>
  <tr class="result-url"><td>good.com</td></tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'no-url-parse',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Good');
});

test('empty HTML returns no results', async () => {
  globalThis.fetch = async () => {
    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  const results = await duckduckgoSearch(
    'empty-parse',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 0);
});

test('handles missing snippet gracefully', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header"><td><a href="https://nosnippet.com" rel="nofollow">No Snippet</a></td></tr>
  <tr class="result-url"><td>nosnippet.com</td></tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'no-snippet',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.description, '');
  assert.equal(results[0]!.title, 'No Snippet');
});

test('handles missing display URL gracefully', async () => {
  globalThis.fetch = async () => {
    return new Response(
      `<html>
<table class="result">
  <tr class="result-header"><td><a href="https://nodisplay.com/page" rel="nofollow">Has Link</a></td></tr>
  <tr class="result-snippet"><td>Some description</td></tr>
</table>
</html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const results = await duckduckgoSearch(
    'no-display-url',
    10,
    'moderate',
    DEFAULT_CONFIG,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, 'https://nodisplay.com/page');
});

// ── Bot Challenge Detection ──────────────────────────────────────────────────

test('throws on bot challenge page', async () => {
  globalThis.fetch = async () => {
    return new Response(
      '<html><body><h1>Please verify your identity</h1><p>Complete the captcha below.</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  await assert.rejects(
    duckduckgoSearch('challenge-test', 10, 'moderate', DEFAULT_CONFIG),
    /bot challenge page/i,
  );
});

test('throws on HTTP error status', async () => {
  globalThis.fetch = async () => {
    return new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' });
  };

  await assert.rejects(
    duckduckgoSearch('error-status', 10, 'moderate', DEFAULT_CONFIG),
    /DuckDuckGo returned 429/i,
  );
});

// ── Config ────────────────────────────────────────────────────────────────────

test('passes strict safesearch as kp=1 query param', async () => {
  let calledUrl = '';

  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(
      `<html><table class="result"><tr class="result-header"><td><a href="https://safe.com" rel="nofollow">Safe</a></td></tr><tr class="result-snippet"><td>safe</td></tr><tr class="result-url"><td>safe.com</td></tr></table></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  await duckduckgoSearch('strict-query', 10, 'strict', DEFAULT_CONFIG);

  assert.ok(
    calledUrl.includes('kp=1'),
    `Expected URL to contain kp=1, got: ${calledUrl}`,
  );
});

test('honors explicit moderate safeSearch arg over config', async () => {
  let calledUrl = '';
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(
      `<html><table class="result"><tr class="result-header"><td><a href="https://x.com" rel="nofollow">X</a></td></tr></table></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  // Call with moderate explicitly — should NOT set kp=1 even if config is strict
  await duckduckgoSearch('test', 10, 'moderate', { ...DEFAULT_CONFIG, safeSearch: 'strict' });
  assert.ok(!calledUrl.includes('kp=1'), 'Explicit moderate should not set kp=1');
});

test('uses config safeSearch as fallback when arg is undefined', async () => {
  let calledUrl = '';
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(
      `<html><table class="result"><tr class="result-header"><td><a href="https://x.com" rel="nofollow">X</a></td></tr></table></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  // Pass undefined safely (simulating calling without the argument)
  await duckduckgoSearch('test', 10, undefined, { ...DEFAULT_CONFIG, safeSearch: 'strict' });
  assert.ok(calledUrl.includes('kp=1'), 'Undefined safeSearch should fallback to config strict');
});

test('passes region as kl query param', async () => {
  let calledUrl = '';

  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(
      `<html><table class="result"><tr class="result-header"><td><a href="https://de.com" rel="nofollow">DE</a></td></tr><tr class="result-snippet"><td>de</td></tr><tr class="result-url"><td>de.com</td></tr></table></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  await duckduckgoSearch('region-query', 10, 'moderate', { ...DEFAULT_CONFIG, region: 'de-de' });

  assert.ok(
    calledUrl.includes('kl=de-de'),
    `Expected URL to contain kl=de-de, got: ${calledUrl}`,
  );
});
