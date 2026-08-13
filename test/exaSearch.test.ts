import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exaSearch } from '../src/tools/exaSearch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function mockFetch(captured: CapturedRequest[], response: unknown): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const SAMPLE = {
  results: [
    {
      title: 'Exa Result',
      url: 'https://exa.example/post',
      text: 'Full text body of the result.',
      highlights: ['highlight one', 'highlight two'],
      summary: 'Generated summary text.',
      publishedDate: '2026-01-01',
    },
  ],
};

test('exaSearch default (no) requests excerpts (highlights) only, never full text, content is snippet', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await exaSearch('query-no', 'key', 10, 'moderate', 'no');

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.body.useAutoprompt, undefined, 'deprecated useAutoprompt removed');
  const contents = captured[0]!.body.contents as Record<string, unknown>;
  assert.equal(contents.text, undefined, 'full page text must not be requested by default');
  assert.deepEqual(
    contents.highlights,
    { maxCharacters: 2560 },
    'default requests a bounded richer highlights object, never full text',
  );
  assert.equal(contents.summary, undefined, 'summary must not be requested in no mode');

  assert.equal(results[0]?.description, 'highlight one\n\nhighlight two', 'excerpts are the body');
  assert.equal(results[0]?.contentKind, 'snippet', 'excerpt content classified as snippet');
  assert.equal(results[0]?.generatedSummary, null);
  assert.equal(results[0]?.age, '2026-01-01');
  assert.equal(results[0]?.ageKind, 'published');
});

test('exaSearch yes requests excerpts + summary, never full text, summary kept separate', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await exaSearch('query-yes', 'key', 10, 'moderate', 'yes');

  const contents = captured[0]!.body.contents as Record<string, unknown>;
  assert.equal(contents.text, undefined, 'full text must not be requested in yes mode');
  assert.deepEqual(
    contents.highlights,
    { maxCharacters: 2560 },
    'bounded highlights object in yes mode',
  );
  assert.equal(contents.summary, true);

  assert.equal(results[0]?.description, 'highlight one\n\nhighlight two');
  assert.equal(results[0]?.contentKind, 'snippet');
  assert.equal(results[0]?.generatedSummary, 'Generated summary text.', 'summary kept separate');
  assert.equal(results[0]?.generatedSummaryProvider, 'exa');
  assert.ok(
    !(results[0]?.description ?? '').includes('Generated summary'),
    'summary not mixed into body',
  );
});

test('exaSearch only requests summary only, never text/highlights, maps summary as contentKind summary', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await exaSearch('query-only', 'key', 10, 'moderate', 'only');

  const contents = captured[0]!.body.contents as Record<string, unknown>;
  assert.equal(contents.summary, true);
  assert.equal(contents.text, undefined, 'text must not be requested in only mode');
  assert.equal(contents.highlights, undefined, 'highlights must not be requested in only mode');

  assert.equal(results[0]?.description, 'Generated summary text.');
  assert.equal(results[0]?.contentKind, 'summary');
  assert.equal(results[0]?.generatedSummary, null);
  assert.equal(
    results[0]?.extraSnippet,
    null,
    'only-mode body carries no Author/highlights extras',
  );
});

test('exaSearch cache keys differ by summary mode', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(SAMPLE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await exaSearch('cache-mode-q', 'key', 10, 'moderate', 'no');
  await exaSearch('cache-mode-q', 'key', 10, 'moderate', 'yes');
  await exaSearch('cache-mode-q', 'key', 10, 'moderate', 'yes');
  assert.equal(calls, 2, 'no and yes are separate cache entries; repeated yes hits cache');
});

test('exaSearch uses a concise bounded maxCharacters for highlights (no full text/raw content)', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  await exaSearch('query-bounded', 'key', 10, 'moderate', 'yes');

  const contents = captured[0]!.body.contents as Record<string, unknown>;
  const highlights = contents.highlights as Record<string, unknown>;
  const maxCharacters = Number(highlights.maxCharacters);
  assert.equal(maxCharacters, 2560, 'highlights maxCharacters is 2560');
  assert.equal(contents.text, undefined, 'never requests full page text');
  assert.equal(highlights.maxCharacters, 2560);
});

test('exaSearch strict adds moderation:true to the request body', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  await exaSearch('query-strict', 'key', 10, 'strict', 'no');

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.body.moderation, true, 'strict maps to Exa documented moderation flag');
});

test('exaSearch moderate and off omit moderation from the request body', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  await exaSearch('query-mod', 'key', 10, 'moderate', 'no');
  await exaSearch('query-off', 'key', 10, 'off', 'no');

  assert.equal(captured.length, 2);
  assert.equal(captured[0]!.body.moderation, undefined, 'moderate keeps existing request shape');
  assert.equal(captured[1]!.body.moderation, undefined, 'off keeps existing request shape');
});

test('exaSearch only contains only the per-URL summary: no Author or highlights extras', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 'T',
        url: 'https://exa.example/post',
        author: 'Some Author',
        highlights: ['h1', 'h2'],
        summary: 'The generated summary only.',
      },
    ],
  });

  const results = await exaSearch('exa-only', 'key', 10, 'moderate', 'only');

  assert.equal(results[0]?.description, 'The generated summary only.');
  assert.equal(results[0]?.contentKind, 'summary');
  assert.equal(
    results[0]?.extraSnippet,
    null,
    'only-mode body carries no Author/highlights extras',
  );
});

test('exaSearch tolerates untrusted response containers (object, null, scalar) mapping to []', async () => {
  for (const container of [{}, null, 42, 'scalar', true, { nope: true }]) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, { results: container });
    const results = await exaSearch('exa-container', 'key', 10, 'moderate', 'no');
    assert.deepEqual(results, [], `container ${JSON.stringify(container)} maps to empty`);
  }
});

test('exaSearch skips null/scalar result entries without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [null, 42, 'junk', SAMPLE.results[0], null],
  });

  const results = await exaSearch('exa-skips', 'key', 10, 'moderate', 'no');

  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, 'https://exa.example/post');
  assert.equal(results[0]?.position, 1, 'position renumbered across skipped entries');
});

test('exaSearch falls back to bounded text slice when highlights are absent', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 'New page',
        url: 'https://exa.example/new',
        text: 'Full newly published page body content.',
        highlights: [],
        publishedDate: '2026-02-01',
      },
    ],
  });

  const results = await exaSearch('q-text-fallback', 'key', 10, 'moderate', 'no');
  assert.equal(results[0]?.description, 'Full newly published page body content.');
  assert.equal(results[0]?.contentKind, 'snippet', 'bounded text slice is still excerpt-like');
});

test('exaSearch truncates text fallback to the highlights cap', async () => {
  const captured: CapturedRequest[] = [];
  const longText = 'word '.repeat(2000); // ~10k chars
  mockFetch(captured, {
    results: [
      {
        title: 'Long page',
        url: 'https://exa.example/long',
        text: longText,
        highlights: [],
      },
    ],
  });

  const results = await exaSearch('q-long', 'key', 10, 'moderate', 'no');
  const desc = results[0]?.description ?? '';
  assert.ok(desc.length <= 2560, 'text fallback capped at highlights max characters');
  assert.ok(desc.endsWith('…'), 'truncated slice marked');
});

test('exaSearch prefers highlights over text when both present', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 'Both',
        url: 'https://exa.example/both',
        text: 'This is the full page text that must not be used.',
        highlights: ['query highlight only'],
      },
    ],
  });

  const results = await exaSearch('q-both', 'key', 10, 'moderate', 'no');
  assert.equal(results[0]?.description, 'query highlight only');
});

test('exaSearch only mode still uses summary, not text, when highlights absent', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 'Only',
        url: 'https://exa.example/only',
        text: 'full page text',
        highlights: [],
        summary: 'generated summary only',
      },
    ],
  });

  const results = await exaSearch('q-only-text', 'key', 10, 'moderate', 'only');
  assert.equal(results[0]?.description, 'generated summary only');
  assert.equal(results[0]?.contentKind, 'summary');
});

test('exaSearch tolerates malformed (numeric) fields without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 123,
        url: 456,
        text: 789,
        publishedDate: 20260101,
        author: 42,
        highlights: ['ok', 7, null],
        summary: 5,
      },
    ],
  });
  const results = await exaSearch('q', 'key', 10, 'moderate', 'yes');
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.title, '', 'numeric title coerced to empty string');
  assert.equal(r.url, '', 'numeric url coerced to empty string');
  assert.equal(r.description, 'ok', 'non-string highlight dropped, string kept as excerpt');
  assert.equal(r.domain, '', 'empty url yields empty domain');
  assert.equal(r.age, null, 'numeric publishedDate coerced to null');
  assert.equal(r.ageKind, 'unknown', 'no published date -> unknown age kind');
  assert.equal(r.generatedSummary, null, 'numeric summary coerced to null');
});
