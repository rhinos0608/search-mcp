import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tavilySearch } from '../src/tools/tavilySearch.js';

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
  answer: 'A generated answer.',
  results: [
    {
      title: 'Tavily Result',
      url: 'https://tavily.example/post',
      content: 'NLP summary content.',
      score: 0.9,
      raw_content: '# Raw markdown body\nfull content here',
      published_date: 'Tue, 11 Mar 2025 17:00:00 GMT',
    },
  ],
};

test('tavilySearch default (no) requests excerpt snippets only: no raw content, no query-level answer', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await tavilySearch('query-no', 'key', 10, 'moderate', 'no');

  const body = captured[0]!.body;
  assert.equal(body.include_answer, false, 'include_answer disabled in no mode');
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.chunks_per_source, 3, 'a few URL-attributed snippets per source');
  assert.equal(body.include_raw_content, undefined, 'raw content must not be requested by default');

  assert.equal(
    results[0]?.description,
    'NLP summary content.',
    'URL-attributed snippet is the body',
  );
  assert.equal(results[0]?.contentKind, 'snippet', 'excerpt content classified as snippet');
  assert.equal(results[0]?.extraSnippet, null, 'no relevance/raw extras in body');
  assert.ok(!(results[0]?.extraSnippet ?? '').includes('relevance'), 'no relevance string in body');
  assert.ok(!(results[0]?.extraSnippet ?? '').includes('Full Content'), 'no raw content in body');
  assert.equal(
    results[0]?.age,
    'Tue, 11 Mar 2025 17:00:00 GMT',
    'published_date mapped when present',
  );
  assert.equal(results[0]?.ageKind, 'published');
  assert.equal(results[0]?.generatedSummary, null);
});

test('tavilySearch yes does not request the query-level answer or raw content', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await tavilySearch('query-yes', 'key', 10, 'moderate', 'yes');

  const body = captured[0]!.body;
  assert.equal(body.include_answer, false, 'query-level answer never requested for yes');
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.chunks_per_source, 3);
  assert.equal(
    body.include_raw_content,
    undefined,
    'raw content must not be requested in yes mode',
  );

  assert.equal(results[0]?.description, 'NLP summary content.');
  assert.equal(results[0]?.contentKind, 'snippet');
  assert.equal(results[0]?.extraSnippet, null, 'no relevance/raw extras in body');
  assert.ok(!(results[0]?.extraSnippet ?? '').includes('relevance'), 'no relevance string in body');
  assert.equal(results[0]?.generatedSummary, null, 'Tavily contributes no summary in yes mode');
});

test('tavilySearch only uses ultra-fast NLP summary mode without raw content or answer', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, SAMPLE);

  const results = await tavilySearch('query-only', 'key', 10, 'moderate', 'only');

  const body = captured[0]!.body;
  assert.equal(body.include_answer, false, 'no query-level answer in only mode');
  assert.equal(body.search_depth, 'ultra-fast');
  assert.equal(body.chunks_per_source, undefined, 'no snippet chunking in summary-only mode');
  assert.equal(
    body.include_raw_content,
    undefined,
    'raw content must not be requested in only mode',
  );

  assert.equal(results[0]?.description, 'NLP summary content.');
  assert.equal(results[0]?.contentKind, 'summary', 'only mode is summary-only');
  assert.equal(results[0]?.extraSnippet, null, 'no relevance/raw extras in only mode');
  assert.equal(results[0]?.generatedSummary, null);
});

test('tavilySearch maps published_date only when it is a string (unknown otherwise)', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      { title: 'T', url: 'https://tavily.example/post', content: 'snippet', published_date: 12345 },
    ],
  });
  const results = await tavilySearch('pub-date-numeric', 'key', 10, 'moderate', 'no');
  assert.equal(results[0]?.age, null, 'non-string published_date ignored');
  assert.equal(results[0]?.ageKind, 'unknown');
});

test('tavilySearch normalizes provider [...] chunk delimiter in default/yes snippet mode', async () => {
  for (const mode of ['no', 'yes'] as const) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, {
      results: [
        {
          title: 'T',
          url: 'https://tavily.example/post',
          content: 'First chunk of the snippet. [...] Second chunk continues.',
        },
      ],
    });
    const results = await tavilySearch(`chunk-delimiter-${mode}`, 'key', 10, 'moderate', mode);
    const desc = results[0]?.description ?? '';
    assert.ok(!desc.includes('[...]'), `${mode}: delimiter normalized out`);
    assert.ok(desc.includes('First chunk of the snippet.'), `${mode}: first chunk preserved`);
    assert.ok(desc.includes('Second chunk continues.'), `${mode}: second chunk preserved`);
  }
});

test('tavilySearch turns documented whitespace-delimited [...] chunk joins into paragraph breaks', async () => {
  for (const mode of ['no', 'yes'] as const) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, {
      results: [
        {
          title: 'T',
          url: 'https://tavily.example/post',
          content: 'first paragraph content [...] second paragraph content',
        },
      ],
    });
    const results = await tavilySearch(`chunk-para-${mode}`, 'key', 10, 'moderate', mode);
    const desc = results[0]?.description ?? '';
    assert.ok(!desc.includes('[...]'), `${mode}: whitespace-delimited delimiter normalized out`);
    assert.ok(desc.includes('\n\n'), `${mode}: delimiter became a paragraph break`);
    assert.ok(desc.includes('first paragraph content'), `${mode}: first chunk preserved`);
    assert.ok(desc.includes('second paragraph content'), `${mode}: second chunk preserved`);
  }
});

test('tavilySearch preserves non-whitespace-adjacent literal [...] in code/quotes in default/yes mode', async () => {
  for (const mode of ['no', 'yes'] as const) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, {
      results: [
        {
          title: 'T',
          url: 'https://tavily.example/post',
          content:
            "Code: `array[...]` and quoted `'[...]'` and inline `` `[...]` `` stay literal. `[...]` standalone stays literal too. Then a real prose join. [...] And it ends.",
        },
      ],
    });
    const results = await tavilySearch(`chunk-literal-${mode}`, 'key', 10, 'moderate', mode);
    const desc = results[0]?.description ?? '';
    assert.ok(desc.includes('array[...]'), `${mode}: array[...] preserved`);
    assert.ok(desc.includes("'[...]'"), `${mode}: quoted literal preserved`);
    assert.ok(desc.includes('`[...]`'), `${mode}: inline-code literal preserved`);
    assert.ok(desc.includes('`[...]` standalone'), `${mode}: standalone literal preserved`);
    assert.ok(
      !desc.includes('prose join. [...]'),
      `${mode}: whitespace-delimited prose join normalized`,
    );
    assert.ok(
      desc.includes('prose join.\n\nAnd it ends.'),
      `${mode}: prose join became paragraph break`,
    );
  }
});

test('tavilySearch preserves literal [...] in only ultra-fast summary mode', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [
      {
        title: 'T',
        url: 'https://tavily.example/post',
        content: 'Summary mentions [...] as literal content.',
      },
    ],
  });
  const results = await tavilySearch('chunk-delimiter-only', 'key', 10, 'moderate', 'only');
  assert.ok(
    results[0]?.description.includes('[...]'),
    'only summary mode keeps the literal [...] delimiter',
  );
});

test('tavilySearch cache keys differ by summary mode', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(SAMPLE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await tavilySearch('cache-mode-q', 'key', 10, 'moderate', 'no');
  await tavilySearch('cache-mode-q', 'key', 10, 'moderate', 'only');
  await tavilySearch('cache-mode-q', 'key', 10, 'moderate', 'only');
  assert.equal(calls, 2, 'no and only are separate cache entries; repeated only hits cache');
});

test('tavilySearch tolerates untrusted response containers (object, null, scalar) mapping to []', async () => {
  for (const container of [{}, null, 42, 'scalar', true, { nope: true }]) {
    const captured: CapturedRequest[] = [];
    mockFetch(captured, { results: container });
    const results = await tavilySearch('tavily-container', 'key', 10, 'moderate', 'no');
    assert.deepEqual(results, [], `container ${JSON.stringify(container)} maps to empty`);
  }
});

test('tavilySearch skips null/scalar result entries without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    results: [null, 42, 'junk', SAMPLE.results[0], null],
  });

  const results = await tavilySearch('tavily-skips', 'key', 10, 'moderate', 'no');

  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, 'https://tavily.example/post');
  assert.equal(results[0]?.position, 1, 'position renumbered across skipped entries');
});

test('tavilySearch tolerates malformed (numeric) fields without throwing', async () => {
  const captured: CapturedRequest[] = [];
  mockFetch(captured, {
    answer: 1,
    results: [
      {
        title: 123,
        url: 456,
        content: 789,
        score: 'high',
        raw_content: 42,
      },
    ],
  });
  const results = await tavilySearch('q-malformed', 'key', 10, 'moderate', 'no');
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.title, '', 'numeric title coerced to empty string');
  assert.equal(r.url, '', 'numeric url coerced to empty string');
  assert.equal(r.description, '', 'numeric content coerced to empty string');
  assert.equal(r.extraSnippet, null, 'no relevance/raw extras surfaced');
});
