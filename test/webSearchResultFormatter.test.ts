import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanResultMarkdown,
  splitIntoSentences,
  splitIntoBlocks,
  formatWebSearchMarkdown,
  formatWebSearchMarkdownDetailed,
  isNavigationOnlySearchResult,
  ARTIFACT_MAX_BYTES,
  TRUNCATION_NOTE,
  DEFAULT_DOCUMENT_BUDGET_BYTES,
  DOCUMENT_BUDGET_CEILING_BYTES,
  adaptiveDocumentBudget,
  sanitizeMarkdownLinks,
} from '../src/tools/webSearchResultFormatter.js';
import { scrubContent } from '../src/utils/contentScrubber.js';
import type { SearchResult } from '../src/types.js';

function utf8(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Example Title',
    url: 'https://example.com/page',
    description: 'First sentence about the result. Second sentence with more detail.',
    position: 1,
    domain: 'example.com',
    source: 'brave',
    age: '2 days ago',
    extraSnippet: null,
    deepLinks: null,
    ...overrides,
  };
}

test('splitIntoSentences avoids decimal splits', () => {
  assert.deepEqual(splitIntoSentences('The API costs 9.99 USD. It is cheap.'), [
    'The API costs 9.99 USD.',
    'It is cheap.',
  ]);
});

test('splitIntoSentences avoids version number splits', () => {
  assert.deepEqual(splitIntoSentences('Version 2.4.1 shipped today. It works.'), [
    'Version 2.4.1 shipped today.',
    'It works.',
  ]);
});

test('splitIntoSentences avoids abbreviation splits', () => {
  assert.deepEqual(splitIntoSentences('Dr. Smith spoke. He left.'), [
    'Dr. Smith spoke.',
    'He left.',
  ]);
  assert.deepEqual(splitIntoSentences('Use tools e.g. search. They help.'), [
    'Use tools e.g. search.',
    'They help.',
  ]);
  assert.deepEqual(splitIntoSentences('He moved to the U.S. It was cold.'), [
    'He moved to the U.S.',
    'It was cold.',
  ]);
  assert.deepEqual(splitIntoSentences('He moved to the U.S. market. Prices rose.'), [
    'He moved to the U.S. market.',
    'Prices rose.',
  ]);
});

test('splitIntoSentences avoids URL splits', () => {
  assert.deepEqual(splitIntoSentences('Visit https://example.com. It loads fast.'), [
    'Visit https://example.com.',
    'It loads fast.',
  ]);
});

test('splitIntoSentences merges numbered list markers with following text', () => {
  assert.deepEqual(splitIntoSentences('1. First item. 2. Second item.'), [
    '1. First item.',
    '2. Second item.',
  ]);
});

test('splitIntoSentences keeps trailing punctuation runs attached', () => {
  assert.deepEqual(splitIntoSentences('Wait... Really?! Yes.'), ['Wait...', 'Really?!', 'Yes.']);
});

test('cleanResultMarkdown strips nav/boilerplate before splitting', () => {
  const text =
    '[Skip to content](#main)\n\nReal content paragraph here with details.\n\n[Privacy Policy](/privacy) [Terms](/terms)\n\nCopyright © 2024 Acme Corp';
  const cleaned = cleanResultMarkdown(text);
  assert.ok(!cleaned.includes('Skip to content'), 'skip-link stripped');
  assert.ok(!cleaned.includes('Privacy Policy'), 'pure link row stripped');
  assert.ok(!cleaned.includes('Copyright'), 'footer boilerplate stripped');
  assert.ok(cleaned.includes('Real content paragraph here'), 'content preserved');
});

test('cleanResultMarkdown strips article chrome sections and preserves repeated body prose', () => {
  const cleaned = cleanResultMarkdown(
    '# Article\n\nLead prose.\n\n## Related posts\n\n[Other story](https://example.com/other)\n\n## Subscribe\n\nGet updates by email.\n\n## Body\n\nMain body.\n\nMain body.\n\n## Comments\n\nLeave a comment.',
  );
  assert.ok(cleaned.includes('Lead prose.'), 'article prose preserved');
  assert.ok(cleaned.includes('Main body.'), 'body preserved');
  assert.equal(
    (cleaned.match(/Main body\./g) ?? []).length,
    2,
    'two identical paragraphs both survive (no content-fingerprint dedup)',
  );
  assert.ok(!cleaned.includes('Get updates by email'), 'subscribe section removed');
  assert.ok(!cleaned.includes('Leave a comment'), 'comments section removed');
});

test('cleanResultMarkdown removes standalone image remnants but preserves inline image alt', () => {
  const cleaned = cleanResultMarkdown(
    '![social preview](https://example.com/social.png)\n\nThis paragraph includes ![article diagram](https://example.com/diagram.png) as context.',
  );
  assert.ok(!cleaned.includes('social preview'), 'standalone image removed');
  assert.ok(cleaned.includes('article diagram'), 'inline article image alt preserved');
});

test('cleanResultMarkdown preserves standalone article links', () => {
  const cleaned = cleanResultMarkdown('[Read methodology](https://example.com/methodology)');
  assert.equal(cleaned, '[Read methodology](https://example.com/methodology)');
});

test('cleanResultMarkdown keeps literal content inside both code fence forms', () => {
  const input =
    '```html\n<script>alert(1)</script>\n<b>literal</b>\n```\n\n~~~md\n[Privacy](https://example.com/privacy) [Terms](https://example.com/terms)\n~~~';
  const cleaned = cleanResultMarkdown(input);
  assert.ok(cleaned.includes('<script>alert(1)</script>'));
  assert.ok(cleaned.includes('<b>literal</b>'));
  assert.ok(cleaned.includes('[Privacy](https://example.com/privacy)'));
});

test('cleanResultMarkdown does not strip boilerplate-shaped headings in code', () => {
  const cleaned = cleanResultMarkdown(
    '```md\n## Subscribe\n[Example](https://example.com)\n```\n\nArticle prose remains.',
  );
  assert.ok(cleaned.includes('## Subscribe'));
  assert.ok(cleaned.includes('Article prose remains.'));
});

test('cleanResultMarkdown removes link grids while preserving code and tables', () => {
  const cleaned = cleanResultMarkdown(
    '[Home](/) [Docs](/docs) [Blog](/blog)\n\n```md\n[Home](/) [Docs](/docs) [Blog](/blog)\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |',
  );
  assert.ok(!cleaned.startsWith('[Home]'), 'navigation grid removed');
  assert.ok(cleaned.includes('[Home](/) [Docs](/docs)'), 'code preserved');
  assert.ok(cleaned.includes('| 1 | 2 |'), 'table preserved');
});

test('cleanResultMarkdown removes scripts/styles/nav and converts inline HTML', () => {
  const text =
    '<nav><a href="/x">Nav</a></nav><script>alert(1)</script><style>.x{}</style>' +
    '<h2>Heading</h2><p>Some <b>bold</b> and <a href="https://e.com">link</a> text &amp; more.</p>';
  const cleaned = cleanResultMarkdown(text);
  assert.ok(!cleaned.includes('alert'), 'script content stripped');
  assert.ok(!cleaned.includes('.x{}'), 'style content stripped');
  assert.ok(!cleaned.includes('<nav'), 'nav tag removed');
  assert.ok(!cleaned.includes('&amp;'), 'entity decoded to &');
  assert.ok(cleaned.includes('**bold**'), 'bold converted to markdown');
  assert.ok(cleaned.includes('[link](https://e.com)'), 'link converted to markdown');
  assert.ok(cleaned.includes('## Heading'), 'heading converted to markdown');
  assert.ok(cleaned.includes('Some'), 'paragraph text preserved');
});

test('cleanResultMarkdown removes header/footer/form subtrees but preserves aside content (blog chrome)', () => {
  const text =
    '<header><nav><a href="/home">Home</a></nav><h1>Site brand</h1></header>' +
    '<main><p>Real article body with details.</p></main>' +
    '<aside><p>Related links and promos</p></aside>' +
    '<form action="/subscribe"><input name="email"><button>Subscribe</button></form>' +
    '<footer><p>Copyright © 2024 Acme. All rights reserved.</p></footer>' +
    '<script>window.ads = 1;</script><style>.promo{}</style>';
  const cleaned = cleanResultMarkdown(text);
  assert.ok(!cleaned.includes('Site brand'), 'header content stripped');
  assert.ok(!cleaned.includes('Home'), 'header nav stripped');
  assert.ok(cleaned.includes('Related links and promos'), 'aside content preserved as plain text');
  assert.ok(!cleaned.includes('<aside'), 'aside tag removed');
  assert.ok(!cleaned.includes('Subscribe'), 'form content stripped');
  assert.ok(!cleaned.includes('Copyright'), 'footer content stripped');
  assert.ok(!cleaned.includes('window.ads'), 'script stripped');
  assert.ok(!cleaned.includes('.promo'), 'style stripped');
  assert.ok(cleaned.includes('Real article body with details.'), 'main article content preserved');
});

test('formatWebSearchMarkdown trims long timestamped YouTube transcript and adds honest note', () => {
  const transcriptLines = Array.from(
    { length: 40 },
    (_, i) => `00:${String(i).padStart(2, '0')} Line of transcript ${i}`,
  );
  const result = makeResult({
    url: 'https://www.youtube.com/watch?v=abc',
    domain: 'www.youtube.com',
    title: 'Keynote',
    description: transcriptLines.join('\n'),
    age: null,
  });
  const md = formatWebSearchMarkdown([result]);
  // Transcript is trimmed to the first few lines with an honest note.
  assert.match(md, /Long transcript trimmed/);
  assert.ok(md.includes('00:00 Line of transcript 0'), 'first transcript line present');
  assert.ok(!md.includes('00:39'), 'long tail of transcript not emitted');
});

test('formatWebSearchMarkdown does not add a transcript note for an ordinary multiline YouTube snippet', () => {
  // Ordinary multiline snippet on a YouTube URL must not be treated as a
  // transcript: no trim note, and all prose lines retained within the
  // snippet sentence cap.
  const lines = [
    'In this video we cover five tips for better code review.',
    'First, keep pull requests small and focused.',
    'Second, leave actionable comments, not vague ones.',
    'Third, review promptly so authors are not blocked.',
  ];
  const result = makeResult({
    url: 'https://www.youtube.com/watch?v=xyz',
    domain: 'www.youtube.com',
    title: 'Code review tips',
    description: lines.join('\n'),
    age: null,
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('Long transcript trimmed'), 'no transcript note for an ordinary snippet');
  for (const line of lines) {
    assert.ok(md.includes(line), `line retained within cap: ${line}`);
  }
});

test('formatWebSearchMarkdown does not trim a short non-YouTube description', () => {
  const md = formatWebSearchMarkdown([makeResult({ age: null })]);
  assert.ok(!md.includes('Long transcript trimmed'), 'no transcript note for short content');
  assert.ok(
    md.includes('First sentence about the result. Second sentence with more detail. [1-1]'),
  );
});

test('buildDocumentContent prevents description + extraSnippet duplication', () => {
  const description =
    'The framework exposes a stable API for building reliable distributed systems. '.repeat(2);
  // extraSnippet is a substantial near-duplicate of the description (e.g. a
  // provider repeating its own snippet) and must not be emitted twice.
  const result = makeResult({
    description,
    extraSnippet: 'The framework exposes a stable API for building reliable distributed systems.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.equal(
    (md.match(/exposes a stable API for building reliable distributed systems/g) ?? []).length,
    2,
    'snippet text appears only in the description, not duplicated',
  );
});

test('metadata line labels fetched vs published age and source quality honestly', () => {
  const fetched = formatWebSearchMarkdown([
    makeResult({ source: 'brave', age: '2026-01-05', ageKind: 'fetched', contentKind: 'snippet' }),
  ]);
  assert.match(fetched, /via: Brave \(content\) · fetched: 2026-01-05/);

  const quality = formatWebSearchMarkdown([
    makeResult({
      source: 'exa',
      age: '2 days ago',
      ageKind: 'published',
      contentKind: 'snippet',
      sourceQuality: 'high',
    }),
  ]);
  assert.match(
    quality,
    /via: Exa \(content\) · published: 2 days ago · quality: high — generic domain prior/,
  );
});

test('splitIntoBlocks keeps code fences and tables as whole blocks', () => {
  const blocks = splitIntoBlocks('```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['code', 'table']);
  assert.equal(blocks[0]!.text.includes('const a = 1;'), true);
  assert.equal(blocks[1]!.text.includes('| 1 | 2 |'), true);
});

test('splitIntoBlocks does not absorb prose that follows a table into the table block', () => {
  const blocks = splitIntoBlocks('| a | b |\n|---|---|\n| 1 | 2 |\nAfter table prose.');
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['table', 'prose']);
  assert.equal(blocks[0]!.text.includes('| 1 | 2 |'), true);
  assert.ok(!blocks[0]!.text.includes('After table prose'), 'table block stops before prose');
  assert.equal(blocks[1]!.text, 'After table prose.', 'prose is its own block');
});

test('formatWebSearchMarkdown separates table prose into its own cited block', () => {
  const result = makeResult({ description: '| a | b |\n|---|---|\n| 1 | 2 |\nAfter table prose.' });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /\| 1 \| 2 \|\n\[1-1\]\n\nAfter table prose\. \[1-2\]/);
});

test('backslash-escaped label: [outer \\] label] is complete and renders non-active text', () => {
  const result = makeResult({ description: 'Click [outer \\] label](javascript:evil) now.' });
  const md = formatWebSearchMarkdown([result]);
  // The escaped `]` is part of the label, not the closer: the link is complete,
  // recognized, and the javascript: target is rendered as plain visible text.
  assert.ok(!md.includes('javascript:evil'), 'no active javascript link');
  assert.ok(!md.includes('](javascript'), 'no url tail remains');
  assert.match(md, /Click outer \] label now\. \[1-1\]/);
});

test('backslash-escaped label in title renders as plain header text, never a link', () => {
  const result = makeResult({
    title: 'See [outer \\] label](javascript:evil)',
    description: 'Body.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('javascript:evil'), 'dangerous title link removed');
  assert.match(md, /^## \[1\] See outer \] label$/m);
  assert.ok(!md.includes(']('), 'no link syntax in header line');
});

test('escaped-label http(s) link is preserved with its URL', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ description: 'Docs [outer \\] label](https://example.com/a) end.' }),
  ]);
  assert.ok(
    md.includes('[outer \\] label](https://example.com/a)'),
    'escaped-label http link kept',
  );
});

test('AI summary section labels the provider when generatedSummaryProvider is known', () => {
  const result = makeResult({
    description: 'Body.',
    generatedSummary: 'Native summary.',
    generatedSummaryProvider: 'exa',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.match(md, /### AI summary \(Exa\)/);
  assert.match(md, /Native summary\./);
});

test('AI summary section omits the provider suffix when provider is unknown', () => {
  const result = makeResult({
    description: 'Body.',
    generatedSummary: 'Native summary.',
    generatedSummaryProvider: undefined,
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.match(md, /^### AI summary$/m, 'no provider suffix when unknown');
});

test('formatWebSearchMarkdown emits bare markdown with heading and per-result sections', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ position: 1, age: '2 days ago' }),
    makeResult({
      title: 'Second Result',
      url: 'https://example.com/two',
      description: 'Single sentence here.',
      position: 2,
      age: null,
      engines: ['codex', 'brave'],
      source: 'codex',
    }),
  ]);

  assert.ok(md.startsWith('# Web search results'), 'top heading');
  assert.ok(!md.startsWith('{'), 'no JSON envelope');
  assert.ok(!md.includes('<search_results'), 'no XML envelope');
  assert.ok(!md.includes('<document'), 'no XML documents');
  assert.match(md, /^## \[1\] Example Title$/m);
  assert.match(md, /^url: https:\/\/example\.com\/page$/m);
  assert.match(md, /^## \[2\] Second Result$/m);
  assert.match(md, /^url: https:\/\/example\.com\/two$/m);
  assert.match(md, /via: Brave \(content\) · date: 2 days ago/m);
  assert.match(md, /via: Codex \(content\), Brave/m);
  // Block citations
  assert.match(md, /First sentence about the result\. Second sentence with more detail\. \[1-1\]/);
  assert.match(md, /Single sentence here\. \[2-1\]/);
});

test('indivisible code block: fenced closer stays intact, citation on own line', () => {
  const result = makeResult({
    description: '',
    extraSnippet: '```ts\nconst a = 1;\nconst b = 2;\n```',
  });
  const md = formatWebSearchMarkdown([result]);
  // Fenced closer must not be altered: the citation lands on its own line.
  assert.match(md, /```ts\nconst a = 1;\nconst b = 2;\n```\n \[1-1\]/);
  assert.ok(!/``` \[/.test(md), 'closer must not share a line with the citation');
  assert.match(md, /^```$/m, 'fenced closer is exactly ```');
});

test('indivisible table: citation placed on its own line after the table', () => {
  const result = makeResult({
    description: '',
    extraSnippet: '| a | b |\n|---|---|\n| 1 | 2 |',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(md.includes('| a | b |\n|---|---|\n| 1 | 2 |'), 'table rows intact');
  assert.match(md, /\| 1 \| 2 \|\n\[1-1\]/, 'citation flush-left on own line after last table row');
  assert.ok(!/\| 1 \| 2 \| \[/.test(md), 'table row must not carry the citation inline');
});

test('fenced code block preserved whole (not split into sentences)', () => {
  const result = makeResult({
    description: '',
    extraSnippet: 'Lead in.\n\n```js\nconst x = 1;\n```\n\ntrailing sentence.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(md.includes('```js\nconst x = 1;\n```'), 'code fence kept intact');
  assert.ok(md.includes('Lead in. [1-1]'), 'lead-in sentence cited');
  assert.ok(md.includes('trailing sentence. [1-3]'), 'trailing sentence cited');
});

test('formatWebSearchMarkdown falls back to title when content is empty', () => {
  const result = makeResult({ description: '', extraSnippet: null });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /Example Title \[1-1\]/);
});

test('formatWebSearchMarkdown includes AI summary only for aiSummary=yes', () => {
  const base = makeResult({ description: 'Body sentence.', generatedSummary: 'Native summary.' });
  const no = formatWebSearchMarkdown([base], { aiSummary: 'no' });
  const yes = formatWebSearchMarkdown([base], { aiSummary: 'yes' });
  assert.ok(!no.includes('### AI summary'), 'no mode omits AI summary');
  assert.ok(!no.includes('Native summary.'), 'no mode omits summary text');
  assert.match(yes, /### AI summary/);
  assert.match(yes, /Native summary\./);
  assert.ok(yes.includes('Body sentence. [1-1]'), 'body still present in yes mode');
});

test('aiSummary only uses summary-only content, no separate AI summary section', () => {
  const result = makeResult({
    description: 'A generated summary only.',
    contentKind: 'summary',
    generatedSummary: null,
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'only' });
  assert.ok(md.includes('A generated summary only.'), 'summary is the body content');
  assert.ok(!md.includes('### AI summary'), 'only mode has no separate AI summary section');
});

test('output budget trims whole blocks at a block boundary and appends the truncation note', () => {
  // First short paragraph fits; the oversized second paragraph cannot fit the
  // remaining budget, so the WHOLE second paragraph is dropped (never partial).
  const description =
    'Short paragraph one.\n\n' +
    'This is the start of an oversized second paragraph that ' +
    'is too long to fit '.repeat(100) +
    'the remaining budget.';
  const md = formatWebSearchMarkdown([makeResult({ description })], {
    documentBudgetBytes: 600,
  });
  assert.ok(md.includes(TRUNCATION_NOTE), 'truncation note appended');
  assert.match(md, /Short paragraph one\. \[1-1\]/);
  assert.ok(!md.includes('oversized second paragraph'), 'oversized block dropped whole');
});

test('total budget caps the number of documents emitted', () => {
  const results = [
    makeResult({ title: 'A', url: 'https://example.com/a', description: 'Alpha.' }),
    makeResult({ title: 'B', url: 'https://example.com/b', description: 'Beta.' }),
    makeResult({ title: 'C', url: 'https://example.com/c', description: 'Gamma.' }),
  ];
  // Small total budget: only the first document fits.
  const md = formatWebSearchMarkdown(results, { totalBudgetBytes: 220 });
  assert.ok(md.includes('## [1] A'), 'first document present');
  assert.ok(!md.includes('## [3] C'), 'third document excluded by total budget');
  assert.ok(md.includes(TRUNCATION_NOTE));
});

test('default budgets allow a full result and no truncation note', () => {
  const md = formatWebSearchMarkdown([makeResult({})]);
  assert.ok(!md.includes(TRUNCATION_NOTE));
  assert.ok(md.includes('Second sentence with more detail. [1-1]'));
});

test('DEFAULT_DOCUMENT_BUDGET_BYTES is 8KiB for rich full-result output', () => {
  assert.equal(DEFAULT_DOCUMENT_BUDGET_BYTES, 8 * 1024);
});

test('contentKind is surfaced in the metadata line', () => {
  const md = formatWebSearchMarkdown([makeResult({ contentKind: 'full', source: 'exa' })]);
  assert.match(md, /via: Exa \(content\) · date: 2 days ago · content: full/);
});

test('metadata line labels age as date: (not published) when ageKind is absent or unknown', () => {
  const absent = formatWebSearchMarkdown([
    makeResult({ source: 'brave', age: '2026-01-05', contentKind: 'snippet' }),
  ]);
  assert.match(absent, /via: Brave \(content\) · date: 2026-01-05/);
  assert.ok(!absent.includes('published:'), 'unclassified age origin never claims publication');

  const unknown = formatWebSearchMarkdown([
    makeResult({ source: 'brave', age: '2026-01-05', ageKind: 'unknown', contentKind: 'snippet' }),
  ]);
  assert.match(unknown, /via: Brave \(content\) · date: 2026-01-05/);
  assert.ok(!unknown.includes('published:'), 'unknown age origin never claims publication');
});

test('cleanResultMarkdown preserves literal [...] in prose (no global normalization)', () => {
  const cleaned = cleanResultMarkdown(
    'First URL-attributed chunk of the snippet. [...] Second chunk continues the excerpt.',
  );
  assert.ok(cleaned.includes('[...]'), 'provider chunk delimiter preserved by the formatter');
  assert.ok(cleaned.includes('First URL-attributed chunk'), 'first chunk preserved');
  assert.ok(cleaned.includes('Second chunk continues'), 'second chunk preserved');
});

test('cleanResultMarkdown preserves literal [...] inside inline and fenced code', () => {
  const inline = cleanResultMarkdown('Use the `arr[...]` rest syntax in this example.');
  assert.ok(inline.includes('arr[...]'), 'inline-code [...] preserved');

  const fenced = cleanResultMarkdown(
    'Lead in.\n\n```js\nconst arr = [1, ...rest];\n```\n\nTrailing.',
  );
  assert.ok(fenced.includes('[1, ...rest]'), 'fenced-code brackets/ellipsis preserved');
  assert.ok(fenced.includes('Lead in.'), 'prose preserved');
  assert.ok(fenced.includes('Trailing.'), 'trailing prose preserved');
});

test('cleanResultMarkdown preserves legitimate prose ellipses (no brackets)', () => {
  const cleaned = cleanResultMarkdown('He trailed off... then continued. Still went on.');
  assert.ok(cleaned.includes('...'), 'legitimate prose ellipsis preserved');
});

test('renders javascript: in raw HTML as plain label, never an active link', () => {
  const result = makeResult({
    description: 'See <a href="javascript:alert(1)">click me</a> now.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('javascript:alert(1)'), 'raw JS href never emitted');
  assert.match(md, /See click me now\. \[1-1\]/);
});

test('renders javascript: in a markdown link as its label, preserves http(s) links', () => {
  const result = makeResult({
    description:
      'The documentation at [safe](https://example.com/doc) is recommended, while [bad](javascript:evil) should never be used because it is dangerous.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(md.includes('[safe](https://example.com/doc)'), 'safe markdown link preserved');
  assert.ok(!md.includes('javascript:evil'), 'dangerous markdown link neutralized');
  assert.match(md, /bad should never be used because it is dangerous\. \[1-1\]/);
});

test('title with dangerous schemes is normalized to safe plain inline text', () => {
  const result = makeResult({
    title: 'Click [here](javascript:evil) now',
    description: 'Body.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('javascript:evil'), 'dangerous title link removed');
  assert.match(md, /^## \[1\] Click here now$/m);
  assert.match(md, /^url: https:\/\/example\.com\/page$/m);
});

test('AI summary is cleaned and cited as whole blocks, continuing per-doc sequence', () => {
  const result = makeResult({
    description: 'Body sentence one. Body sentence two.',
    generatedSummary: 'Summary first sentence. Summary second sentence.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.match(md, /### AI summary/);
  assert.match(md, /Body sentence one\. Body sentence two\. \[1-1\]/);
  assert.match(md, /Summary first sentence\. Summary second sentence\. \[1-2\]/);
  assert.ok(!/\[1-3\]/.test(md), 'no per-sentence summary citations');
});

test('sanitizes generated summary: dangerous links neutralized, no title/body duplication', () => {
  const result = makeResult({
    title: 'Doc Title',
    description: 'Body prose.',
    generatedSummary: 'Summary with <a href="javascript:x()">bad</a> and [ok](https://ok.example).',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.ok(!md.includes('javascript:x'), 'dangerous summary link neutralized');
  assert.ok(md.includes('[ok](https://ok.example)'), 'safe summary link preserved');
  // Title and body appear exactly once; the summary does not duplicate them.
  assert.equal((md.match(/Body prose\./g) ?? []).length, 1, 'body not duplicated');
  assert.equal((md.match(/Doc Title/g) ?? []).length, 1, 'title not duplicated');
});

test('adversarial 100KB multi-byte title cannot bypass the per-document budget', () => {
  const result = makeResult({ title: '😀'.repeat(100 * 1024), description: 'Short body.' });
  const md = formatWebSearchMarkdown([result], { documentBudgetBytes: 256 });
  const header = '# Web search results\n\n';
  const noteIdx = md.indexOf(TRUNCATION_NOTE);
  const docSection = noteIdx === -1 ? md.slice(header.length) : md.slice(header.length, noteIdx);
  assert.ok(utf8(docSection) <= 256, `doc section ${utf8(docSection)} bytes > 256`);
  // Truncation must never split a UTF-8 code point (no orphan surrogates).
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(md), 'no orphan high surrogate');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(md), 'no orphan low surrogate');
});

test('total budget: output never exceeds configured total, including truncation note', () => {
  const results = [
    makeResult({ title: 'A', description: 'Alpha sentence one. Second alpha sentence.' }),
    makeResult({ title: 'B', description: 'Beta sentence here.' }),
    makeResult({ title: 'C', description: 'Gamma sentence.' }),
  ];
  const full = formatWebSearchMarkdown(results);
  const fullBytes = utf8(full);
  for (let budget = Math.max(1, fullBytes - 200); budget <= fullBytes + 200; budget++) {
    const out = formatWebSearchMarkdown(results, { totalBudgetBytes: budget });
    assert.ok(utf8(out) <= budget, `budget=${budget} exceeded by output=${utf8(out)}`);
  }
});

test('total one-byte-over: truncation note reservation keeps output within budget', () => {
  const result = makeResult({ title: 'A', description: 'Alpha sentence one. Second alpha.' });
  const full = formatWebSearchMarkdown([result]);
  const base = '# Web search results\n\n';
  // Budget is one byte short of header + document + note, forcing truncation.
  const docSection = full.slice(base.length);
  const budget = utf8(base + docSection + TRUNCATION_NOTE + '\n') - 1;
  const out = formatWebSearchMarkdown([result], { totalBudgetBytes: budget });
  assert.ok(utf8(out) <= budget, `one-byte-over: ${utf8(out)} > ${budget}`);
  assert.ok(out.includes(TRUNCATION_NOTE), 'truncation note emitted');
});

test('total budget: exact even for tiny/zero budgets below heading and note', () => {
  const results = [makeResult({ title: 'A', description: 'Alpha.' })];
  const full = formatWebSearchMarkdown(results);
  const fullBytes = utf8(full);
  for (let budget = 0; budget <= Math.min(fullBytes, 90); budget++) {
    const out = formatWebSearchMarkdown(results, { totalBudgetBytes: budget });
    assert.ok(utf8(out) <= budget, `budget=${budget} exceeded by output=${utf8(out)}`);
  }
});

test('total budget: zero returns empty string', () => {
  const results = [makeResult({ title: 'A', description: 'Alpha.' })];
  const out = formatWebSearchMarkdown(results, { totalBudgetBytes: 0 });
  assert.equal(out, '');
});

test('entity decoding never reactivates active HTML in body/title/summary', () => {
  const result = makeResult({
    title: '&lt;img src=y onerror=alert(2)&gt;',
    description: 'Body &lt;img src=x onerror=alert(1)&gt; here.',
    generatedSummary: 'Summary &lt;svg/onload=alert(3)&gt; text.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.ok(!md.includes('<img'), 'no raw active <img> tag in output');
  assert.ok(!md.includes('<svg'), 'no raw active <svg> in output');
  assert.ok(md.includes('&lt;img'), 'title/body img kept inert escaped form');
  assert.ok(md.includes('&lt;svg'), 'summary svg kept inert escaped form');
});

test('SCRUB_CONTENT-relevant: entity-encoded tag not caught by scrubber stays inert', () => {
  // No event handler / <script> / javascript:, so scrubContent passes it through.
  const raw = 'Text &lt;img src=x&gt; more.';
  const scrubbed = scrubContent(raw);
  assert.equal(scrubbed.content, raw, 'scrubber leaves entity-encoded tag untouched');
  const md = formatWebSearchMarkdown([makeResult({ description: scrubbed.content })]);
  assert.ok(!md.includes('<img'), 'formatter neutralizes even when scrubber does not');
  assert.match(md, /Text &lt;img src=x&gt; more\./);
});

test('hostile url and age metadata cannot inject markdown or HTML', () => {
  const result = makeResult({
    url: '[x](javascript:evil)',
    age: '<b>1</b> &lt;img src=q onerror=z&gt;',
    source: 'brave',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('javascript:evil'), 'no javascript: url');
  assert.ok(!md.includes('[x]('), 'no markdown link injected from url');
  assert.ok(!md.includes('</b>') && !md.includes('<b>'), 'no html in age');
  assert.ok(!md.includes('<img'), 'no active img from age');
  assert.ok(md.includes('&lt;img'), 'age img kept escaped');
  assert.match(md, /^## \[1\] Example Title$/m, 'unsafe url omitted from header');
});

test('non-http(s) url omitted but http(s) url rendered as clickable link', () => {
  const noUrl = formatWebSearchMarkdown([makeResult({ url: 'ftp://x/file' })]);
  assert.match(noUrl, /^## \[1\] Example Title$/m, 'non-http url omitted');
  assert.ok(!noUrl.includes('ftp://'), 'no ftp url emitted');
  const httpUrl = formatWebSearchMarkdown([makeResult({ url: 'https://ok.test/a?b=1' })]);
  assert.match(httpUrl, /^## \[1\] Example Title$/m);
  assert.match(httpUrl, /^url: https:\/\/ok\.test\/a\?b=1$/m);
});

test('~~~ fenced code block preserved whole, citation on own line after closer', () => {
  const result = makeResult({ description: '', extraSnippet: '~~~py\nprint(1)\n~~~' });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(md.includes('~~~py\nprint(1)\n~~~'), '~~~ fence kept intact');
  assert.match(md, /~~~\n \[1-1\]/, 'citation on own line after closing fence');
  assert.ok(!/~~~ \[/.test(md), 'closing fence must not carry citation');
});

test('table without outer pipes separates following prose and cites each block', () => {
  const result = makeResult({
    description: '',
    extraSnippet: 'Name | Value\n---- | ----\nA | 1\nB | 2\nFollowing prose.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(md.includes('Name | Value\n---- | ----\nA | 1\nB | 2'), 'table rows intact');
  assert.match(
    md,
    /B \| 2\n \[1-1\]\n\nFollowing prose\. \[1-2\]/,
    'prose follows table as second cited block',
  );
});

test('blank-line indented list continuation stays one item while ordinary paragraph stays separate', () => {
  const result = makeResult({
    description: '',
    extraSnippet: '- First sentence.\n\n  Indented continuation sentence.\n\nOrdinary paragraph.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /- First sentence\. Indented continuation sentence\. \[1-1\]/);
  assert.match(md, /Ordinary paragraph\. \[1-2\]/);
  assert.equal((md.match(/\[1-1\]/g) ?? []).length, 1, 'list gets one citation');
});

test('unterminated fenced blocks close with matching marker before citation', () => {
  for (const marker of ['```', '~~~']) {
    const md = formatWebSearchMarkdown([
      makeResult({ description: '', extraSnippet: `${marker}js\nconst value = 1;` }),
    ]);
    assert.match(md, new RegExp(`${marker}js\\nconst value = 1;\\n${marker}\\n \\[1-1\\]`));
    assert.ok(!md.includes(`${marker} [1-1]`), 'citation stays outside closing fence');
  }
});

test('two-sentence list item: one citation per item, bullet on first sentence only', () => {
  const result = makeResult({
    description: '',
    extraSnippet: '- First sentence. Second sentence.\n- Third.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /- First sentence\. Second sentence\. \[1-1\]/);
  assert.match(md, /- Third\. \[1-2\]/);
  assert.ok(!/- Second sentence\./.test(md), 'second sentence not prefixed with bullet');
  assert.ok(!/Second sentence\. \[1-2\]/.test(md), 'no per-sentence citation inside the list item');
});

test('generated summary list cites each item once', () => {
  const result = makeResult({
    description: 'Body.',
    generatedSummary: '- Key point one. Supporting detail.\n- Key point two.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.match(md, /- Key point one\. Supporting detail\. \[1-2\]/);
  assert.match(md, /- Key point two\. \[1-3\]/);
});

test('nested malicious markdown link neutralized to visible label; nested safe link kept', () => {
  const evil = formatWebSearchMarkdown([
    makeResult({ description: 'Click [outer [inner] label](javascript:evil) now.' }),
  ]);
  assert.ok(!evil.includes('javascript:evil'), 'no active javascript link');
  assert.ok(!evil.includes('](javascript'), 'no url tail remains');
  assert.match(evil, /Click outer \[inner\] label now\. \[1-1\]/);

  const safe = formatWebSearchMarkdown([
    makeResult({ description: 'See [a [b] c](https://example.com/x) end.' }),
  ]);
  assert.ok(
    safe.includes('[a [b] c](https://example.com/x)'),
    'nested-label http(s) link preserved',
  );
});

test('markdown link with parenthesized url parsed and preserved', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ description: 'Docs [label](https://example.com/a(b)c). See also.' }),
  ]);
  assert.ok(md.includes('[label](https://example.com/a(b)c)'), 'balanced-paren url link kept');
});

test('raw HTML anchor with nested bracket label and dangerous href becomes plain text', () => {
  const cleaned = cleanResultMarkdown('<a href="javascript:evil">Click [me] here</a> text');
  assert.ok(!cleaned.includes('javascript:evil'), 'dangerous href removed');
  assert.ok(cleaned.includes('Click [me] here'), 'label kept as plain text');
});

test('linkless nested-bracket text is emitted verbatim (skip-ahead, not per-bracket rescan)', () => {
  // A linkless `[...]` with no following `(` must not force a full rescan for
  // every opening bracket (would be O(n^2) on adversarial input).
  const input = '[[[[x]]]] rest of the text here';
  assert.equal(sanitizeMarkdownLinks(input), input);
  assert.equal(sanitizeMarkdownLinks('[a [b] c] trailing'), '[a [b] c] trailing');
});

test('citation-shaped [N-M] text escaped so it cannot forge formatter citations', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ description: 'See figure [2-999] and ref [3-4]. Next.' }),
  ]);
  assert.ok(md.includes('\\[2-999]'), 'prose citation-shaped range escaped');
  assert.ok(md.includes('\\[3-4]'), 'second citation-shaped range escaped');
  assert.ok(!/(^|[^\\])\[2-999\]/.test(md), 'no unescaped forgeable citation remains');
  assert.match(md, /See figure \\\[2-999\] and ref \\\[3-4\]\. Next\. \[1-1\]/);
});

test('citation-shaped [N-M] in generated summary escaped', () => {
  const md = formatWebSearchMarkdown(
    [makeResult({ description: 'Body.', generatedSummary: 'Claims [2-7]. Done.' })],
    { aiSummary: 'yes' },
  );
  assert.ok(md.includes('\\[2-7]'), 'summary citation-shaped range escaped');
  assert.ok(!/(^|[^\\])\[2-7\]/.test(md), 'no unescaped forgeable citation in summary');
});

test('citation-shaped [N-M] inside code fence stays literal and inert', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ description: '', extraSnippet: '```js\nconst ref = [2-999];\n```' }),
  ]);
  assert.ok(md.includes('const ref = [2-999];'), 'code block keeps citation-shaped text literal');
  assert.ok(!md.includes('const ref = \\[2-999'), 'code block not escaped');
  assert.match(md, /```\n \[1-1\]/, 'own citation on own line after fence');
});

test('oversized http url is atomic: omitted entirely, never yields partial link', () => {
  const hugeUrl = 'https://example.com/' + 'x'.repeat(4000);
  const md = formatWebSearchMarkdown([makeResult({ url: hugeUrl })], { documentBudgetBytes: 150 });
  const lines = md.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('## [1]'));
  assert.ok(headerIdx !== -1, 'result header present');
  assert.equal(lines[headerIdx], '## [1] Example Title');
  assert.ok(!lines[headerIdx + 1]?.startsWith('url:'), 'no url line when it cannot fit');
  assert.ok(!md.includes('https://example.com/xxx'), 'no partial url anywhere');
  assert.ok(!md.includes('url: https'), 'no url emitted');
});

test('header title rendered as plain text, never an active link', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ title: 'Close ] bracket [x](javascript:evil)' }),
  ]);
  const line = md.split('\n').find((l) => l.startsWith('## [1]'))!;
  assert.ok(!md.includes('javascript:evil'), 'dangerous link in title removed');
  assert.equal(line, '## [1] Close ] bracket x');
  assert.ok(!line.includes(']('), 'no link syntax in header line');
});

// ── Audit-shaped chrome / density / source regressions ────────────────────────

test('cleanResultMarkdown strips a plain (non-linked) Skip to content control', () => {
  const cleaned = cleanResultMarkdown('Skip to content\n\nReal article body with details.');
  assert.ok(!cleaned.includes('Skip to content'), 'plain skip control stripped');
  assert.ok(cleaned.includes('Real article body'), 'body preserved');
});

test('cleanResultMarkdown drops chrome sections ending at a same-or-higher heading', () => {
  const cleaned = cleanResultMarkdown(
    '# Article\n\nIntro prose.\n\n## Most Popular\n\nPopular item one.\n\n### Top Story\n\nNested story prose.\n\n## Body\n\nReal body prose.',
  );
  assert.ok(cleaned.includes('Intro prose.'), 'intro preserved');
  assert.ok(cleaned.includes('Real body prose.'), 'body preserved');
  assert.ok(!cleaned.includes('Popular item one.'), 'chrome section content dropped');
  assert.ok(!cleaned.includes('Nested story prose.'), 'nested chrome child dropped');
});

test('cleanResultMarkdown preserves scientific body sections', () => {
  const cleaned = cleanResultMarkdown(
    '## Abstract\n\nAbstract summary.\n\n## Introduction\n\nBackground context.\n\n## Methods\n\nMethod details.\n\n## Results\n\nKey findings.\n\n## Discussion\n\nInterpretation.\n\n## Conclusion\n\nConclusion text.',
  );
  for (const h of [
    '## Abstract',
    '## Introduction',
    '## Methods',
    '## Results',
    '## Discussion',
    '## Conclusion',
  ]) {
    assert.ok(cleaned.includes(h), `section heading ${h} preserved`);
  }
  assert.ok(cleaned.includes('Key findings.'));
});

test('formatWebSearchMarkdown preserves a markdown blockquote as one quoted paragraph', () => {
  const result = makeResult({
    description: '> Direct source quotation. It matters.\n\nFollow up prose.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('&gt;'), 'blockquote marker not escaped to entity');
  // The quoted paragraph carries a single `>` marker and one citation.
  assert.match(md, /^> Direct source quotation\. It matters\. \[1-1\]$/m);
  assert.ok(
    !/^> Direct source quotation\. \[1-1\] It matters\. \[1-2\]$/m.test(md),
    'no per-sentence citations inside the quote',
  );
  assert.match(md, /Follow up prose\. \[1-2\]/);
});

test('formatWebSearchMarkdown caps snippet prose at whole-block granularity and appends truncation note', () => {
  // First paragraph (5 sentences) fits the 6-sentence snippet cap; the second
  // paragraph (6 sentences) would push past it, so the WHOLE second block is
  // skipped rather than partially emitted.
  const first = Array.from(
    { length: 5 },
    (_, i) => `Sentence number ${i + 1} with content details.`,
  ).join(' ');
  const second = Array.from(
    { length: 6 },
    (_, i) => `Second block sentence ${i + 1} with content details.`,
  ).join(' ');
  const md = formatWebSearchMarkdown([
    makeResult({ contentKind: 'snippet', description: `${first}\n\n${second}` }),
  ]);
  assert.ok(md.includes(TRUNCATION_NOTE), 'truncation note appended');
  assert.match(md, /Sentence number 5 with content details\. \[1-1\]/);
  assert.ok(!md.includes('Second block sentence'), 'oversized second block dropped whole');
  assert.ok(
    !/Second block sentence\.[^\n]*\[1-2\]/.test(md),
    'no partial citation for skipped block',
  );
});

test('formatWebSearchMarkdown keeps prose list and code under the snippet cap', () => {
  const result = makeResult({
    contentKind: 'snippet',
    description: '',
    extraSnippet: '- First key point. Second detail.\n- Third point.\n\n```ts\nconst x = 1;\n```',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /- First key point\. Second detail\. \[1-1\]/);
  assert.match(md, /- Third point\. \[1-2\]/);
  assert.ok(md.includes('const x = 1;'), 'code block preserved whole');
});

test('integration: bounded clean output for official/aggregator domains, no chrome or starvation', () => {
  const domains: {
    domain: string;
    score: number;
    q: 'high' | 'medium' | 'low';
    basis: string | null;
  }[] = [
    { domain: 'nature.com', score: 0.85, q: 'high', basis: 'scientific publisher' },
    { domain: 'iter.org', score: 0.75, q: 'high', basis: 'official intergovernmental project' },
    { domain: 'lbl.gov', score: 0.85, q: 'high', basis: 'government domain' },
    { domain: 'gov.uk', score: 0.85, q: 'high', basis: 'government domain' },
    {
      domain: 'techcrunch.com',
      score: 0.6,
      q: 'medium',
      basis: 'established technology journalism',
    },
    { domain: 'generalfusion.com', score: 0.55, q: 'medium', basis: 'official company source' },
    { domain: 'fusionindustryassociation.org', score: 0.45, q: 'low', basis: null },
    { domain: 'earth911.com', score: 0.4, q: 'low', basis: null },
    { domain: 'ajupress.com', score: 0.4, q: 'low', basis: null },
    { domain: 'fusion.blog.blogspot.com', score: 0.2, q: 'low', basis: 'hosted blog platform' },
  ];
  const results = domains.map((d, i) =>
    makeResult({
      position: i + 1,
      title: `Fusion story ${i + 1}`,
      url: `https://${d.domain}/fusion`,
      domain: d.domain,
      source: 'exa',
      contentKind: 'snippet',
      sourceQuality: d.q,
      domainAuthorityScore: d.score,
      sourceBasis: d.basis,
      age: '1 day ago',
      ageKind: 'published',
      description:
        'An official or consumer summary sentence about fusion energy with supporting detail. Follow up sentence with additional context.\n\n' +
        'Skip to content\n\n## Most Popular\n\n[Other story](https://example.com/x)\n\nPrivacy Policy Terms\n\nCopyright © 2025 Acme.',
    }),
  );
  const md = formatWebSearchMarkdown(results);
  assert.ok(!md.includes('Skip to content'), 'skip control stripped');
  assert.ok(!md.includes('Most Popular'), 'chrome heading stripped');
  assert.ok(!md.includes('Privacy Policy'), 'legal link row stripped');
  assert.ok(!md.includes('Copyright'), 'footer stripped');
  assert.ok(!md.includes(TRUNCATION_NOTE), 'no truncation for short snippets');
  // All 10 results present (not starved) with at most 2 prose citations each.
  for (let i = 1; i <= 10; i++) {
    assert.ok(md.includes(`## [${i}] Fusion story ${i}`), `result ${i} present`);
  }
  assert.ok(!/\[\d+-3\]/.test(md), 'no snippet emits a third prose citation');
  assert.ok(utf8(md) <= 96 * 1024, `output ${utf8(md)} bytes > 96 KiB`);
  // Source credibility tier surfaced for curated/known docs.
  assert.match(md, /quality: high/);
  assert.match(md, /quality: medium/);
});

test('cleanResultMarkdown preserves aside content as safe plain text', () => {
  const cleaned = cleanResultMarkdown(
    '<p>Body text.</p><aside><p>Critical experimental limitation.</p></aside><p>More.</p>',
  );
  assert.ok(cleaned.includes('Critical experimental limitation.'), 'aside content preserved');
  assert.ok(!cleaned.includes('<aside'), 'aside tag removed');
  assert.ok(!cleaned.includes('<p>'), 'no raw tags remain');
});

test('cleanResultMarkdown drops Navigation / Skip navigation chrome sections', () => {
  const cleaned = cleanResultMarkdown(
    '# Article\n\nLead prose.\n\n## Navigation\n\n[Home](/)\n[About](/about)\n\n## Skip navigation\n\n[Skip to content](#main)\n\n## Body\n\nReal body prose.',
  );
  assert.ok(cleaned.includes('Real body prose.'), 'body preserved');
  assert.ok(cleaned.includes('Lead prose.'), 'lead prose preserved');
  assert.ok(!cleaned.includes('## Navigation'), 'navigation heading stripped');
  assert.ok(!cleaned.includes('## Skip navigation'), 'skip navigation heading stripped');
  assert.ok(!cleaned.includes('[Skip to content](#main)'), 'skip nav link stripped');
});

test('cleanResultMarkdown preserves two identical scientific paragraphs (no content-fingerprint dedup)', () => {
  const cleaned = cleanResultMarkdown(
    'Independent replication confirms the result.\n\nIndependent replication confirms the result.',
  );
  assert.equal(
    (cleaned.match(/Independent replication confirms the result\./g) ?? []).length,
    2,
    'both identical paragraphs survive',
  );
});

test('default per-document budget caps a large full result body at the adaptive ceiling', () => {
  // A realistic full result is many blank-line-separated paragraphs; earlier
  // blocks fit the per-document ceiling and later blocks are dropped whole (a
  // block is never partially emitted).
  const paragraphs = Array.from(
    { length: 400 },
    (_, i) =>
      `Full paragraph ${i + 1}. It contains several sentences with enough content details. The second sentence adds more substance.`,
  ).join('\n\n');
  const md = formatWebSearchMarkdown([
    makeResult({ contentKind: 'full', description: paragraphs }),
  ]);
  const base = '# Web search results\n\n';
  const noteIdx = md.indexOf(TRUNCATION_NOTE);
  assert.ok(noteIdx !== -1, 'truncation note appended');
  const docSection = md.slice(base.length, noteIdx);
  assert.ok(
    utf8(docSection) <= DOCUMENT_BUDGET_CEILING_BYTES,
    `doc section ${utf8(docSection)} bytes > ceiling ${DOCUMENT_BUDGET_CEILING_BYTES}`,
  );
  assert.match(md, /Full paragraph 1\. It contains several sentences[^\n]*\[1-1\]/);
  assert.ok(!md.includes('Full paragraph 400.'), 'tail block dropped');
  assert.ok(
    !/Full paragraph 400\. It contains several sentences[^\n]*\[1-\d+\]/.test(md),
    'no partial trailing block',
  );
});

test('adaptiveDocumentBudget scales with result count between floor and ceiling', () => {
  const total = 192 * 1024;
  // One result: capped at the ceiling, not the total.
  assert.equal(adaptiveDocumentBudget(1, total), DOCUMENT_BUDGET_CEILING_BYTES);
  // Many results: floored, not starved below the floor.
  assert.equal(adaptiveDocumentBudget(100, total), DEFAULT_DOCUMENT_BUDGET_BYTES);
  // Ten results: a mid-range share well above the old fixed 8 KiB cap.
  const ten = adaptiveDocumentBudget(10, total);
  assert.ok(ten > DEFAULT_DOCUMENT_BUDGET_BYTES, `ten-result share ${ten} <= floor`);
  assert.ok(ten <= DOCUMENT_BUDGET_CEILING_BYTES, `ten-result share ${ten} > ceiling`);
  // Degenerate input falls back to the floor.
  assert.equal(adaptiveDocumentBudget(0, total), DEFAULT_DOCUMENT_BUDGET_BYTES);
});

test('formatWebSearchMarkdown caps snippet list prose at six sentences but keeps atomic code', () => {
  const result = makeResult({
    contentKind: 'snippet',
    description: '',
    extraSnippet: '- One. Two.\n- Three. Four.\n- Five. Six.\n- Seven.\n\n```ts\nconst x = 1;\n```',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /- One\. Two\. \[1-1\]/);
  assert.match(md, /- Three\. Four\. \[1-2\]/);
  assert.match(md, /- Five\. Six\. \[1-3\]/);
  assert.ok(!md.includes('Seven.'), 'seventh list sentence dropped whole with its item');
  assert.ok(md.includes('const x = 1;'), 'atomic code block retained after prose cap');
});

test('ten ~2.5KiB clean provider excerpts all remain present under 96KiB after six-sentence cap', () => {
  const results = Array.from({ length: 10 }, (_, i) =>
    makeResult({
      position: i + 1,
      title: `Result ${i + 1}`,
      url: `https://example.com/r${i + 1}`,
      domain: 'example.com',
      contentKind: 'snippet',
      description: Array.from({ length: 6 }, () => 'x'.repeat(420) + '. ').join(' '),
    }),
  );
  const md = formatWebSearchMarkdown(results);
  for (let i = 1; i <= 10; i++) {
    assert.ok(md.includes(`## [${i}] Result ${i}`), `result ${i} present`);
  }
  assert.ok(utf8(md) <= 96 * 1024, `output ${utf8(md)} bytes > 96 KiB`);
  assert.ok(!md.includes(TRUNCATION_NOTE), 'no truncation note when all fit');
});

test('ten ~6KiB full results all render under the 96KiB default total budget', () => {
  // Rich full-result prose (~6 KiB per document). contentKind 'full' disables the
  // snippet six-sentence cap so the byte budget is what bounds output here.
  const sentence =
    'A detailed paragraph sentence describing the reactor design parameter and its measured thermal efficiency in credible engineering terms. ';
  const results = Array.from({ length: 10 }, (_, i) => {
    let description = '';
    while (utf8(description) < 6 * 1024) {
      description += sentence;
    }
    return makeResult({
      position: i + 1,
      title: `Result ${i + 1}`,
      url: `https://example.com/r${i + 1}`,
      domain: 'example.com',
      contentKind: 'full',
      description,
    });
  });
  const md = formatWebSearchMarkdown(results);
  for (let i = 1; i <= 10; i++) {
    assert.ok(md.includes(`## [${i}] Result ${i}`), `result ${i} present`);
  }
  assert.ok(!md.includes(TRUNCATION_NOTE), 'no truncation note when all full results fit');
  assert.ok(utf8(md) <= 96 * 1024, `output ${utf8(md)} bytes > 96 KiB`);
});

test('formatWebSearchMarkdown removes chrome/legal tail before the six-sentence cap', () => {
  const result = makeResult({
    contentKind: 'snippet',
    description:
      'First body sentence with real content. Second body sentence. Third body sentence. Fourth body sentence. Fifth body sentence. Sixth body sentence.\n\n' +
      '## Legal\n\n[Terms](/terms) [Privacy](/privacy)\n\nCopyright © 2025 Acme.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.ok(!md.includes('## Legal'), 'legal heading stripped');
  assert.ok(!md.includes('Copyright'), 'footer stripped');
  assert.ok(!md.includes('Terms'), 'legal link stripped');
  assert.match(
    md,
    /First body sentence with real content\. Second body sentence\. Third body sentence\. Fourth body sentence\. Fifth body sentence\. Sixth body sentence\. \[1-1\]/,
  );
});

test('aiSummary=yes: six body sentences and three summary sentences both emitted, no empty heading', () => {
  const result = makeResult({
    description: Array.from({ length: 6 }, (_, i) => `Body sentence ${i + 1} with detail.`).join(
      ' ',
    ),
    generatedSummary: 'Summary one. Summary two. Summary three.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  assert.match(
    md,
    /Body sentence 1 with detail\. Body sentence 2 with detail\. Body sentence 3 with detail\. Body sentence 4 with detail\. Body sentence 5 with detail\. Body sentence 6 with detail\. \[1-1\]/,
  );
  assert.match(md, /### AI summary/);
  assert.match(md, /Summary one\. Summary two\. Summary three\. \[1-2\]/);
  assert.ok(!/### AI summary\s*$/.test(md), 'no empty summary heading');
});

test('aiSummary=yes: never renders an empty summary heading when the byte budget is exhausted', () => {
  const result = makeResult({
    description: 'Body sentence one. Body sentence two. Body sentence three.',
    generatedSummary: 'Summary text.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes', documentBudgetBytes: 120 });
  assert.ok(!md.includes('### AI summary'), 'no empty summary heading when budget exhausted');
});

test('aiSummary=yes: citations stay contiguous when body prose is capped (whole-block)', () => {
  const result = makeResult({
    description:
      'Body p1 s1. Body p1 s2. Body p1 s3.\n\nBody p2 s1. Body p2 s2. Body p2 s3.\n\nBody p3 s1. Body p3 s2. Body p3 s3.',
    generatedSummary: 'Summary one.\n\nSummary two.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes' });
  // Two 3-sentence paragraphs fit the 6-sentence snippet cap; the third is
  // skipped whole (never partially emitted).
  assert.match(md, /Body p1 s1\. Body p1 s2\. Body p1 s3\. \[1-1\]/);
  assert.match(md, /Body p2 s1\. Body p2 s2\. Body p2 s3\. \[1-2\]/);
  assert.ok(!md.includes('Body p3 s1.'), 'third paragraph dropped whole');
  // Summary citations continue directly after the emitted body citations — no gaps.
  assert.match(md, /Summary one\. \[1-3\]/);
  assert.match(md, /Summary two\. \[1-4\]/);
  assert.ok(!/\[1-5\]/.test(md), 'no citation gap or phantom fifth citation');
});

test('aiSummary=yes: when heading + first summary unit does not fit, neither heading nor body is emitted', () => {
  const result = makeResult({
    description: 'Body sentence one.',
    generatedSummary: 'Summary sentence that is long enough to overflow the remaining budget.',
  });
  const md = formatWebSearchMarkdown([result], { aiSummary: 'yes', documentBudgetBytes: 200 });
  assert.ok(md.includes('Body sentence one.'), 'body emitted');
  assert.ok(
    !md.includes('### AI summary'),
    'no summary heading when it cannot fit with first unit',
  );
  assert.ok(!md.includes('Summary sentence'), 'no unlabeled summary body');
});

test('formatWebSearchMarkdown does not cite heading blocks; prose starts at [1-1]', () => {
  const result = makeResult({
    description: '## Overview\n\nFirst body sentence.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /## Overview/, 'heading preserved');
  assert.ok(!/## Overview\s*\[1-\d+\]/.test(md), 'heading block is never cited');
  assert.match(md, /First body sentence\. \[1-1\]/, 'prose after heading starts at [1-1]');
});

test('aiSummary=yes: no phantom citation when a body block is dropped whole by the byte budget', () => {
  const result = makeResult({
    description: 'First body sentence. ' + 'X'.repeat(9000) + '.',
    generatedSummary: 'Summary one.',
  });
  const md = formatWebSearchMarkdown([result], {
    aiSummary: 'yes',
    documentBudgetBytes: DEFAULT_DOCUMENT_BUDGET_BYTES,
  });
  assert.ok(!md.includes('X'.repeat(100)), 'oversized body block dropped by byte budget');
  assert.ok(!md.includes('First body sentence.'), 'whole body paragraph dropped (never partial)');
  assert.match(md, /### AI summary/, 'summary heading emitted');
  assert.match(
    md,
    /Summary one\. \[1-1\]/,
    'summary citation starts at [1-1] after the dropped body block (no phantom gap)',
  );
  assert.ok(!/\[1-2\]/.test(md), 'no phantom citation from the dropped body block');
});

test('formatted output labels official vendor domains as high, not low', () => {
  const md = formatWebSearchMarkdown([
    makeResult({
      domain: 'developer.nvidia.com',
      url: 'https://developer.nvidia.com/blog/announcement',
      sourceQuality: 'high',
      domainAuthorityScore: 0.75,
      sourceBasis: 'official company source',
    }),
  ]);
  assert.match(md, /quality: high — official company source/);
  assert.ok(!md.includes('quality: low'), 'official vendor not labeled low');
});

test('non-http schemes in raw HTML, markdown, title, and summary are neutralized to label', () => {
  for (const scheme of ['data:', 'file:', 'vbscript:']) {
    const raw = cleanResultMarkdown(`See <a href="${scheme}evil">click</a> now.`);
    assert.ok(!raw.includes(scheme), `raw ${scheme} href removed`);
    assert.ok(raw.includes('click'), `raw ${scheme} label retained`);

    const md = formatWebSearchMarkdown(
      [
        makeResult({
          title: `Title [t](${scheme}evil) end`,
          description: `Dangerous [bad](${scheme}evil) link in body.`,
          generatedSummary: `Summary [s](${scheme}evil) text.`,
        }),
      ],
      { aiSummary: 'yes' },
    );
    assert.ok(!md.includes(scheme), `${scheme} never emitted in formatted output`);
    assert.ok(!md.includes(`](${scheme}`), `no active ${scheme} link target remains`);
    assert.match(md, /Dangerous bad link in body\. \[1-1\]/);
    assert.ok(md.includes('Title t end'), 'title label retained');
    assert.ok(md.includes('Summary s text'), 'summary label retained');
  }
});

test('prose paragraph gets one citation per paragraph, blank line between paragraphs', () => {
  const result = makeResult({
    description:
      'First paragraph sentence one. First paragraph sentence two.\n\nSecond paragraph sentence one. Second paragraph sentence two.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(
    md,
    /First paragraph sentence one\. First paragraph sentence two\. \[1-1\]\n\nSecond paragraph sentence one\. Second paragraph sentence two\. \[1-2\]/,
    'one citation per paragraph with a blank line between paragraphs',
  );
  assert.ok(
    !/First paragraph sentence one\. \[1-1\] Second paragraph sentence two\. \[1-2\]/.test(md),
    'no per-sentence citations inside a paragraph',
  );
});
test('multi-sentence ordered list item keeps one marker with one inline citation', () => {
  const result = makeResult({
    description: '1. First item sentence. Second item sentence.\n2. Third item sentence.',
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /1\. First item sentence\. Second item sentence\. \[1-1\]/);
  assert.match(md, /2\. Third item sentence\. \[1-2\]/);
  assert.ok(!/1\. First item sentence\. \[1-1\]\nSecond/.test(md), 'no bare continuation line');
  assert.ok(
    !/Second item sentence\. \[1-2\]/.test(md),
    'no per-sentence citation inside the list item',
  );
});

test('full mode renders the complete body with one citation for the whole paragraph', () => {
  const sentences = Array.from(
    { length: 12 },
    (_, i) => `Body sentence ${i + 1} with details.`,
  ).join(' ');
  const result = makeResult({ description: sentences, contentKind: 'snippet' });
  const detailed = formatWebSearchMarkdownDetailed([result], { full: true });
  for (let i = 1; i <= 12; i++) {
    assert.ok(
      detailed.text.includes(`Body sentence ${i} with details.`),
      `sentence ${i} present in full mode`,
    );
  }
  assert.match(detailed.text, /\[1-1\]/, 'whole paragraph carries one citation');
  assert.ok(
    !/Body sentence 1 with details\. \[1-1\] Body sentence 2 with details\. \[1-2\]/.test(
      detailed.text,
    ),
    'no per-sentence citations in full mode',
  );
  assert.ok(
    !detailed.text.includes(TRUNCATION_NOTE),
    'no truncation note when body fits the 1 MiB cap',
  );
  assert.ok(
    Buffer.byteLength(detailed.text, 'utf8') <= ARTIFACT_MAX_BYTES,
    'full output bounded by artifact cap',
  );
});

test('bounded preview is truncation-aware but full mode is not for the same input', () => {
  const sentences = Array.from(
    { length: 12 },
    (_, i) => `Body sentence ${i + 1} with details.`,
  ).join(' ');
  const result = makeResult({ description: sentences, contentKind: 'snippet' });
  const bounded = formatWebSearchMarkdownDetailed([result], {
    documentBudgetBytes: DEFAULT_DOCUMENT_BUDGET_BYTES,
  });
  assert.ok(bounded.truncated, 'snippet prose cap truncates the bounded preview');
  assert.ok(
    !bounded.text.includes('Body sentence 12 with details.'),
    'prose cap applies to bounded preview',
  );
  const full = formatWebSearchMarkdownDetailed([result], { full: true });
  assert.ok(!full.truncated, 'full mode not truncated');
});

test('isNavigationOnlySearchResult flags link-grid and footer-only bodies but keeps real prose and empty-body results', () => {
  const base = {
    url: 'https://example.com/page',
    domain: 'example.com',
    position: 1,
    source: 'brave' as const,
    age: null,
    extraSnippet: null,
    deepLinks: null,
  };
  // Pure navigation / link grid: nonempty body that cleans to nothing substantive.
  expectNav(base, 'Privacy Policy | Terms of Service', true);
  expectNav(
    base,
    '[Home](https://example.com/)\n[About](https://example.com/about)\n[Contact](https://example.com/contact)',
    true,
  );
  expectNav(base, '[Read methodology](https://example.com/methodology)', true);
  // A bare keyword is not enough to classify a page as navigation-only.
  expectNav(base, 'navigation', false);
  // Real prose must never be filtered.
  expectNav(base, 'The quick brown fox jumps over the lazy dog.', false);
  expectNav(base, 'Status: all systems operational.', false);
  expectNav(base, 'First sentence with meaning. Second sentence with meaning.', false);
  // Genuine empty-body / title-only results are preserved.
  expectNav(base, '', false);
});

function expectNav(
  base: {
    url: string;
    domain: string;
    position: number;
    source: 'brave';
    age: null;
    extraSnippet: null;
    deepLinks: null;
  },
  description: string,
  expected: boolean,
) {
  const result = { ...base, title: 'Example', description };
  assert.strictEqual(
    isNavigationOnlySearchResult(result),
    expected,
    `description: ${JSON.stringify(description)}`,
  );
}

test('isNavigationOnlySearchResult keeps a linked/hostile title-only result (no title fallback)', () => {
  const titleOnly = {
    url: 'https://x.test',
    domain: 'x.test',
    position: 1,
    source: 'brave' as const,
    age: null,
    extraSnippet: null,
    deepLinks: null,
    description: '',
    title: '[Official](https://x.test/docs)',
  };
  assert.strictEqual(
    isNavigationOnlySearchResult(titleOnly),
    false,
    'title-only result with a linked/hostile title must survive (classifier must not fall back to the title)',
  );
});

test('via lists every deduped discoverer, marking the content donor', () => {
  const result = makeResult({
    source: 'exa',
    engines: ['duckduckgo', 'searxng', 'exa'],
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /via: Exa \(content\), SearXNG, DuckDuckGo/);
});

test('via renders SearXNG upstream engines as bracketed metadata, never body/citations', () => {
  const result = makeResult({
    source: 'duckduckgo',
    engines: ['exa', 'duckduckgo', 'searxng'],
    upstreamEngines: ['bing', 'google', 'google', 'yahoo'],
  });
  const md = formatWebSearchMarkdown([result]);
  assert.match(md, /via: Exa, SearXNG \[bing, google, yahoo\], DuckDuckGo \(content\)/);
  assert.ok(!md.includes('bing. [1-'), 'upstream engines never rendered as cited prose');
});

test('quality surfaces the explainable low basis, or an honest generic label when absent', () => {
  const known = formatWebSearchMarkdown([
    makeResult({ sourceQuality: 'low', sourceBasis: 'video platform' }),
  ]);
  assert.match(known, /quality: low — video platform/);

  const generic = formatWebSearchMarkdown([makeResult({ sourceQuality: 'low' })]);
  assert.match(generic, /quality: low — generic domain prior/);
});

test('metadata order is deterministic regardless of engine input order', () => {
  const a = formatWebSearchMarkdown([
    makeResult({ source: 'exa', engines: ['searxng', 'brave', 'duckduckgo'] }),
  ]);
  const b = formatWebSearchMarkdown([
    makeResult({ source: 'exa', engines: ['duckduckgo', 'searxng', 'brave'] }),
  ]);
  const viaA = (a.match(/via: [^·]+/)?.[0] ?? '').trim();
  const viaB = (b.match(/via: [^·]+/)?.[0] ?? '').trim();
  assert.equal(viaA, viaB, 'engine order is canonical, not input order');
  assert.match(viaA, /^via: Brave, Exa \(content\), SearXNG, DuckDuckGo$/);
});

test('hostile upstreamEngines value cannot form an active markdown link', () => {
  const md = formatWebSearchMarkdown([
    makeResult({
      source: 'searxng',
      engines: ['searxng'],
      upstreamEngines: ['x](javascript:alert(1))'],
    }),
  ]);
  assert.ok(!/\]\(javascript:/i.test(md), 'no active javascript: link in output');
  assert.ok(md.includes('x'), 'readable label text preserved');
});

test('hostile unknown backend name cannot form an active markdown link', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ source: 'brave', engines: ['brave', 'weird](javascript:alert(1))'] }),
  ]);
  assert.ok(!/\]\(javascript:/i.test(md), 'no active javascript: link in output');
});

test('hostile sourceBasis value cannot form an active markdown link', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ sourceQuality: 'low', sourceBasis: 'x](javascript:alert(1))' }),
  ]);
  assert.ok(!/\]\(javascript:/i.test(md), 'no active javascript: link in output');
});

test('hostile date metadata value cannot form an active markdown link', () => {
  const md = formatWebSearchMarkdown([
    makeResult({ age: 'x](javascript:alert(1))', ageKind: 'fetched' }),
  ]);
  assert.ok(!/\]\(javascript:/i.test(md), 'no active javascript: link in output');
});

test('pipe-led line without a following separator remains prose, not an auto-table', () => {
  const blocks = splitIntoBlocks('| Pipe-led prose, not a table.\nThen prose with a | token.');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['prose'],
  );
});

test('valid table stops before a differently-shaped incidental-pipe prose line', () => {
  const md = formatWebSearchMarkdown([
    makeResult({
      description: '',
      extraSnippet:
        '| a | b |\n|---|---|\n| 1 | 2 |\nOdd sentence with one | pipe | and more words after it.',
    }),
  ]);
  assert.ok(md.includes('| a | b |\n|---|---|\n| 1 | 2 |'), 'table rows intact');
  assert.match(
    md,
    /\| 1 \| 2 \|\n\[1-1\]\n\nOdd sentence with one \| pipe \| and more words after it\. \[1-2\]/,
  );
});

test('splitIntoBlocks keeps a four-backtick fence containing an inner triple-tick fence atomic', () => {
  const md = '````js\n```\nconst x = 1;\n```\n````';
  const blocks = splitIntoBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['code'],
  );
  assert.equal(blocks[0]!.text, md);
});

test('splitIntoBlocks keeps a four-tilde fence containing an inner triple-tilde fence atomic', () => {
  const md = '~~~~js\n~~~\nconst x = 1;\n~~~\n~~~~';
  const blocks = splitIntoBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['code'],
  );
  assert.equal(blocks[0]!.text, md);
});

test('splitIntoBlocks accepts a closing fence longer than the opener', () => {
  const blocks = splitIntoBlocks('```js\nconst x = 1;\n`````');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['code'],
  );
  assert.equal(blocks[0]!.text, '```js\nconst x = 1;\n`````');
});

test('unterminated four-backtick fence auto-closes with matching opener length', () => {
  const blocks = splitIntoBlocks('````js\nconst value = 1;');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['code'],
  );
  assert.equal(blocks[0]!.text, '````js\nconst value = 1;\n````');
});
