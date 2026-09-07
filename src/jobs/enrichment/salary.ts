import type { SalaryInterval } from '../domain/posting.js';
import type { EnrichmentWarning, LocalePack } from './contracts.js';

export interface SalaryNormalizationResult {
  readonly stated: SalaryInterval[];
  readonly annualized: SalaryInterval[];
  readonly warnings: EnrichmentWarning[];
}

// ponytail: 38h/260d are documented AU-unspecific engineering constants
// used only when a pack opts in via salary-annualize-* rule.
const ANNUALIZE_MULTIPLIERS: Record<string, number> = {
  hour: 52 * 38,
  day: 260,
  week: 52,
};

export function normalizeSalary(
  salaries: readonly SalaryInterval[],
  localePack: LocalePack | undefined,
): SalaryNormalizationResult {
  const stated: SalaryInterval[] = [];
  const annualized: SalaryInterval[] = [];
  const warnings: EnrichmentWarning[] = [];

  // Check if a salary-annualize rule exists
  const annualizeRule = localePack?.normalizationRules.find((r) =>
    r.ruleId.startsWith('salary-annualize-'),
  );

  for (const s of salaries) {
    // Always clone stated with period: stated
    const statedClone: SalaryInterval = {
      min: s.min,
      max: s.max,
      currency: s.currency,
      unit: s.unit,
      period: 'stated',
      raw: s.raw,
    };
    stated.push(statedClone);

    // Annualize only if rule exists and unit is hour/day/week
    if (annualizeRule && s.unit in ANNUALIZE_MULTIPLIERS) {
      const k = ANNUALIZE_MULTIPLIERS[s.unit];
      if (k === undefined) continue;
      annualized.push({
        min: s.min !== undefined ? s.min * k : undefined,
        max: s.max !== undefined ? s.max * k : undefined,
        currency: s.currency,
        unit: 'year',
        period: 'annualized',
        raw: s.raw,
      });
    }
  }

  return { stated, annualized, warnings };
}
