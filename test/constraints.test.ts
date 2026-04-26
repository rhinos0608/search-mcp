import test from 'node:test';
import assert from 'node:assert/strict';
import type { HardConstraint, SoftConstraint, ConstraintConfig } from '../src/rag/constraints.js';
import {
  evaluateConstraints,
  applyConstraints,
  evaluateLocation,
  evaluateSalary,
  evaluateExperience,
  evaluateWorkMode,
  evaluateLanguage,
  evaluateDateRange,
  scoreCompanySize,
  scoreTechStack,
  scoreRecency,
} from '../src/rag/constraints.js';
import type { RetrievalResult } from '../src/rag/types.js';

// ── Type guards for casting in tests ────────────────────────────────────────

function hard(c: HardConstraint): HardConstraint {
  return c;
}

function soft(c: SoftConstraint): SoftConstraint {
  return c;
}

// ── evaluateLocation ──────────────────────────────────────────────────────

test('evaluateLocation exact match', () => {
  assert.ok(evaluateLocation('Sydney', hard({ type: 'location', values: ['Sydney'] })));
});

test('evaluateLocation region tolerance', () => {
  assert.ok(
    evaluateLocation(
      'Sydney, NSW',
      hard({ type: 'location', values: ['Sydney'], tolerance: 'region' }),
    ),
  );
});

test('evaluateLocation no match', () => {
  assert.ok(!evaluateLocation('Perth', hard({ type: 'location', values: ['Sydney'] })));
});

// ── evaluateSalary ────────────────────────────────────────────────────────

test('evaluateSalary passes when ranges overlap', () => {
  assert.ok(evaluateSalary({ min: 100000, max: 150000 }, hard({ type: 'salary', min: 80000 })));
});

test('evaluateSalary fails when no overlap', () => {
  assert.ok(!evaluateSalary({ min: 50000, max: 60000 }, hard({ type: 'salary', min: 80000 })));
});

// ── evaluateExperience ────────────────────────────────────────────────────

test('evaluateExperience passes when ranges overlap', () => {
  assert.ok(
    evaluateExperience({ min: 3, max: 5 }, hard({ type: 'experience', min: 2, unit: 'year' })),
  );
});

// ── evaluateWorkMode ──────────────────────────────────────────────────────

test('evaluateWorkMode passes for included value', () => {
  assert.ok(evaluateWorkMode('remote', hard({ type: 'workMode', values: ['remote', 'hybrid'] })));
});

// ── evaluateLanguage ──────────────────────────────────────────────────────

test('evaluateLanguage any match', () => {
  assert.ok(
    evaluateLanguage(['english', 'spanish'], hard({ type: 'language', values: ['English'] })),
  );
});

test('evaluateLanguage requireAll', () => {
  assert.ok(
    !evaluateLanguage(
      ['english'],
      hard({ type: 'language', values: ['English', 'German'], requireAll: true }),
    ),
  );
});

// ── evaluateDateRange ─────────────────────────────────────────────────────

test('evaluateDateRange passes for date within range', () => {
  const from = new Date('2024-01-01');
  const to = new Date('2024-12-31');
  const value = new Date('2024-06-01');
  assert.ok(evaluateDateRange(value, hard({ type: 'dateRange', from, to })));
});

test('evaluateDateRange fails for date outside range', () => {
  const from = new Date('2024-01-01');
  const to = new Date('2024-12-31');
  const value = new Date('2025-06-01');
  assert.ok(!evaluateDateRange(value, hard({ type: 'dateRange', from, to })));
});

// ── scoreCompanySize ───────────────────────────────────────────────────────

test('scoreCompanySize returns 1 for preferred match', () => {
  assert.equal(
    scoreCompanySize('large', soft({ type: 'companySize', preferred: ['large'], weight: 0.5 })),
    1,
  );
});

test('scoreCompanySize returns 0 for non-match', () => {
  assert.equal(
    scoreCompanySize('small', soft({ type: 'companySize', preferred: ['large'], weight: 0.5 })),
    0,
  );
});

// ── scoreTechStack ───────────────────────────────────────────────────────

test('scoreTechStack any match counts partial', () => {
  const score = scoreTechStack(
    ['python', 'react'],
    soft({ type: 'techStack', keywords: ['python', 'typescript'], weight: 0.5, match: 'any' }),
  );
  assert.equal(score, 0.5);
});

test('scoreTechStack all requires every keyword', () => {
  const score = scoreTechStack(
    ['python', 'react'],
    soft({ type: 'techStack', keywords: ['python', 'typescript'], weight: 0.5, match: 'all' }),
  );
  assert.equal(score, 0.5);
});

// ── scoreRecency ──────────────────────────────────────────────────────────

test('scoreRecency returns 1 for future date', () => {
  const future = new Date(Date.now() + 86400000); // tomorrow
  assert.equal(scoreRecency(future, soft({ type: 'recency', weight: 0.5, decay: 'linear' })), 1);
});

test('scoreRecency decays for old date', () => {
  const old = new Date(Date.now() - 100 * 86400000); // 100 days ago
  const score = scoreRecency(
    old,
    soft({ type: 'recency', weight: 0.5, decay: 'linear', halfLifeDays: 30 }),
  );
  assert.ok(score >= 0 && score <= 1);
});

// ── evaluateConstraints integration ─────────────────────────────────────────

interface TestItem {
  location: string;
  salary: { min: number; max: number; currency: string };
  experience: { min: number; max: number };
}

const extractors = {
  location: (item: TestItem) => item.location,
  salary: (item: TestItem) => item.salary,
  experience: (item: TestItem) => item.experience,
};

test('evaluateConstraints passes when all hard constraints match', () => {
  const item: TestItem = {
    location: 'Sydney',
    salary: { min: 100000, max: 150000, currency: 'AUD' },
    experience: { min: 3, max: 5 },
  };

  const config: ConstraintConfig = {
    hardConstraints: [
      { type: 'location', values: ['Sydney', 'Melbourne'] },
      { type: 'salary', min: 80000 },
    ],
    softConstraints: [],
    strictMode: false,
  };

  const result = evaluateConstraints(item, config, extractors);
  assert.equal(result.passedHard, true);
  assert.ok(result.matchedConstraints.includes('location'));
  assert.ok(result.matchedConstraints.includes('salary'));
});

test('evaluateConstraints fails hard constraints when location does not match', () => {
  const item: TestItem = {
    location: 'Perth',
    salary: { min: 100000, max: 150000, currency: 'AUD' },
    experience: { min: 3, max: 5 },
  };

  const config: ConstraintConfig = {
    hardConstraints: [{ type: 'location', values: ['Sydney', 'Melbourne'] }],
    softConstraints: [],
    strictMode: false,
  };

  const result = evaluateConstraints(item, config, extractors);
  assert.equal(result.passedHard, false);
  assert.ok(result.failedConstraints.includes('location'));
});

test('evaluateConstraints calculates soft constraint scores', () => {
  const item = {
    companySize: 'large',
    techStack: ['python', 'react', 'typescript'],
  };

  const itemExtractors = {
    companySize: (i: typeof item) => i.companySize,
    techStack: (i: typeof item) => i.techStack,
  };

  const config: ConstraintConfig = {
    hardConstraints: [],
    softConstraints: [
      { type: 'companySize', preferred: ['startup', 'large'], weight: 0.3 },
      { type: 'techStack', keywords: ['python', 'typescript'], weight: 0.7, match: 'any' },
    ],
    strictMode: false,
  };

  const result = evaluateConstraints(item, config, itemExtractors);
  assert.ok(result.softScore > 0);
  assert.ok(result.softScore <= 1);
});

test('evaluateConstraints handles unknown values in non-strict mode', () => {
  const item = { location: undefined as unknown as string };

  const itemExtractors = {
    location: (i: typeof item) => i.location,
  };

  const config: ConstraintConfig = {
    hardConstraints: [{ type: 'location', values: ['Sydney'] }],
    softConstraints: [],
    strictMode: false,
  };

  const result = evaluateConstraints(item, config, itemExtractors);
  assert.equal(result.passedHard, true); // Unknown doesn't fail in non-strict
});

test('evaluateConstraints fails unknown values in strict mode', () => {
  const item = { location: undefined as unknown as string };

  const itemExtractors = {
    location: (i: typeof item) => i.location,
  };

  const config: ConstraintConfig = {
    hardConstraints: [{ type: 'location', values: ['Sydney'] }],
    softConstraints: [],
    strictMode: true,
  };

  const result = evaluateConstraints(item, config, itemExtractors);
  assert.equal(result.passedHard, false);
});

// ── applyConstraints ──────────────────────────────────────────────────────

test('applyConstraints filters out items that fail hard constraints', () => {
  const results: RetrievalResult<TestItem>[] = [
    {
      item: {
        location: 'Sydney',
        salary: { min: 100000, max: 150000, currency: 'AUD' },
        experience: { min: 3, max: 5 },
      },
      score: { fused: 0.9 },
      rank: 1,
    },
    {
      item: {
        location: 'Perth',
        salary: { min: 80000, max: 120000, currency: 'AUD' },
        experience: { min: 2, max: 4 },
      },
      score: { fused: 0.85 },
      rank: 2,
    },
  ];

  const config: ConstraintConfig = {
    hardConstraints: [{ type: 'location', values: ['Sydney'] }],
    softConstraints: [],
    strictMode: false,
  };

  const ranked = applyConstraints(results, config, extractors);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.item.location, 'Sydney');
});

test('applyConstraints calculates final scores combining retrieval and constraint scores', () => {
  const item = {
    companySize: 'large',
    techStack: ['python', 'react', 'typescript'],
  };

  const results: RetrievalResult<typeof item>[] = [
    {
      item,
      score: { fused: 0.8 },
      rank: 1,
    },
  ];

  const itemExtractors = {
    companySize: (i: typeof item) => i.companySize,
    techStack: (i: typeof item) => i.techStack,
  };

  const config: ConstraintConfig = {
    hardConstraints: [],
    softConstraints: [
      { type: 'companySize', preferred: ['large'], weight: 0.3 },
      { type: 'techStack', keywords: ['python'], weight: 0.7, match: 'any' },
    ],
    strictMode: false,
  };

  const ranked = applyConstraints(results, config, itemExtractors);
  assert.ok(ranked[0]!.finalScore > 0.8); // Should be boosted by soft constraints
  assert.ok(ranked[0]!.finalScore <= 1.0);
});
