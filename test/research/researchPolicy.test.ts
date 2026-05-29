import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResearchPolicy,
  buildResearchPrompt,
} from '../../src/research/researchPolicy.js';
import type { RawResearchPolicy, NormalizedResearchPolicy } from '../../src/research/researchPolicy.js';

// ── normalizeResearchPolicy ───────────────────────────────────────────────────

test('normalizeResearchPolicy: returns safe defaults for undefined', () => {
  const result = normalizeResearchPolicy(undefined);
  assert.deepStrictEqual(result, {
    advanced: false,
    mode: 'general',
    includeDomains: [],
    excludeDomains: [],
    includeText: [],
    excludeText: [],
    preferredDomains: [],
    seedUrls: [],
    customInstruction: null,
    requestedMaxPages: null,
    requestedMaxHops: null,
  });
});

test('normalizeResearchPolicy: returns safe defaults for empty object', () => {
  const result = normalizeResearchPolicy({});
  assert.strictEqual(result.mode, 'general');
  assert.strictEqual(result.advanced, false);
  assert.strictEqual(result.requestedMaxPages, null);
  assert.strictEqual(result.requestedMaxHops, null);
});

test('normalizeResearchPolicy: mode normalization — all valid modes', () => {
  for (const mode of ['general', 'code', 'company', 'similar', 'deep'] as const) {
    assert.strictEqual(
      normalizeResearchPolicy({ mode } as RawResearchPolicy).mode,
      mode,
      `"${mode}" should be accepted from mode field`,
    );
    assert.strictEqual(
      normalizeResearchPolicy({ type: mode } as RawResearchPolicy).mode,
      mode,
      `"${mode}" should be accepted from type field`,
    );
  }
});

test('normalizeResearchPolicy: mode normalization — fallback to general for unknown', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ mode: 'unknown' } as RawResearchPolicy).mode,
    'general',
  );
  assert.strictEqual(
    normalizeResearchPolicy({ mode: 123 } as RawResearchPolicy).mode,
    'general',
  );
  assert.strictEqual(
    normalizeResearchPolicy({ mode: {} } as RawResearchPolicy).mode,
    'general',
  );
});

test('normalizeResearchPolicy: mode normalization — prefers mode over type', () => {
  const result = normalizeResearchPolicy({ mode: 'code', type: 'company' } as RawResearchPolicy);
  assert.strictEqual(result.mode, 'code');
});

test('normalizeResearchPolicy: list normalization — parses comma-separated string', () => {
  const result = normalizeResearchPolicy({
    includeDomains: 'github.com, gitlab.com',
  } as RawResearchPolicy);
  assert.deepStrictEqual(result.includeDomains, ['github.com', 'gitlab.com']);
});

test('normalizeResearchPolicy: list normalization — passes through arrays', () => {
  const result = normalizeResearchPolicy({
    includeDomains: ['foo.com', 'bar.com'],
  } as RawResearchPolicy);
  assert.deepStrictEqual(result.includeDomains, ['foo.com', 'bar.com']);
});

test('normalizeResearchPolicy: list normalization — trims whitespace', () => {
  const result = normalizeResearchPolicy({
    includeDomains: '  foo.com  ,  bar.com  ',
  } as RawResearchPolicy);
  assert.deepStrictEqual(result.includeDomains, ['foo.com', 'bar.com']);
});

test('normalizeResearchPolicy: list normalization — filters empty items', () => {
  const result = normalizeResearchPolicy({
    includeDomains: 'foo.com, , bar.com,',
  } as RawResearchPolicy);
  assert.deepStrictEqual(result.includeDomains, ['foo.com', 'bar.com']);
});

test('normalizeResearchPolicy: list normalization — returns empty for non-string/non-array', () => {
  const result = normalizeResearchPolicy({
    includeDomains: 42,
  } as RawResearchPolicy);
  assert.deepStrictEqual(result.includeDomains, []);
});

test('normalizeResearchPolicy: list normalization — all list fields', () => {
  const raw = {
    includeDomains: 'a,b,c',
    excludeDomains: 'd,e,f',
    includeText: 'g,h,i',
    excludeText: 'j,k,l',
    preferredDomains: 'm,n,o',
    seedUrls: 'https://x.com,https://y.com',
  } as RawResearchPolicy;
  const r = normalizeResearchPolicy(raw);
  assert.deepStrictEqual(r.includeDomains, ['a', 'b', 'c']);
  assert.deepStrictEqual(r.excludeDomains, ['d', 'e', 'f']);
  assert.deepStrictEqual(r.includeText, ['g', 'h', 'i']);
  assert.deepStrictEqual(r.excludeText, ['j', 'k', 'l']);
  assert.deepStrictEqual(r.preferredDomains, ['m', 'n', 'o']);
  assert.deepStrictEqual(r.seedUrls, ['https://x.com', 'https://y.com']);
});

test('normalizeResearchPolicy: numResults clamped 0–40', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: -5 } as RawResearchPolicy).requestedMaxPages,
    0,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: 0 } as RawResearchPolicy).requestedMaxPages,
    0,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: 20 } as RawResearchPolicy).requestedMaxPages,
    20,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: 40 } as RawResearchPolicy).requestedMaxPages,
    40,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: 100 } as RawResearchPolicy).requestedMaxPages,
    40,
  );
});

test('normalizeResearchPolicy: parses string numResults', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: '25' } as RawResearchPolicy).requestedMaxPages,
    25,
  );
});

test('normalizeResearchPolicy: maxHops clamped 0–8', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ maxHops: -2 } as RawResearchPolicy).requestedMaxHops,
    0,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ maxHops: 4 } as RawResearchPolicy).requestedMaxHops,
    4,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ maxHops: 20 } as RawResearchPolicy).requestedMaxHops,
    8,
  );
});

test('normalizeResearchPolicy: parses string maxHops', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ maxHops: '6' } as RawResearchPolicy).requestedMaxHops,
    6,
  );
});

test('normalizeResearchPolicy: unparseable numeric fields become null', () => {
  const r: RawResearchPolicy = { numResults: 'not-a-number', maxHops: 'also-not' };
  const result = normalizeResearchPolicy(r);
  assert.strictEqual(result.requestedMaxPages, null);
  assert.strictEqual(result.requestedMaxHops, null);
});

test('normalizeResearchPolicy: customInstruction from field', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ customInstruction: 'Focus on v3.' } as RawResearchPolicy).customInstruction,
    'Focus on v3.',
  );
});

test('normalizeResearchPolicy: falls back to instructions', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ instructions: 'Check the changelog.' } as RawResearchPolicy).customInstruction,
    'Check the changelog.',
  );
});

test('normalizeResearchPolicy: falls back to instruction', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ instruction: 'Check the blog.' } as RawResearchPolicy).customInstruction,
    'Check the blog.',
  );
});

test('normalizeResearchPolicy: custom instruction null when all empty', () => {
  assert.strictEqual(normalizeResearchPolicy({} as RawResearchPolicy).customInstruction, null);
});

test('normalizeResearchPolicy: trims custom instruction whitespace', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ customInstruction: '  Do this.  ' } as RawResearchPolicy).customInstruction,
    'Do this.',
  );
});

test('normalizeResearchPolicy: customInstruction preferred over instructions and instruction', () => {
  const result = normalizeResearchPolicy({
    customInstruction: 'custom',
    instructions: 'instructions',
    instruction: 'instruction',
  } as RawResearchPolicy);
  assert.strictEqual(result.customInstruction, 'custom');
});

test('normalizeResearchPolicy: advanced is false for defaults', () => {
  assert.strictEqual(normalizeResearchPolicy({}).advanced, false);
  assert.strictEqual(normalizeResearchPolicy(undefined).advanced, false);
});

test('normalizeResearchPolicy: advanced true when mode is non-general', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ mode: 'code' } as RawResearchPolicy).advanced,
    true,
  );
});

test('normalizeResearchPolicy: advanced true when any non-empty list is set', () => {
  for (const field of [
    'includeDomains',
    'excludeDomains',
    'includeText',
    'excludeText',
    'preferredDomains',
    'seedUrls',
  ] as const) {
    assert.strictEqual(
      normalizeResearchPolicy({ [field]: ['x.com'] } as RawResearchPolicy).advanced,
      true,
      `"${field}" should set advanced=true`,
    );
  }
});

test('normalizeResearchPolicy: advanced true when custom instruction is set', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ customInstruction: 'Be thorough.' } as RawResearchPolicy).advanced,
    true,
  );
});

test('normalizeResearchPolicy: advanced true when numeric fields are set', () => {
  assert.strictEqual(
    normalizeResearchPolicy({ numResults: 10 } as RawResearchPolicy).advanced,
    true,
  );
  assert.strictEqual(
    normalizeResearchPolicy({ maxHops: 3 } as RawResearchPolicy).advanced,
    true,
  );
});

// ── buildResearchPrompt ───────────────────────────────────────────────────────

const defaultPolicy: NormalizedResearchPolicy = {
  advanced: false,
  mode: 'general',
  includeDomains: [],
  excludeDomains: [],
  includeText: [],
  excludeText: [],
  preferredDomains: [],
  seedUrls: [],
  customInstruction: null,
  requestedMaxPages: null,
  requestedMaxHops: null,
};

test('buildResearchPrompt: includes the research question', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'What is AI?', 10, 3);
  assert.strictEqual(prompt.includes('What is AI?'), true);
});

test('buildResearchPrompt: includes today date', () => {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 10, 3);
  assert.strictEqual(prompt.includes(`Today: ${today}`), true);
});

test('buildResearchPrompt: includes page budget limit', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 25, 3);
  assert.strictEqual(prompt.includes('Page limit: 25 pages'), true);
});

test('buildResearchPrompt: includes hop limit', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 10, 5);
  assert.strictEqual(prompt.includes('Link-hop limit: 5 hops'), true);
});

test('buildResearchPrompt: uses SOURCES block format for general mode', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('SOURCES:'), true);
  assert.strictEqual(prompt.includes('[N]'), true);
  assert.strictEqual(prompt.includes('Structure your answer with clear headings'), false);
});

test('buildResearchPrompt: uses structured headings for deep mode', () => {
  const policy = { ...defaultPolicy, mode: 'deep' as const };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('Structure your answer with clear headings'), true);
  assert.strictEqual(prompt.includes('SOURCES:'), false);
});

test('buildResearchPrompt: includes allowed domains', () => {
  const policy = { ...defaultPolicy, includeDomains: ['github.com', 'arxiv.org'] };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('ALLOWED DOMAINS only'), true);
  assert.strictEqual(prompt.includes('github.com, arxiv.org'), true);
});

test('buildResearchPrompt: includes blocked domains', () => {
  const policy = { ...defaultPolicy, excludeDomains: ['spam.com'] };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('BLOCKED DOMAINS:'), true);
  assert.strictEqual(prompt.includes('spam.com'), true);
});

test('buildResearchPrompt: includes preferred domains', () => {
  const policy = { ...defaultPolicy, preferredDomains: ['docs.example.com'] };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('PREFERRED DOMAINS:'), true);
  assert.strictEqual(prompt.includes('docs.example.com'), true);
});

test('buildResearchPrompt: lists seed URLs', () => {
  const policy = {
    ...defaultPolicy,
    seedUrls: ['https://example.com/start', 'https://example.org/start'],
  };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('SEED URLS'), true);
  assert.strictEqual(prompt.includes('https://example.com/start'), true);
  assert.strictEqual(prompt.includes('https://example.org/start'), true);
});

test('buildResearchPrompt: includes custom instruction', () => {
  const policy = { ...defaultPolicy, customInstruction: 'Focus on security implications.' };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('CUSTOM INSTRUCTION:'), true);
  assert.strictEqual(prompt.includes('Focus on security implications.'), true);
});

test('buildResearchPrompt: code mode workflow', () => {
  const policy = { ...defaultPolicy, mode: 'code' as const };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('GitHub repositories'), true);
  assert.strictEqual(prompt.includes('Stack Overflow'), true);
  assert.strictEqual(prompt.includes('changelogs'), true);
});

test('buildResearchPrompt: company mode workflow', () => {
  const policy = { ...defaultPolicy, mode: 'company' as const };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('Crunchbase'), true);
  assert.strictEqual(prompt.includes('press releases'), true);
});

test('buildResearchPrompt: similar mode workflow', () => {
  const policy = { ...defaultPolicy, mode: 'similar' as const };
  const prompt = buildResearchPrompt(policy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('in-links'), true);
  assert.strictEqual(prompt.includes('similar-domain'), true);
});

test('buildResearchPrompt: general mode has 5-step workflow', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('Decompose the question'), true);
  assert.strictEqual(prompt.includes('Search across multiple source types'), true);
  assert.strictEqual(prompt.includes('Cross-reference important claims'), true);
  assert.strictEqual(prompt.includes('Synthesise findings'), true);
});

test('buildResearchPrompt: includes citation grounding rule', () => {
  const prompt = buildResearchPrompt(defaultPolicy, 'test', 10, 3);
  assert.strictEqual(prompt.includes('Cite only URLs you actually browsed'), true);
});