import type { ConstraintEvaluation } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

// Hard constraints - items must match all
export type HardConstraint =
  | { type: 'location'; values: string[]; tolerance?: 'exact' | 'region' | 'country' }
  | { type: 'salary'; min?: number; max?: number; currency?: string }
  | { type: 'experience'; min?: number; max?: number; unit: 'month' | 'year' }
  | { type: 'workMode'; values: ('remote' | 'hybrid' | 'onsite')[] }
  | { type: 'language'; values: string[]; requireAll?: boolean }
  | { type: 'availability'; values: ('now' | 'week' | 'month')[] }
  | { type: 'dateRange'; from?: Date; to?: Date };

// Soft constraints - boost matching items
export type SoftConstraint =
  | { type: 'companySize'; preferred: string[]; weight: number }
  | { type: 'techStack'; keywords: string[]; weight: number; match: 'any' | 'all' }
  | { type: 'remoteFirst'; weight: number }
  | { type: 'sourceReliability'; preferred: ('high' | 'medium')[]; weight: number }
  | { type: 'recency'; weight: number; decay: 'linear' | 'exponential'; halfLifeDays?: number };

export interface ConstraintConfig {
  hardConstraints: HardConstraint[];
  softConstraints: SoftConstraint[];
  strictMode: boolean; // If true, unknown values fail hard constraints
}

export interface ConstraintExtractors<T> {
  location?: (item: T) => string | undefined;
  salary?: (item: T) => { min?: number; max?: number; currency?: string } | undefined;
  experience?: (item: T) => { min?: number; max?: number } | undefined;
  workMode?: (item: T) => string | undefined;
  language?: (item: T) => string[] | undefined;
  availability?: (item: T) => string | undefined;
  companySize?: (item: T) => string | undefined;
  techStack?: (item: T) => string[] | undefined;
  sourceReliability?: (item: T) => 'high' | 'medium' | 'low';
  postedDate?: (item: T) => Date | undefined;
}

export interface ConstraintRankedResult<T> {
  item: T;
  originalRank: number;
  constraintEvaluation: ConstraintEvaluation;
  finalScore: number; // Combined retrieval + constraint score
}

// ── Individual constraint evaluators ─────────────────────────────────────────

export function evaluateLocation(value: string | undefined, constraint: HardConstraint): boolean {
  if (constraint.type !== 'location') return false;
  if (value === undefined) return false;

  const val = value.toLowerCase().trim();
  const tolerance = constraint.tolerance ?? 'exact';

  for (const allowed of constraint.values) {
    const allowedLower = allowed.toLowerCase().trim();

    if (tolerance === 'exact') {
      if (val === allowedLower) return true;
    } else if (tolerance === 'region') {
      if (val.includes(allowedLower) || allowedLower.includes(val)) return true;
    } else {
      // country - very loose matching
      if (val.includes(allowedLower) || allowedLower.includes(val)) return true;
    }
  }

  return false;
}

export function evaluateSalary(
  value: { min?: number; max?: number } | undefined,
  constraint: HardConstraint,
): boolean {
  if (constraint.type !== 'salary') return false;
  if (value === undefined) return false;

  const { min, max } = constraint;

  if (min !== undefined && value.max !== undefined && value.max < min) {
    return false;
  }
  if (max !== undefined && value.min !== undefined && value.min > max) {
    return false;
  }

  return true;
}

export function evaluateExperience(
  value: { min?: number; max?: number } | undefined,
  constraint: HardConstraint,
): boolean {
  if (constraint.type !== 'experience') return false;
  if (value === undefined) return false;

  const { min, max } = constraint;

  if (min !== undefined && value.max !== undefined && value.max < min) {
    return false;
  }
  if (max !== undefined && value.min !== undefined && value.min > max) {
    return false;
  }

  return true;
}

export function evaluateWorkMode(value: string | undefined, constraint: HardConstraint): boolean {
  if (constraint.type !== 'workMode') return false;
  if (value === undefined) return false;
  return constraint.values.includes(value as 'remote' | 'hybrid' | 'onsite');
}

export function evaluateLanguage(value: string[] | undefined, constraint: HardConstraint): boolean {
  if (constraint.type !== 'language') return false;
  if (value === undefined || value.length === 0) return false;

  const requireAll = constraint.requireAll ?? false;
  const lowerValues = constraint.values.map((v) => v.toLowerCase());
  const lowerItem = value.map((v) => v.toLowerCase());

  if (requireAll) {
    return lowerValues.every((v) => lowerItem.includes(v));
  }
  return lowerValues.some((v) => lowerItem.includes(v));
}

export function evaluateAvailability(
  value: string | undefined,
  constraint: HardConstraint,
): boolean {
  if (constraint.type !== 'availability') return false;
  if (value === undefined) return false;
  return constraint.values.includes(value as 'now' | 'week' | 'month');
}

export function evaluateDateRange(value: Date | undefined, constraint: HardConstraint): boolean {
  if (constraint.type !== 'dateRange') return false;
  if (value === undefined) return false;

  if (constraint.from !== undefined && value < constraint.from) return false;
  if (constraint.to !== undefined && value > constraint.to) return false;

  return true;
}

// ── Soft constraint scorers ────────────────────────────────────────────────

export function scoreCompanySize(value: string | undefined, constraint: SoftConstraint): number {
  if (constraint.type !== 'companySize') return 0;
  if (value === undefined) return 0;

  const val = value.toLowerCase().trim();
  const isPreferred = constraint.preferred.some((p) => p.toLowerCase().trim() === val);
  return isPreferred ? 1.0 : 0.0;
}

export function scoreTechStack(value: string[] | undefined, constraint: SoftConstraint): number {
  if (constraint.type !== 'techStack') return 0;
  if (value === undefined || value.length === 0) return 0;

  const lowerItem = value.map((v) => v.toLowerCase());
  const lowerKeywords = constraint.keywords.map((k) => k.toLowerCase());

  let matches = 0;
  for (const kw of lowerKeywords) {
    if (lowerItem.some((v) => v.includes(kw) || kw.includes(v))) {
      matches += 1;
    }
  }

  if (constraint.match === 'all') {
    return matches === lowerKeywords.length ? 1.0 : matches / lowerKeywords.length;
  }
  return lowerKeywords.length > 0 ? matches / lowerKeywords.length : 0;
}

export function scoreRecency(date: Date | undefined, constraint: SoftConstraint): number {
  if (constraint.type !== 'recency') return 0;
  if (date === undefined) return 0;

  const now = new Date();
  const daysDiff = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

  if (daysDiff < 0) return 1.0; // Future dates get max score

  const halfLife = constraint.halfLifeDays ?? 30;

  if (constraint.decay === 'exponential') {
    return Math.exp(-(daysDiff / halfLife) * Math.LN2);
  }

  // Linear decay
  const maxDays = halfLife * 2;
  if (daysDiff >= maxDays) return 0;
  return 1 - daysDiff / maxDays;
}

// ── Main evaluation ──────────────────────────────────────────────────────────

export function evaluateConstraints<T>(
  item: T,
  config: ConstraintConfig,
  extractors: ConstraintExtractors<T>,
): ConstraintEvaluation {
  const matchedConstraints: string[] = [];
  const failedConstraints: string[] = [];
  const explanations: ConstraintEvaluation['explanations'] = [];
  let passedHard = true;

  for (const constraint of config.hardConstraints) {
    let matched = false;
    let actual: unknown = undefined;

    switch (constraint.type) {
      case 'location': {
        actual = extractors.location?.(item);
        matched = evaluateLocation(actual as string | undefined, constraint);
        break;
      }
      case 'salary': {
        actual = extractors.salary?.(item);
        matched = evaluateSalary(actual as { min?: number; max?: number } | undefined, constraint);
        break;
      }
      case 'experience': {
        actual = extractors.experience?.(item);
        matched = evaluateExperience(
          actual as { min?: number; max?: number } | undefined,
          constraint,
        );
        break;
      }
      case 'workMode': {
        actual = extractors.workMode?.(item);
        matched = evaluateWorkMode(actual as string | undefined, constraint);
        break;
      }
      case 'language': {
        actual = extractors.language?.(item);
        matched = evaluateLanguage(actual as string[] | undefined, constraint);
        break;
      }
      case 'availability': {
        // availability is scalar in extractor but array in constraint
        actual = extractors.availability?.(item);
        matched = evaluateAvailability(actual as string | undefined, constraint);
        break;
      }
      case 'dateRange': {
        actual = extractors.postedDate?.(item);
        matched = evaluateDateRange(actual as Date | undefined, constraint);
        break;
      }
      default:
        matched = false;
    }

    if (matched) {
      matchedConstraints.push(constraint.type);
    } else {
      failedConstraints.push(constraint.type);
      const isUnknown = actual === undefined;
      if (config.strictMode && isUnknown) {
        passedHard = false;
      }
      if (!isUnknown) {
        passedHard = false;
      }
    }

    explanations.push({
      constraint: constraint.type,
      expected: constraint,
      actual,
      matched,
    });
  }

  // Strict mode: if any unknown values exist, fail hard constraints
  if (config.strictMode) {
    const hasUnknown = explanations.some(
      (e) =>
        config.hardConstraints.some((c) => c.type === e.constraint) &&
        e.actual === undefined &&
        !e.matched,
    );
    if (hasUnknown) passedHard = false;
  }

  // Soft constraints
  let softScore = 0;
  let softWeightSum = 0;

  for (const constraint of config.softConstraints) {
    let score = 0;

    switch (constraint.type) {
      case 'companySize': {
        const val = extractors.companySize?.(item);
        score = scoreCompanySize(val, constraint);
        break;
      }
      case 'techStack': {
        const val = extractors.techStack?.(item);
        score = scoreTechStack(val, constraint);
        break;
      }
      case 'remoteFirst': {
        const val = extractors.workMode?.(item);
        score = val === 'remote' ? 1.0 : 0.0;
        break;
      }
      case 'sourceReliability': {
        const val = extractors.sourceReliability?.(item);
        score = val && (constraint.preferred as string[]).includes(val) ? 1.0 : 0.0;
        break;
      }
      case 'recency': {
        const val = extractors.postedDate?.(item);
        score = scoreRecency(val, constraint);
        break;
      }
    }

    softScore += score * constraint.weight;
    softWeightSum += constraint.weight;

    explanations.push({
      constraint: constraint.type,
      expected: constraint,
      actual:
        constraint.type === 'companySize'
          ? extractors.companySize?.(item)
          : constraint.type === 'techStack'
            ? extractors.techStack?.(item)
            : constraint.type === 'remoteFirst'
              ? extractors.workMode?.(item)
              : constraint.type === 'sourceReliability'
                ? extractors.sourceReliability?.(item)
                : extractors.postedDate?.(item),
      matched: score > 0.5,
    });
  }

  const normalizedSoftScore = softWeightSum > 0 ? softScore / softWeightSum : 0;

  return {
    passedHard,
    softScore: normalizedSoftScore,
    matchedConstraints,
    failedConstraints,
    explanations,
  };
}

// ── Apply constraints to ranked results ─────────────────────────────────────

import type { RetrievalResult } from './types.js';

export function applyConstraints<T>(
  results: RetrievalResult<T>[],
  config: ConstraintConfig,
  extractors: ConstraintExtractors<T>,
): ConstraintRankedResult<T>[] {
  const ranked: ConstraintRankedResult<T>[] = [];

  for (const result of results) {
    const evaluation = evaluateConstraints(result.item, config, extractors);

    // Skip items that fail hard constraints
    if (!evaluation.passedHard) {
      continue;
    }

    // Combine retrieval score with constraint score
    const retrievalScore = result.score.fused;
    const constraintBoost = evaluation.softScore * 0.2; // Soft constraints add up to 20%
    const finalScore = retrievalScore + constraintBoost;

    ranked.push({
      item: result.item,
      originalRank: result.rank,
      constraintEvaluation: evaluation,
      finalScore,
    });
  }

  // Sort by final score descending
  ranked.sort((a, b) => b.finalScore - a.finalScore);

  return ranked;
}
