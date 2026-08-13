import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlForDedup, mergeSearchResults } from '../src/utils/searchMerge.js';
import { getDomainAuthority, getSourceBasis, getSourceQuality } from '../src/utils/sourceTier.js';
import type { SearchResult } from '../src/types.js';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com',
    description: overrides.description ?? 'A test description.',
    position: overrides.position ?? 1,
    domain: overrides.domain ?? 'example.com',
    source: overrides.source ?? 'brave',
    age: overrides.age ?? null,
    extraSnippet: overrides.extraSnippet ?? null,
    deepLinks: overrides.deepLinks ?? null,
    ...(overrides.contentKind !== undefined ? { contentKind: overrides.contentKind } : {}),
    ...(overrides.generatedSummary !== undefined
      ? { generatedSummary: overrides.generatedSummary }
      : {}),
    ...(overrides.generatedSummaryProvider !== undefined
      ? { generatedSummaryProvider: overrides.generatedSummaryProvider }
      : {}),
    ...(overrides.ageKind !== undefined ? { ageKind: overrides.ageKind } : {}),
    ...(overrides.upstreamEngines !== undefined
      ? { upstreamEngines: overrides.upstreamEngines }
      : {}),
  };
}

test('normalizeUrlForDedup strips www and trailing slash', () => {
  assert.equal(normalizeUrlForDedup('https://www.example.com/path/'), 'https://example.com/path');
  assert.equal(normalizeUrlForDedup('https://example.com/page'), 'https://example.com/page');
});

test('normalizeUrlForDedup strips unequivocal tracking parameters but keeps functional query (including ambiguous src)', () => {
  assert.equal(
    normalizeUrlForDedup('https://example.com/page?utm_source=x&gclid=y&src=z&lang=en'),
    'https://example.com/page?src=z&lang=en',
    'src is ambiguous/potentially functional and is retained',
  );
  assert.notEqual(
    normalizeUrlForDedup('https://example.com/page?lang=en'),
    normalizeUrlForDedup('https://example.com/page?lang=fr'),
  );
});

test('normalizeUrlForDedup strips only unequivocal tracking params (_gl/dclid/msclkid/click IDs), keeps ambiguous ref/source/src/pos', () => {
  const clean = normalizeUrlForDedup(
    'https://example.com/page?source=news&src=app&_gl=1xyz&dclid=abc&ref=nav&keep=1',
  );
  assert.equal(
    clean,
    'https://example.com/page?source=news&src=app&ref=nav&keep=1',
    'only _gl/dclid stripped; ref/source/src (potentially functional) retained',
  );
  // A generic key like `ref`/`source` can carry real functional meaning
  // (e.g. distinct content per referral variant), so distinct values must
  // stay distinct — never collapsed to the bare URL.
  assert.notEqual(
    normalizeUrlForDedup('https://example.com/page?ref=version-1'),
    normalizeUrlForDedup('https://example.com/page?ref=version-2'),
  );
  assert.notEqual(
    normalizeUrlForDedup('https://example.com/page?source=news'),
    normalizeUrlForDedup('https://example.com/page'),
  );
});

test('normalizeUrlForDedup merges click-ID/utm aliases to the bare URL', () => {
  assert.equal(
    normalizeUrlForDedup('https://example.com/page?utm_source=x&gclid=y&fbclid=z&msclkid=w'),
    normalizeUrlForDedup('https://example.com/page'),
    'unequivocal tracking params collapse to the same identity',
  );
});

test('normalizeUrlForDedup strips default ports', () => {
  assert.equal(normalizeUrlForDedup('https://example.com:443/page/'), 'https://example.com/page');
  assert.equal(normalizeUrlForDedup('http://example.com:80/page/'), 'http://example.com/page');
});

test('normalizeUrlForDedup strips fragments', () => {
  assert.equal(
    normalizeUrlForDedup('https://example.com/page#section'),
    'https://example.com/page',
  );
});

test('mergeSearchResults deduplicates same URL from multiple backends', () => {
  const braveResults = [
    makeResult({ url: 'https://docs.example.com/guide', position: 2, source: 'brave' }),
  ];
  const searxngResults = [
    makeResult({ url: 'https://docs.example.com/guide', position: 5, source: 'searxng' }),
  ];

  const merged = mergeSearchResults(
    new Map([
      ['brave', braveResults],
      ['searxng', searxngResults],
    ]),
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.url, 'https://docs.example.com/guide');
  assert.ok(merged[0]?.engines.includes('brave'));
  assert.ok(merged[0]?.engines.includes('searxng'));
});

test('mergeSearchResults keeps unique results from each backend', () => {
  const braveResults = [makeResult({ url: 'https://a.com', position: 1, source: 'brave' })];
  const searxngResults = [makeResult({ url: 'https://b.com', position: 1, source: 'searxng' })];

  const merged = mergeSearchResults(
    new Map([
      ['brave', braveResults],
      ['searxng', searxngResults],
    ]),
  );

  assert.equal(merged.length, 2);
});

test('getDomainAuthority is suffix/subdomain-aware and tiered', () => {
  assert.equal(getDomainAuthority('ieee.org'), 0.9, 'ieee.org is high-authority');
  assert.equal(
    getDomainAuthority('spectrum.ieee.org'),
    0.9,
    'IEEE Spectrum inherits family authority',
  );
  assert.equal(getDomainAuthority('acm.org'), 0.9, 'ACM is high-authority');
  assert.equal(getDomainAuthority('docs.python.org'), 0.85, 'official docs are high-authority');
  assert.equal(getDomainAuthority('nist.gov'), 0.85, 'government is high-authority');
  assert.equal(
    getDomainAuthority('student.example.edu'),
    0.7,
    '.edu is moderate institutional, not maximal',
  );
  assert.equal(getDomainAuthority('ox.ac.uk'), 0.75, 'ac.uk research publisher');
  assert.equal(getDomainAuthority('blog.blogspot.com'), 0.2, 'user-gen platform is low');
  assert.equal(getDomainAuthority('youtube.com'), 0.3, 'YouTube is low');
  assert.equal(getDomainAuthority('mydomain.com'), 0.4, 'generic com default');
  // category=tweet exception keeps x.com/twitter.com credible for tweet searches.
  assert.equal(getDomainAuthority('x.com', 'tweet'), 0.95, 'tweet category exception');
  assert.equal(getSourceQuality('ieee.org'), 'high');
  assert.equal(getSourceQuality('blog.blogspot.com'), 'low');
  assert.equal(getSourceQuality('student.example.edu'), 'medium');
});

test('mergeSearchResults ranks authoritative technical source above keyword-dense self-promotional blog', () => {
  const authoritative = makeResult({
    url: 'https://spectrum.ieee.org/semiconductor-design',
    domain: 'spectrum.ieee.org',
    title: 'Semiconductor design',
    description: 'IEEE Spectrum on modern semiconductor design and fabrication techniques. '.repeat(
      3,
    ),
    position: 1,
    source: 'exa',
  });
  const selfPromo = makeResult({
    url: 'https://mytools.blogspot.com/semiconductor',
    domain: 'mytools.blogspot.com',
    title: 'Semiconductor design tools',
    description:
      'Semiconductor design tools semiconductor design blog semiconductor design tips. '.repeat(3),
    position: 1,
    source: 'brave',
  });

  const merged = mergeSearchResults(
    new Map([
      ['exa', [authoritative]],
      ['brave', [selfPromo]],
    ]),
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.domain, 'spectrum.ieee.org', 'authoritative source ranks first');
  assert.equal(merged[0]?.sourceQuality, 'high');
  assert.equal(merged[1]?.sourceQuality, 'low');
  assert.equal(merged[0]?.domainAuthorityScore, 0.9);
});

test('getSourceBasis is category-aware: tweet x.com is recognized social authority, generic x.com is social platform', () => {
  assert.equal(getSourceBasis('x.com', 'tweet'), 'recognized social authority');
  assert.equal(getSourceBasis('twitter.com', 'tweet'), 'recognized social authority');
  assert.equal(getSourceBasis('x.com'), 'social platform');
  assert.equal(getSourceBasis('reddit.com'), 'community platform');
  assert.equal(getSourceBasis('example.com'), null, 'generic TLD gets no invented basis');
});

test('mergeSearchResults annotates a category-aware sourceBasis beside score/quality', () => {
  const tweet = makeResult({
    url: 'https://x.com/user/status/1',
    domain: 'x.com',
    position: 1,
    source: 'exa',
  });
  const merged = mergeSearchResults(new Map([['exa', [tweet]]]), 10, { category: 'tweet' });
  assert.equal(merged[0]?.sourceBasis, 'recognized social authority');
  assert.equal(merged[0]?.sourceQuality, 'high', 'tweet-category x.com is credible');

  const generic = mergeSearchResults(
    new Map([
      [
        'exa',
        [makeResult({ url: 'https://x.com/page', domain: 'x.com', position: 1, source: 'exa' })],
      ],
    ]),
  );
  assert.equal(generic[0]?.sourceBasis, 'social platform');
  assert.equal(generic[0]?.sourceQuality, 'low', 'generic x.com is low-tier');
});

test('mergeSearchResults computes quality/score/basis for curated and gov.uk exact/www/subdomain hosts', () => {
  const cases = [
    {
      url: 'https://nature.com/article',
      domain: 'nature.com',
      score: 0.85,
      quality: 'high' as const,
      basis: 'scientific publisher',
    },
    {
      url: 'https://www.nature.com/www-article',
      domain: 'www.nature.com',
      score: 0.85,
      quality: 'high' as const,
      basis: 'scientific publisher',
    },
    {
      url: 'https://news.nature.com/feed',
      domain: 'news.nature.com',
      score: 0.85,
      quality: 'high' as const,
      basis: 'scientific publisher',
    },
    {
      url: 'https://gov.uk/guidance',
      domain: 'gov.uk',
      score: 0.85,
      quality: 'high' as const,
      basis: 'government domain',
    },
    {
      url: 'https://www.gov.uk/guidance-two',
      domain: 'www.gov.uk',
      score: 0.85,
      quality: 'high' as const,
      basis: 'government domain',
    },
    {
      url: 'https://hmrc.gov.uk/guidance',
      domain: 'hmrc.gov.uk',
      score: 0.85,
      quality: 'high' as const,
      basis: 'government domain',
    },
  ];
  const results = cases.map((c, i) =>
    makeResult({ url: c.url, domain: c.domain, position: i + 1, source: 'exa' }),
  );
  const merged = mergeSearchResults(new Map([['exa', results]]));
  assert.equal(merged.length, cases.length);
  for (const [i, c] of cases.entries()) {
    const m = merged[i]!;
    assert.equal(m.domainAuthorityScore, c.score, `${c.domain} domainAuthorityScore`);
    assert.equal(m.sourceQuality, c.quality, `${c.domain} sourceQuality`);
    assert.equal(m.sourceBasis, c.basis, `${c.domain} sourceBasis`);
  }
});

test('mergeSearchResults handles empty input', () => {
  const merged = mergeSearchResults(new Map());
  assert.deepEqual(merged, []);
});

test('mergeSearchResults never false-merges distinct URLs, even with identical same-host content (wrapper differences included)', () => {
  // Cross-URL content similarity is not a safe identity signal — collapsing
  // it merges genuinely distinct pages (e.g. /v1 vs /v2 release notes) that
  // happen to share body text. Identity is URL-only.
  const mdBody =
    '# Claude announcement\n\nAnthropic announced a new capability for Claude and described its deployment, safety evaluation, and availability. '.repeat(
      3,
    );
  const htmlBody =
    '<h1>Claude announcement</h1><p>Anthropic announced a new capability for Claude and described its deployment, safety evaluation, and availability.</p>'.repeat(
      3,
    );
  const merged = mergeSearchResults(
    new Map([
      [
        'exa',
        [
          makeResult({
            url: 'https://www.anthropic.com/news/announcement',
            title: 'Claude announcement',
            description: mdBody,
            source: 'exa',
          }),
        ],
      ],
      [
        'brave',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement-two',
            title: 'Claude announcement',
            description: htmlBody,
            source: 'brave',
          }),
        ],
      ],
    ]),
  );
  assert.equal(
    merged.length,
    2,
    'distinct URLs remain distinct even with matching same-host content',
  );
});

test('mergeSearchResults caps at limit', () => {
  const results: SearchResult[] = Array.from({ length: 20 }, (_, i) =>
    makeResult({ url: `https://result-${i}.com`, position: i + 1, source: 'exa' }),
  );

  const merged = mergeSearchResults(new Map([['exa', results]]), 5);

  assert.equal(merged.length, 5);
});

test('mergeSearchResults retains Exa generatedSummary/provider from same-URL duplicate when richer winner lacks summary', () => {
  const richerBrave = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'brave',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Brave that is the richest clean representation for this URL.',
  });
  const exaDupWithSummary = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'exa',
    position: 4,
    contentKind: 'snippet',
    description: 'short',
    generatedSummary: 'Exa generated summary of the shared page.',
    generatedSummaryProvider: 'exa',
  });

  const merged = mergeSearchResults(
    new Map([
      ['brave', [richerBrave]],
      ['exa', [exaDupWithSummary]],
    ]),
  );

  assert.equal(merged.length, 1, 'same normalized URL dedupes to one');
  const first = merged[0];
  assert.equal(first?.source, 'brave', 'richer Brave content wins as source');
  assert.equal(
    first?.generatedSummary,
    'Exa generated summary of the shared page.',
    'Exa summary retained on the richer winner that lacks one',
  );
  assert.equal(first?.generatedSummaryProvider, 'exa', 'provider stays paired with its summary');
  assert.ok(first?.engines?.includes('brave'), 'engines union keeps brave');
  assert.ok(first?.engines?.includes('exa'), 'engines union keeps exa');
});

test('mergeSearchResults unions upstreamEngines from a same-URL SearXNG duplicate when a richer donor wins', () => {
  const richerExa = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'exa',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Exa that is the richest clean representation for this URL.',
  });
  const searxngDup = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'searxng',
    position: 3,
    contentKind: 'snippet',
    description: 'short',
    upstreamEngines: ['google', 'bing', 'google'],
  });

  const merged = mergeSearchResults(
    new Map([
      ['exa', [richerExa]],
      ['searxng', [searxngDup]],
    ]),
  );

  assert.equal(merged.length, 1, 'same normalized URL dedupes to one');
  const first = merged[0];
  assert.equal(first?.source, 'exa', 'richer Exa content wins as source');
  assert.deepEqual(
    first?.upstreamEngines,
    ['bing', 'google'],
    'SearXNG upstream engines survive even when Exa donates the richer content',
  );
  assert.ok(first?.engines?.includes('searxng'), 'engines union keeps searxng discoverer');
  assert.ok(first?.engines?.includes('exa'), 'engines union keeps exa');
});

test('mergeSearchResults leaves upstreamEngines undefined when no SearXNG duplicate supplies any', () => {
  const richerExa = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'exa',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Exa that is the richest clean representation for this URL.',
  });
  const braveDup = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'brave',
    position: 3,
    contentKind: 'snippet',
    description: 'short',
  });
  const merged = mergeSearchResults(
    new Map([
      ['exa', [richerExa]],
      ['brave', [braveDup]],
    ]),
  );
  assert.equal(merged[0]?.upstreamEngines, undefined, 'no upstream engines to union');
});

test('mergeSearchResults does not overwrite a winner summary that already exists', () => {
  const richerBrave = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'brave',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Brave that is the richest clean representation for this URL.',
    generatedSummary: 'Brave own summary',
    generatedSummaryProvider: 'brave',
  });
  const exaDupWithSummary = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'exa',
    position: 4,
    contentKind: 'snippet',
    description: 'short',
    generatedSummary: 'Exa generated summary of the shared page.',
    generatedSummaryProvider: 'exa',
  });

  const merged = mergeSearchResults(
    new Map([
      ['brave', [richerBrave]],
      ['exa', [exaDupWithSummary]],
    ]),
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.source, 'brave');
  assert.equal(merged[0]?.generatedSummary, 'Brave own summary', 'winner summary not overwritten');
  assert.equal(merged[0]?.generatedSummaryProvider, 'brave', 'winner provider preserved');
});

test('mergeSearchResults keeps a ref-tagged URL distinct from its bare form (ref is not unequivocal tracking)', () => {
  const body =
    'Anthropic announced a new capability for Claude and described its deployment, safety evaluation, and availability. '.repeat(
      3,
    );
  const merged = mergeSearchResults(
    new Map([
      [
        'exa',
        [
          makeResult({
            url: 'https://www.anthropic.com/news/announcement',
            title: 'Claude announcement',
            description: body,
            source: 'exa',
          }),
        ],
      ],
      [
        'brave',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement?ref=search',
            title: 'Claude announcement',
            description: body,
            source: 'brave',
          }),
        ],
      ],
    ]),
  );
  assert.equal(
    merged.length,
    2,
    'ref query param is retained, so these are distinct normalized URLs',
  );
});

test('mergeSearchResults keeps functional-query variants with identical substantial content', () => {
  const body =
    'Claude announcement details its safety evaluation, availability, and deployment for customers. '.repeat(
      3,
    );
  const merged = mergeSearchResults(
    new Map([
      [
        'exa',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement?lang=en',
            title: 'Claude announcement',
            description: body,
            source: 'exa',
          }),
        ],
      ],
      [
        'brave',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement?lang=fr',
            title: 'Claude announcement',
            description: body,
            source: 'brave',
          }),
        ],
      ],
    ]),
  );
  assert.equal(merged.length, 2);
});

test('mergeSearchResults keeps distinct substantial articles with same title', () => {
  const body =
    'Claude announcement details its safety evaluation, availability, and deployment for customers. '.repeat(
      3,
    );
  const otherBody =
    'Claude announcement covers a separate research result, methodology, and benchmark measurements. '.repeat(
      3,
    );
  const merged = mergeSearchResults(
    new Map([
      [
        'exa',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement-one',
            title: 'Claude announcement',
            description: body,
            source: 'exa',
          }),
        ],
      ],
      [
        'brave',
        [
          makeResult({
            url: 'https://anthropic.com/news/announcement-two',
            title: 'Claude announcement',
            description: otherBody,
            source: 'brave',
          }),
        ],
      ],
    ]),
  );
  assert.equal(merged.length, 2);
});

test('mergeSearchResults preserves a published date from a duplicate when the richer winner lacks one', () => {
  const richerBrave = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'brave',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Brave that is the richest clean representation for this URL.',
  });
  const exaDupWithDate = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'exa',
    position: 4,
    contentKind: 'snippet',
    description: 'short',
    age: '3 days ago',
    ageKind: 'published',
  });

  const merged = mergeSearchResults(
    new Map([
      ['brave', [richerBrave]],
      ['exa', [exaDupWithDate]],
    ]),
  );

  assert.equal(merged.length, 1, 'same normalized URL dedupes to one');
  const first = merged[0];
  assert.equal(first?.source, 'brave', 'richer Brave content wins as source');
  assert.equal(first?.age, '3 days ago', 'published age preserved from the duplicate');
  assert.equal(first?.ageKind, 'published', 'published age kind preserved');
});

test('mergeSearchResults never lets a fetched/unknown age replace an existing published date on the winner', () => {
  const richerExa = makeResult({
    url: 'https://docs.example.com/guide',
    source: 'exa',
    position: 1,
    contentKind: 'full',
    description:
      'A long, rich full page body from Exa that is the richest clean representation for this URL.',
    age: '5 days ago',
    ageKind: 'published',
  });
  const braveDupFetched = makeResult({
    url: 'https://www.docs.example.com/guide/',
    source: 'brave',
    position: 3,
    contentKind: 'snippet',
    description: 'short',
    age: '2 days ago',
    ageKind: 'fetched',
  });

  const merged = mergeSearchResults(
    new Map([
      ['exa', [richerExa]],
      ['brave', [braveDupFetched]],
    ]),
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.age, '5 days ago', 'published date beats fetched on the winner');
  assert.equal(merged[0]?.ageKind, 'published');
});

test('mergeSearchResults: primary Codex tiebreaks only (near-)equal scores', () => {
  const codexResult = makeResult({
    url: 'https://codex.example/guide',
    domain: 'codex.example',
    position: 1,
    source: 'codex',
    description: 'Equal length content',
  });
  const exaResult = makeResult({
    url: 'https://exa.example/guide',
    domain: 'exa.example',
    position: 1,
    source: 'exa',
    description: 'Equal length content',
  });
  const merged = mergeSearchResults(
    new Map([
      ['codex', [codexResult]],
      ['exa', [exaResult]],
    ]),
    10,
    { primary: 'codex' },
  );
  assert.equal(merged[0]?.source, 'codex', 'Codex wins the equal-score tiebreak');
});

test('mergeSearchResults: low-score Codex never moves above a higher-score fallback', () => {
  const codexResult = makeResult({
    url: 'https://codex.example/guide',
    domain: 'codex.example',
    position: 1,
    source: 'codex',
    description: 'A fairly long snippet that is not materially thinner than the fallback at all',
  });
  const fallback = makeResult({
    url: 'https://github.com/guide',
    domain: 'github.com',
    position: 2,
    source: 'exa',
    description: 'short',
  });
  const merged = mergeSearchResults(
    new Map([
      ['codex', [codexResult]],
      ['exa', [fallback]],
    ]),
    10,
    { primary: 'codex' },
  );
  assert.equal(merged[0]?.source, 'exa', 'higher-score fallback ranks first despite Codex primary');
  assert.equal(merged[1]?.source, 'codex');
});

test('source calibration: gov.uk subdomains are high-authority public-sector', () => {
  for (const host of ['gov.uk', 'www.gov.uk', 'assets.publishing.service.gov.uk']) {
    assert.equal(getDomainAuthority(host), 0.85, `${host} is 0.85`);
    assert.equal(getSourceQuality(host), 'high', `${host} is high`);
    assert.equal(getSourceBasis(host), 'government domain', `${host} basis`);
  }
  assert.equal(getSourceQuality('lbl.gov'), 'high');
  assert.equal(getSourceBasis('lbl.gov'), 'government domain');
});

test('source calibration: curated official source registry scores and bases', () => {
  assert.equal(getDomainAuthority('nature.com'), 0.85);
  assert.equal(getDomainAuthority('news.nature.com'), 0.85, 'nature subdomain inherits');
  assert.equal(getSourceQuality('nature.com'), 'high');
  assert.equal(getSourceBasis('nature.com'), 'scientific publisher');
  assert.equal(getSourceBasis('news.nature.com'), 'scientific publisher');

  assert.equal(getDomainAuthority('iter.org'), 0.75);
  assert.equal(getSourceQuality('iter.org'), 'high');
  assert.equal(getSourceBasis('iter.org'), 'official intergovernmental project');

  assert.equal(getDomainAuthority('generalfusion.com'), 0.55);
  assert.equal(getSourceQuality('generalfusion.com'), 'medium');
  assert.equal(getSourceBasis('generalfusion.com'), 'official company source');

  assert.equal(getDomainAuthority('techcrunch.com'), 0.6);
  assert.equal(getSourceQuality('techcrunch.com'), 'medium');
  assert.equal(getSourceBasis('techcrunch.com'), 'established technology journalism');
});

test('source calibration: generic aggregators keep generic scores with no invented basis', () => {
  assert.equal(getDomainAuthority('fusionindustryassociation.org'), 0.45);
  assert.equal(getSourceBasis('fusionindustryassociation.org'), null);
  assert.equal(getDomainAuthority('earth911.com'), 0.4);
  assert.equal(getSourceBasis('earth911.com'), null);
  assert.equal(getDomainAuthority('ajupress.com'), 0.4);
  assert.equal(getSourceBasis('ajupress.com'), null);
  // Generic unknown domain stays default with null basis.
  assert.equal(getDomainAuthority('example.net'), 0.4);
  assert.equal(getSourceBasis('example.net'), null);
  // Low-tier platforms still score low and keep their known basis.
  assert.equal(getDomainAuthority('blog.blogspot.com'), 0.2);
  assert.equal(getSourceBasis('blog.blogspot.com'), 'hosted blog platform');
  assert.equal(getDomainAuthority('youtube.com'), 0.3);
  assert.equal(getSourceBasis('youtube.com'), 'video platform');
});

test('source calibration: official first-party vendor domains are high-authority (exact + www)', () => {
  const cases: {
    host: string;
    score: number;
    quality: 'high' | 'medium' | 'low';
    basis: string;
  }[] = [
    {
      host: 'developer.nvidia.com',
      score: 0.75,
      quality: 'high',
      basis: 'official company source',
    },
    {
      host: 'www.developer.nvidia.com',
      score: 0.75,
      quality: 'high',
      basis: 'official company source',
    },
    { host: 'nvidia.com', score: 0.75, quality: 'high', basis: 'official company source' },
    { host: 'www.nvidia.com', score: 0.75, quality: 'high', basis: 'official company source' },
    { host: 'openai.com', score: 0.75, quality: 'high', basis: 'official company source' },
    { host: 'www.openai.com', score: 0.75, quality: 'high', basis: 'official company source' },
  ];
  for (const c of cases) {
    assert.equal(getDomainAuthority(c.host), c.score, `${c.host} authority`);
    assert.equal(getSourceQuality(c.host), c.quality, `${c.host} quality`);
    assert.equal(getSourceBasis(c.host), c.basis, `${c.host} basis`);
  }
});

test('source calibration: community/forum/arbitrary subdomains of official vendors stay generic', () => {
  for (const host of [
    'community.openai.com',
    'forums.developer.nvidia.com',
    'forums.nvidia.com',
    'blog.openai.com',
    'random.openai.com',
  ]) {
    assert.equal(getDomainAuthority(host), 0.4, `${host} stays generic .com`);
    assert.equal(getSourceQuality(host), 'low', `${host} stays low`);
    assert.equal(getSourceBasis(host), null, `${host} has no invented basis`);
  }
});

test('mergeSearchResults annotates official vendor metadata through the real annotation path', () => {
  const vendor = makeResult({
    url: 'https://developer.nvidia.com/blog/announce',
    domain: 'developer.nvidia.com',
    position: 1,
    source: 'exa',
  });
  const merged = mergeSearchResults(new Map([['exa', [vendor]]]));
  assert.equal(merged[0]?.domainAuthorityScore, 0.75);
  assert.equal(merged[0]?.sourceQuality, 'high');
  assert.equal(merged[0]?.sourceBasis, 'official company source');
});

test('mergeSearchResults: authority breaks close/equal ties but materially stronger relevance still wins', () => {
  const official = makeResult({
    url: 'https://developer.nvidia.com/blog/announce',
    domain: 'developer.nvidia.com',
    position: 1,
    source: 'exa',
  });
  const generic = makeResult({
    url: 'https://randomblog.com/announce',
    domain: 'randomblog.com',
    position: 1,
    source: 'brave',
  });

  // Equal relevance (1 engine, position 1): official authority wins the tie.
  const tie = mergeSearchResults(
    new Map([
      ['exa', [official]],
      ['brave', [generic]],
    ]),
  );
  assert.equal(tie[0]?.domain, 'developer.nvidia.com', 'official vendor wins equal-relevance tie');
  assert.ok(
    (tie[0]?.domainAuthorityScore ?? 0) > (tie[1]?.domainAuthorityScore ?? 0),
    'official authority score higher than generic',
  );

  // Materially stronger relevance (3 engines vs 1) beats lower authority.
  const strong = mergeSearchResults(
    new Map([
      ['exa', [official]],
      ['brave', [generic]],
      ['searxng', [generic]],
      ['tavily', [generic]],
    ]),
  );
  assert.equal(strong[0]?.domain, 'randomblog.com', '3-engine result outranks official 1-engine');
});
