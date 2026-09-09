import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { extractSalaryFromText } from '../../src/jobs/extraction/normalize.js';
import { extractJsonLdJobPosting } from '../../src/jobs/extraction/structured.js';

describe('extraction currency honesty (generic core)', () => {
  test('explicit USD code preserved', () => {
    const result = extractSalaryFromText('USD 120,000 to USD 150,000 per year');
    assert.ok(result);
    assert.equal(result.currency, 'USD');
    assert.equal(result.min, 120000);
    assert.equal(result.max, 150000);
    assert.equal(result.unit, 'year');
  });

  test('explicit GBP code and £ symbol preserved', () => {
    const coded = extractSalaryFromText('GBP 50 to GBP 60 per hour');
    assert.ok(coded);
    assert.equal(coded.currency, 'GBP');
    const symbol = extractSalaryFromText('£50 to £60 per hour');
    assert.ok(symbol);
    assert.equal(symbol.currency, 'GBP');
  });

  test('explicit EUR code and € symbol preserved', () => {
    const coded = extractSalaryFromText('EUR 60 to EUR 70 per day');
    assert.ok(coded);
    assert.equal(coded.currency, 'EUR');
    const symbol = extractSalaryFromText('€60 to €70 per day');
    assert.ok(symbol);
    assert.equal(symbol.currency, 'EUR');
  });

  test('explicit AUD code preserved', () => {
    const result = extractSalaryFromText('AUD 90000 to AUD 110000 per year');
    assert.ok(result);
    assert.equal(result.currency, 'AUD');
  });

  test('bare $ is ambiguous: currency stays unresolved, amounts kept', () => {
    const result = extractSalaryFromText('$120,000 to $150,000 per year');
    assert.ok(result);
    assert.equal(result.currency, undefined);
    assert.equal(result.min, 120000);
    assert.equal(result.max, 150000);
    assert.equal(result.unit, 'year');
  });

  test('single bare-$ amount is ambiguous: currency stays unresolved', () => {
    const result = extractSalaryFromText('$85 per hour');
    assert.ok(result);
    assert.equal(result.currency, undefined);
    assert.equal(result.min, 85);
    assert.equal(result.max, 85);
  });

  test('no currency token: no salary fabricated', () => {
    assert.equal(extractSalaryFromText('120000 per year'), undefined);
    assert.equal(extractSalaryFromText('great role, apply now'), undefined);
  });

  test('reversed salary range omits min and max while preserving raw, unit, currency', () => {
    const result = extractSalaryFromText('AUD 150,000 to AUD 120,000 per year');
    assert.ok(result);
    assert.equal(result.raw, 'AUD 150,000 to AUD 120,000 per year');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.unit, 'year');
    assert.equal(result.min, undefined);
    assert.equal(result.max, undefined);
  });
});

describe('JSON-LD structured salary and URL parsing', () => {
  test('parses top-level QuantitativeValue range', () => {
    const result = extractJsonLdJobPosting(
      { baseSalary: { minValue: '80,000', maxValue: 120000, currency: 'AUD', unitText: 'YEAR' } },
      'obs-1',
    );
    assert.deepEqual(result.salary?.value, {
      min: 80000,
      max: 120000,
      currency: 'AUD',
      unit: 'year',
      period: 'stated',
      raw: 'AUD 80000-120000 per year',
    });
  });
  test('parses nested range and rejects malformed, reversed, nonfinite bounds', () => {
    const nested = extractJsonLdJobPosting(
      {
        baseSalary: {
          value: { minValue: 50000, maxValue: 70000, currency: 'USD', unitText: 'Year' },
        },
      },
      'obs-1',
    );
    const nestedValue = nested.salary?.value as Record<string, unknown> | undefined;
    assert.equal(nestedValue?.min, 50000);
    assert.equal(nestedValue?.max, 70000);
    for (const bounds of [
      { minValue: 90000, maxValue: 70000 },
      { minValue: Number.NaN, maxValue: 70000 },
      { minValue: 'not-a-number', maxValue: 70000 },
    ]) {
      const result = extractJsonLdJobPosting(
        { baseSalary: { ...bounds, currency: 'USD', unitText: 'year' } },
        'obs-1',
      );
      assert.equal(result.salary, undefined);
      assert.ok(result.warnings.includes('salary_parse_failed'));
    }
  });
  test('applyUrl accepts only HTTP and HTTPS', () => {
    assert.equal(
      extractJsonLdJobPosting({ url: 'https://example.com/apply' }, 'obs-1').fields.applyUrl?.value,
      'https://example.com/apply',
    );
    assert.equal(
      extractJsonLdJobPosting({ url: 'http://example.com/apply' }, 'obs-1').fields.applyUrl?.value,
      'http://example.com/apply',
    );
    assert.equal(
      extractJsonLdJobPosting({ url: 'javascript:alert(1)' }, 'obs-1').fields.applyUrl,
      undefined,
    );
    assert.equal(
      extractJsonLdJobPosting({ url: 'ftp://example.com/apply' }, 'obs-1').fields.applyUrl,
      undefined,
    );
  });
});
