import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

function repoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'src', 'jobs', 'reasoning', 'submit.ts'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
}

const ROOT = repoRoot(import.meta.dirname);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function readSrc(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

// ─── Test 34: domain/** import graph has zero reasoning + LLM imports ─

test('34. src/jobs/domain/** has zero jobs/reasoning and zero LLM client imports', () => {
  const domainDir = join(ROOT, 'src', 'jobs', 'domain');
  const files = walkDir(domainDir);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    assert.ok(
      !content.includes("from '../reasoning") && !content.includes("from './reasoning"),
      `${rel} imports reasoning module`,
    );
    assert.ok(
      !content.includes("from 'openai") &&
        !content.includes("from '@anthropic") &&
        !content.includes("from 'ollama") &&
        !content.includes('LLM_PROVIDER') &&
        !content.includes('LLM_BASE_URL') &&
        !content.includes('LLM_API_TOKEN'),
      `${rel} imports LLM client`,
    );
  }
});

// ─── Test 35: reasoning/** has zero persistence/tools/MCP/SQLite imports ─

test('35. src/jobs/reasoning/** has zero persistence, tools, MCP SDK, SQLite imports', () => {
  const reasoningDir = join(ROOT, 'src', 'jobs', 'reasoning');
  const files = walkDir(reasoningDir);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    assert.ok(
      !content.includes("from '../persistence") && !content.includes("from './persistence"),
      `${rel} imports persistence`,
    );
    assert.ok(
      !content.includes("from '../../tools") && !content.includes("from '../tools"),
      `${rel} imports tools`,
    );
    assert.ok(
      !content.includes("from '@modelcontextprotocol") && !content.includes("from 'mcp-sdk"),
      `${rel} imports MCP SDK`,
    );
    assert.ok(
      !content.includes("from 'better-sqlite3") && !content.includes("from 'sqlcipher"),
      `${rel} imports SQLite`,
    );
  }
});

// ─── Test 36: source text has zero createMessage / sampling ───────────

test('36. Source text has zero createMessage / sampling', () => {
  const reasoningDir = join(ROOT, 'src', 'jobs', 'reasoning');
  const files = walkDir(reasoningDir);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    assert.ok(!content.includes('createMessage'), `${rel} contains createMessage (MCP Sampling)`);
    assert.ok(!content.includes('sampling'), `${rel} contains sampling keyword`);
  }
});

// ─── Test 37: accept/runOptionalReasoning do not call fs / better-sqlite3 ─

test('37. acceptReasoningSubmission / runOptionalReasoning do not call fs / better-sqlite3', () => {
  const submitContent = readSrc('src/jobs/reasoning/submit.ts');
  const runContent = readSrc('src/jobs/reasoning/run.ts');

  for (const [name, content] of [
    ['submit.ts', submitContent],
    ['run.ts', runContent],
  ] as const) {
    assert.ok(
      !content.includes("from 'node:fs") &&
        !content.includes("require('fs") &&
        !content.includes("require('node:fs"),
      `${name} imports fs`,
    );
    assert.ok(!content.includes('better-sqlite3'), `${name} imports better-sqlite3`);
  }
});

// ─── Test 38: Fixture with raw résumé string in excerpt → RAW_PROFILE_EXPOSURE ─

test('38. Fixture with raw résumé string in excerpt → RAW_PROFILE_EXPOSURE', async () => {
  const { buildReasoningPacket, assertPacketRedacted } =
    await import('../../src/jobs/reasoning/packet.js');
  const { EvidenceIdSchema } = await import('../../src/jobs/reasoning/ids.js');

  const packet = buildReasoningPacket({
    runId: 'run-1',
    rankingRevision: 'rev-1',
    rankingVersion: 'ranking-v1',
    packVersions: ['pack-v1'],
    intent: {
      strictness: 'normal',
      unknownPolicy: 'include',
      topK: 10,
      budgets: {
        requests: 100,
        pages: 10,
        bytes: 1_000_000,
        milliseconds: 30_000,
        enrichment: 0,
        reasoning: 1,
      },
    },
    candidates: [
      {
        postingId: 'posting-001' as ReturnType<
          (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
        >,
        canonicalRevision: 1,
        identityDecisionRevision: 'id-rev-1',
        title: 'Engineer',
        organisation: 'Acme',
        normalizedTitle: 'engineer',
        workMode: 'remote',
        employmentType: 'full_time',
        expectedUtility: 0.8,
        evidenceCoverage: 0.7,
        confidence: 0.6,
        grouped: {
          relevance: 0.5,
          candidateFit: 0.5,
          preferenceFit: 0.5,
          marketState: 0.5,
          evidenceQuality: 0.5,
          personalAdaptation: 0.5,
        },
        flags: [],
        evidenceRefs: [EvidenceIdSchema.parse('ev-001')],
        rank: 1,
      },
    ],
    questions: [],
    excerpts: [],
    now: '2026-01-01T00:00:00Z',
  });

  assert.throws(
    () =>
      assertPacketRedacted({
        ...packet,
        evidenceExcerpts: [
          {
            evidenceId: EvidenceIdSchema.parse('ev-001'),
            kind: 'text_span',
            excerpt: 'Please see my resume for details about qualifications',
          },
        ],
      }),
    (e: Error) => e.message === 'RAW_PROFILE_EXPOSURE',
  );
});

// ─── Test 39: PII email in excerpt → RAW_PROFILE_EXPOSURE ────────────

test('39. PII email in excerpt → RAW_PROFILE_EXPOSURE', async () => {
  const { assertPacketRedacted, buildReasoningPacket } =
    await import('../../src/jobs/reasoning/packet.js');
  const { EvidenceIdSchema } = await import('../../src/jobs/reasoning/ids.js');

  const packet = buildReasoningPacket({
    runId: 'run-1',
    rankingRevision: 'rev-1',
    rankingVersion: 'ranking-v1',
    packVersions: ['pack-v1'],
    intent: {
      strictness: 'normal',
      unknownPolicy: 'include',
      topK: 10,
      budgets: {
        requests: 100,
        pages: 10,
        bytes: 1_000_000,
        milliseconds: 30_000,
        enrichment: 0,
        reasoning: 1,
      },
    },
    candidates: [
      {
        postingId: 'posting-001' as ReturnType<
          (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
        >,
        canonicalRevision: 1,
        identityDecisionRevision: 'id-rev-1',
        title: 'Engineer',
        organisation: 'Acme',
        normalizedTitle: 'engineer',
        workMode: 'remote',
        employmentType: 'full_time',
        expectedUtility: 0.8,
        evidenceCoverage: 0.7,
        confidence: 0.6,
        grouped: {
          relevance: 0.5,
          candidateFit: 0.5,
          preferenceFit: 0.5,
          marketState: 0.5,
          evidenceQuality: 0.5,
          personalAdaptation: 0.5,
        },
        flags: [],
        evidenceRefs: [EvidenceIdSchema.parse('ev-001')],
        rank: 1,
      },
    ],
    questions: [],
    excerpts: [],
    now: '2026-01-01T00:00:00Z',
  });

  assert.throws(
    () =>
      assertPacketRedacted({
        ...packet,
        evidenceExcerpts: [
          {
            evidenceId: EvidenceIdSchema.parse('ev-001'),
            kind: 'text_span',
            excerpt: 'Contact the recruiter at john.doe@example.com for more info',
          },
        ],
      }),
    (e: Error) => e.message === 'RAW_PROFILE_EXPOSURE',
  );
});

// ─── Test 40: Standalone path: ranked views in, packet out, no provider → skipped ─

test('40. Standalone path: ranked views in, packet out, no provider, result skipped', async () => {
  const { buildReasoningPacket } = await import('../../src/jobs/reasoning/packet.js');
  const { runOptionalReasoning } = await import('../../src/jobs/reasoning/run.js');
  const { createIdempotencyStore } = await import('../../src/jobs/reasoning/submit.js');
  const { EvidenceIdSchema } = await import('../../src/jobs/reasoning/ids.js');

  const packet = buildReasoningPacket({
    runId: 'run-1',
    rankingRevision: 'rev-1',
    rankingVersion: 'ranking-v1',
    packVersions: ['pack-v1'],
    intent: {
      strictness: 'normal',
      unknownPolicy: 'include',
      topK: 10,
      budgets: {
        requests: 100,
        pages: 10,
        bytes: 1_000_000,
        milliseconds: 30_000,
        enrichment: 0,
        reasoning: 1,
      },
    },
    candidates: [
      {
        postingId: 'posting-001' as ReturnType<
          (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
        >,
        canonicalRevision: 1,
        identityDecisionRevision: 'id-rev-1',
        title: 'Engineer',
        organisation: 'Acme',
        normalizedTitle: 'engineer',
        workMode: 'remote',
        employmentType: 'full_time',
        expectedUtility: 0.8,
        evidenceCoverage: 0.7,
        confidence: 0.6,
        grouped: {
          relevance: 0.5,
          candidateFit: 0.5,
          preferenceFit: 0.5,
          marketState: 0.5,
          evidenceQuality: 0.5,
          personalAdaptation: 0.5,
        },
        flags: [],
        evidenceRefs: [EvidenceIdSchema.parse('ev-001')],
        rank: 1,
      },
    ],
    questions: [],
    excerpts: [],
    now: '2026-01-01T00:00:00Z',
  });

  const store = createIdempotencyStore();
  const result = await runOptionalReasoning({
    packet,
    provider: undefined,
    reasoningBudget: 0,
    store,
    signal: undefined,
    now: '2026-01-01T00:00:00Z',
  });

  assert.equal(result.status, 'skipped');
  if (result.status === 'skipped') {
    assert.equal(result.fallback.answers.length, 0);
    assert.equal(result.fallback.annotations.length, 0);
    assert.equal(result.fallback.proposedClaims.length, 0);
  }
});
