import test from 'node:test';
import assert from 'node:assert/strict';
import type { z } from 'zod/v4';

/**
 * Tests for the research.auto routing rules.
 *
 * These tests verify deterministic routing logic only — they do NOT
 * call real network backends. They validate schema parsing, routing
 * rule selection, and family registration.
 */

// Helper to lazily import module symbols
async function getModule() {
  return import('../src/tools/families/research.js') as Promise<{
    autoAction: z.ZodObject<z.ZodRawShape>;
    autoRouteQuery: (
      query: string,
      limit: number,
    ) => {
      selected: {
        actionName: string;
        hint: string;
        invoke: (q: string, l: number) => Promise<unknown>;
      };
      candidates: {
        actionName: string;
        hint: string;
        invoke: (q: string, l: number) => Promise<unknown>;
      }[];
    };
    researchFamily: {
      name: string;
      actions: {
        name: string;
        description: string;
        handler: (...args: unknown[]) => unknown;
        schema: z.ZodType;
      }[];
    };
  }>;
}

// ── Schema validation tests ─────────────────────────────────────────────

void test('auto action schema accepts valid query', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'auto',
    query: 'machine learning transformers',
    limit: 15,
  });
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.data.action, 'auto');
    assert.equal(result.data.query, 'machine learning transformers');
    assert.equal(result.data.limit, 15);
  }
});

void test('auto action schema uses default limit', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'auto',
    query: 'climate change',
  });
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.data.limit, 20);
  }
});

void test('auto action schema rejects empty query', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'auto',
    query: '',
  });
  assert.ok(!result.success);
});

void test('auto action schema rejects limit > 50', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'auto',
    query: 'test',
    limit: 100,
  });
  assert.ok(!result.success);
});

void test('auto action schema rejects limit < 1', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'auto',
    query: 'test',
    limit: 0,
  });
  assert.ok(!result.success);
});

void test('auto action schema rejects non-auto action', async () => {
  const { autoAction } = await getModule();

  const result = autoAction.safeParse({
    action: 'hackernews',
    query: 'test',
  });
  assert.ok(!result.success);
});

// ── Routing rules — autoRouteQuery tests ────────────────────────────────

void test('DOI pattern routes to academic', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('10.1038/s41586-024-07123-5', 20);

  assert.equal(selected.actionName, 'academic');
  assert.ok(selected.hint.includes('DOI'));
});

void test('arXiv ID pattern routes to arxiv', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('2301.12345', 20);

  assert.equal(selected.actionName, 'arxiv');
  assert.ok(selected.hint.includes('arXiv'));
});

void test('arXiv: prefix routes to arxiv', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('arXiv:2301.12345', 20);

  assert.equal(selected.actionName, 'arxiv');
  assert.ok(selected.hint.includes('arXiv'));
});

void test('PubMed keyword routes to pubmed', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('pubmed cancer immunotherapy', 10);

  assert.equal(selected.actionName, 'pubmed');
  assert.ok(selected.hint.includes('PubMed'));
});

void test('PMC ID routes to pubmed', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('PMC1234567 clinical trial', 10);

  assert.equal(selected.actionName, 'pubmed');
  assert.ok(selected.hint.includes('PubMed'));
});

void test('biomedical keywords route to pubmed', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('randomized controlled trial hypertension', 10);

  assert.equal(selected.actionName, 'pubmed');
  assert.ok(selected.hint.includes('PubMed'));
});

void test('Hacker News keyword routes to hackernews', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('Show HN: my new project', 20);

  assert.equal(selected.actionName, 'hackernews');
  assert.ok(selected.hint.includes('Hacker News'));
});

void test('stack overflow keyword routes to stackoverflow', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('typescript error how to fix', 10);

  assert.equal(selected.actionName, 'stackoverflow');
  assert.ok(selected.hint.includes('Stack Overflow'));
});

void test('wikipedia keyword routes to wikipedia', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('what is quantum computing', 5);

  assert.equal(selected.actionName, 'wikipedia');
  assert.ok(selected.hint.includes('Wikipedia'));
});

void test('define keyword routes to wikipedia', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('define photosynthesis', 5);

  assert.equal(selected.actionName, 'wikipedia');
  assert.ok(selected.hint.includes('Wikipedia'));
});

void test('academic keywords route to academic', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('recent literature review on LLMs', 20);

  assert.equal(selected.actionName, 'academic');
});

void test('generic query falls back to academic', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected, candidates } = autoRouteQuery('some random query without hints', 20);

  assert.equal(selected.actionName, 'academic');
  assert.equal(candidates.length, 1);
  assert.ok(selected.hint.includes('No specific hint matched'));
});

void test('candidates include skipped actions when multiple rules match', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected, candidates } = autoRouteQuery('pubmed survey paper on machine learning', 20);

  assert.equal(selected.actionName, 'pubmed');
  const skipped = candidates
    .filter((c) => c.actionName !== selected.actionName)
    .map((c) => c.actionName);
  assert.ok(skipped.includes('academic'));
});

void test('candidates include academic as fallback when hint matches', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected, candidates } = autoRouteQuery('Show HN: my research paper on transformers', 20);

  assert.equal(selected.actionName, 'hackernews');
  const actions = candidates.map((c) => c.actionName);
  assert.ok(actions.includes('academic'));
});

void test('route returns selected and candidates with invoke functions', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected, candidates } = autoRouteQuery('machine learning', 20);

  assert.equal(typeof selected.invoke, 'function');
  for (const c of candidates) {
    assert.equal(typeof c.invoke, 'function');
  }
});

void test('arXiv ID takes priority over academic keywords', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('2306.12345 survey of transformers', 20);

  assert.equal(selected.actionName, 'arxiv');
});

void test('DOI takes priority over other hints', async () => {
  const { autoRouteQuery } = await getModule();
  const { selected } = autoRouteQuery('10.1038/s41586-024-07123-5 define mechanism', 10);

  assert.equal(selected.actionName, 'academic');
});

// ── Family registration tests ───────────────────────────────────────────

void test('auto action is registered in the research family actions list', async () => {
  const { researchFamily } = await getModule();

  const autoActionEntry = researchFamily.actions.find((a) => a.name === 'auto');
  assert.ok(autoActionEntry, 'auto action must be registered');
  assert.equal(autoActionEntry.name, 'auto');
  assert.equal(typeof autoActionEntry.handler, 'function');
  assert.ok(autoActionEntry.schema);
  assert.ok(autoActionEntry.description && autoActionEntry.description.length > 0);
});

void test('auto action description mentions routing', async () => {
  const { researchFamily } = await getModule();

  const autoActionEntry = researchFamily.actions.find((a) => a.name === 'auto');
  assert.ok(autoActionEntry);
  const desc: string = autoActionEntry.description;
  assert.ok(desc.toLowerCase().includes('auto') || desc.includes('route'));
});

void test('all existing research actions remain unchanged', async () => {
  const { researchFamily } = await getModule();

  const expectedActions = [
    'academic',
    'arxiv',
    'hackernews',
    'stackoverflow',
    'pubmed',
    'wikipedia',
    'openalex',
    'crossref',
    'datacite',
    'ror',
    'semantic_scholar',
    'gdelt',
    'wikidata',
    'v2ex',
    'auto',
  ];

  const registeredNames = researchFamily.actions.map((a) => a.name);
  assert.deepEqual(registeredNames.sort(), expectedActions.sort());
});
