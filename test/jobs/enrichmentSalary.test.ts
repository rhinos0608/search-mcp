import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSalary } from '../../src/jobs/enrichment/salary.js';

test('stated salary preserves currency unit interval raw and period stated', () => {
  const result = normalizeSalary(
    [{ min: 30, max: 40, currency: 'AUD', unit: 'hour', period: 'stated', raw: '$30-40/hr' }],
    undefined,
  );
  assert.equal(result.stated.length, 1);
  const s = result.stated[0]!;
  assert.equal(s.currency, 'AUD');
  assert.equal(s.unit, 'hour');
  assert.equal(s.period, 'stated');
  assert.equal(s.raw, '$30-40/hr');
  assert.equal(result.annualized.length, 0);
});

test('month unit is preserved and does not match pack year convention', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [{ currency: 'AUD', period: 'year' as const }],
    classificationSchemes: [],
    eligibilityTerminology: {},
    sourceRegistryContributions: [],
    normalizationRules: [
      {
        ruleId: 'salary-annualize-hour',
        version: '1.0.0',
        deterministic: true as const,
        description: 'annualize hour',
      },
    ],
    evaluationFixtures: [],
  };
  const result = normalizeSalary(
    [{ min: 5000, max: 6000, currency: 'AUD', unit: 'month', period: 'stated', raw: '$5k-6k/mo' }],
    localePack as never,
  );
  const s = result.stated[0]!;
  assert.equal(s.unit, 'month');
  assert.equal(s.period, 'stated');
  assert.equal(result.annualized.length, 0);
});

test('missing min is not invented', () => {
  const result = normalizeSalary(
    [{ max: 50, currency: 'USD', unit: 'hour', period: 'stated', raw: 'up to $50/hr' }],
    undefined,
  );
  const s = result.stated[0]!;
  assert.equal(s.min, undefined);
  assert.equal(s.max, 50);
});

test('currency is never converted', () => {
  const result = normalizeSalary(
    [{ min: 30, currency: 'GBP', unit: 'hour', period: 'stated', raw: '£30/hr' }],
    undefined,
  );
  assert.equal(result.stated[0]!.currency, 'GBP');
});

test('annualize is omitted without salary-annualize pack rule', () => {
  const result = normalizeSalary(
    [{ min: 30, max: 40, currency: 'AUD', unit: 'hour', period: 'stated', raw: '$30-40/hr' }],
    undefined,
  );
  assert.equal(result.annualized.length, 0);
});

test('annualize with pack rule keeps stated and adds period annualized same currency raw', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: {},
    sourceRegistryContributions: [],
    normalizationRules: [
      {
        ruleId: 'salary-annualize-hour',
        version: '1.0.0',
        deterministic: true as const,
        description: 'annualize hour',
      },
    ],
    evaluationFixtures: [],
  };
  const result = normalizeSalary(
    [{ min: 30, max: 40, currency: 'AUD', unit: 'hour', period: 'stated', raw: '$30-40/hr' }],
    localePack as never,
  );
  assert.equal(result.stated.length, 1);
  assert.equal(result.stated[0]!.period, 'stated');
  assert.equal(result.annualized.length, 1);
  const a = result.annualized[0]!;
  assert.equal(a.period, 'annualized');
  assert.equal(a.unit, 'year');
  assert.equal(a.currency, 'AUD');
  assert.equal(a.raw, '$30-40/hr');
  assert.equal(a.min, 30 * 52 * 38);
  assert.equal(a.max, 40 * 52 * 38);
});

test('superannuation flag does not mutate amounts', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'MIT' },
    geography: [],
    salaryConventions: [{ currency: 'AUD', period: 'hour' as const, includesSuperannuation: true }],
    classificationSchemes: [],
    eligibilityTerminology: {},
    sourceRegistryContributions: [],
    normalizationRules: [],
    evaluationFixtures: [],
  };
  const result = normalizeSalary(
    [{ min: 30, max: 40, currency: 'AUD', unit: 'hour', period: 'stated', raw: '$30-40/hr' }],
    localePack as never,
  );
  assert.equal(result.stated[0]!.min, 30);
  assert.equal(result.stated[0]!.max, 40);
});

test('min greater than max is unnormalized warning', () => {
  const result = normalizeSalary(
    [{ min: 50, max: 30, currency: 'AUD', unit: 'hour', period: 'stated', raw: 'err' }],
    undefined,
  );
  assert.equal(result.stated[0]!.min, 50);
  assert.equal(result.stated[0]!.max, 30);
});
